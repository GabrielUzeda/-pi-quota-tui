// pi-quota-tui: cotas de assinatura de IA numa lista ANSI no widget do pi.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loginAgy } from "./agy-login.ts";
import { report, resolveSource, SOURCE_NAMES } from "./format.ts";
import { QuotaPanel } from "./panel.ts";
import type { Snapshot } from "./models.ts";
import { nowSec } from "./providers.ts";
import { Monitor } from "./service.ts";

const WIDGET = "pi-quota-tui-quotas";

export default function (pi: ExtensionAPI) {
  const monitor = new Monitor();
  let shown = false;

  // Widget abaixo do editor: reserva linhas no layout, em vez de cobrir o chat.
  const showPanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET, (_tui, theme) => new QuotaPanel(monitor, theme), { placement: "belowEditor" });
    shown = true;
  };

  // setWidget(undefined) desmonta o painel do dock.
  const hidePanel = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    shown = false;
  };

  const toggle = (ctx: ExtensionContext) => (shown ? hidePanel(ctx) : showPanel(ctx));

  const quotas = async (source: string) => {
    await monitor.refresh();
    const { provider } = resolveSource(source);
    const snapshots: Snapshot[] = provider ? monitor.snapshots(provider) : monitor.snapshots();
    return report(snapshots, nowSec());
  };

  pi.on("session_start", (_event, ctx) => {
    monitor.start();
    showPanel(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hidePanel(ctx);
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
  pi.registerCommand("quota-login", {
    description: "Importa as contas Antigravity do AGY ou faz o login Google",
    handler: async (_args, ctx) => {
      try {
        await loginAgy((message, level) => ctx.ui.notify(message, level ?? "info"));
        await monitor.refresh();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Falha no login do Antigravity.", "error");
      }
    },
  });

  pi.registerCommand("quotas", {
    description: "Mostra ou esconde o painel de cotas",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerTool({
    name: "get_quotas",
    label: "Get Quotas Summary",
    description: "Consulta o uso e cotas remanescentes de OpenCode Go, Antigravity, OpenAI Codex, Claude Code e CommandCode.",
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
