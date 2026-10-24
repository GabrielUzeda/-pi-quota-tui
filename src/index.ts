// notutil: cotas de assinatura de IA num painel lateral do pi, com mascotes.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type OverlayHandle } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { report, resolveSource, SOURCE_NAMES } from "./format.ts";
import { PANEL_MIN_TERMINAL, PANEL_WIDTH, QuotaPanel } from "./panel.ts";
import type { Snapshot } from "./models.ts";
import { nowSec } from "./providers.ts";
import { Monitor } from "./service.ts";

export default function (pi: ExtensionAPI) {
  const monitor = new Monitor();
  let handle: OverlayHandle | undefined;
  let close: (() => void) | undefined;

  const openPanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || close) return;
    void ctx.ui
      .custom<void>((tui, theme, _keys, done) => {
        close = () => done();
        return new QuotaPanel(monitor, theme, tui);
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: PANEL_WIDTH,
          margin: { right: 1 },
          nonCapturing: true,
          visible: (termWidth) => termWidth >= PANEL_MIN_TERMINAL,
        },
        onHandle: (h) => {
          handle = h;
        },
      })
      .finally(() => {
        close = undefined;
        handle = undefined;
      });
  };

  const toggle = (ctx: ExtensionContext) => {
    if (!handle) return openPanel(ctx);
    handle.setHidden(!handle.isHidden());
  };

  const quotas = async (source: string) => {
    await monitor.refresh();
    const { provider } = resolveSource(source);
    const snapshots: Snapshot[] = provider ? monitor.snapshots(provider) : monitor.snapshots();
    return report(snapshots, nowSec());
  };

  pi.on("session_start", (_event, ctx) => {
    monitor.start();
    openPanel(ctx);
  });

  pi.on("session_shutdown", () => {
    close?.();
    monitor.stop();
  });

  pi.registerEntryRenderer("quota-report", (entry: { data?: { content?: string } }) =>
    new Markdown(entry.data?.content ?? "Sem dados de quota.", 1, 1, getMarkdownTheme()));

  const reportCommand = async (args: string | undefined, ctx: ExtensionContext) => {
    const source = args?.trim() || "all";
    if (!resolveSource(source).valid) return ctx.ui.notify("Fontes: " + SOURCE_NAMES.join(", "), "error");
    ctx.ui.notify("Consultando quotas...", "info");
    // appendEntry mostra na TUI sem alimentar o contexto do LLM.
    pi.appendEntry("quota-report", { content: await quotas(source) });
  };

  pi.registerCommand("quota", {
    description: "Relatório das cotas [all|opencode|agy|commandcode]",
    handler: reportCommand,
  });
  pi.registerCommand("usage", {
    description: "Alias de /quota",
    handler: reportCommand,
  });
  pi.registerCommand("quotas", {
    description: "Mostra ou esconde o painel lateral de cotas",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerTool({
    name: "get_quotas",
    label: "Get Quotas Summary",
    description: "Consulta o uso e cotas remanescentes das contas OpenCode Zen Go, AGY e CommandCode.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.Union(
          [Type.Literal("all"), Type.Literal("opencode"), Type.Literal("agy"), Type.Literal("commandcode")],
          { description: "Fonte das cotas a consultar (all, opencode, agy, commandcode)" },
        ),
      ),
    }),
    async execute(_id, params) {
      const source = params.source ?? "all";
      if (!resolveSource(source).valid)
        return { content: [{ type: "text", text: "Fonte desconhecida: " + source + ". Use: " + SOURCE_NAMES.join(", ") + "." }], details: { source } };
      return { content: [{ type: "text", text: await quotas(source) }], details: { source } };
    },
  });
}
