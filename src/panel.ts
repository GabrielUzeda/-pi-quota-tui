// Painel de cotas: lista ANSI pura, provedores lado a lado quando cabem. Sem imagens, sem animação.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getTerminalColorMode, rgbColor, styleText, truncateToWidth, visibleWidth, type Color, type Component } from "@earendil-works/pi-tui";
import { bar } from "./format.ts";
import { outdated } from "./models.ts";
import type { Snapshot, Window } from "./models.ts";
import { pace, visible } from "./rules.ts";
import type { Monitor } from "./service.ts";

/** Largura da barra de saldo, separador entre janelas e recuo entre colunas de provedores. */
const BAR_WIDTH = 8;
const SEP = " │ ";
const GAP = "   ";
/** Abaixo disso um provedor não cabe legível; duas colunas só acima de 2 x isso. */
const MIN_COL = 30;

/** Cores de marca; branco usa a cor padrão do texto, que acompanha tema claro e escuro. */
const BRAND: Record<string, Color | "text"> = {
  antigravity: rgbColor(66, 133, 244),
  opencode: "text",
  commandcode: "text",
  openai: rgbColor(16, 163, 127),
  claude: rgbColor(217, 119, 87),
};

function paintName(theme: Theme, s: Snapshot): string {
  const brand = BRAND[s.id];
  if (brand === "text") return theme.bold(s.name);
  if (brand === undefined) return theme.fg("accent", theme.bold(s.name));
  return styleText(s.name, { fg: brand, bold: true }, getTerminalColorMode());
}

/**
 * Cor da barra: com ritmo conhecido, compara o uso com o que já deveria ter sido gasto
 * (verde com folga, amarelo adiantado, vermelho queimando rápido). Sem ritmo, usa o saldo.
 */
export function barColor(w: Window, reference: number | undefined): ThemeColor {
  if (reference === undefined) return w.used < 75 ? "accent" : w.used < 90 ? "warning" : "error";
  const over = w.used - reference;
  return over > 10 ? "error" : over > 3 ? "warning" : "success";
}

/** Tempo até renovar em uma única unidade, sem rótulos extras. */
export function compactReset(w: Window, now: number): string {
  if (w.resetsAt === undefined) return "--";
  const seconds = w.resetsAt - now;
  if (seconds <= 0) return "0m";
  const [value, unit] = seconds >= 86400 ? [seconds / 86400, "d"]
    : seconds >= 3600 ? [seconds / 3600, "h"] : [Math.max(1, seconds / 60), "m"];
  return (w.estimated ? "~" : "") + Number(value.toFixed(1)) + unit;
}

/**
 * Uma janela em texto: grupo e barra de saldo com marca de ritmo, mais o tempo de renovação.
 * Antigravity mistura famílias (Gemini/Claude/Argon): a primeira palavra do grupo identifica a janela.
 */
function windowItem(w: Window, now: number, stale: boolean, theme: Theme): string {
  const reference = pace(w, now, stale);
  const marker = bar(100 - w.used, reference === undefined ? undefined : 100 - reference, BAR_WIDTH);
  const tag = w.group ? w.group.split(/\s+/)[0] + " " : "";
  return tag + theme.fg(barColor(w, reference), marker) + " " + compactReset(w, now);
}

/** Junta as janelas em linhas, quebrando com recuo alinhado sob a primeira janela. */
function wrap(name: string, items: string[], width: number): string[] {
  const headWidth = visibleWidth(name) + 1;
  const indent = " ".repeat(Math.min(headWidth, Math.max(0, width - 1)));
  const lines: string[] = [];
  let line = name + " ";
  let lineWidth = Math.min(headWidth, width);
  let count = 0;

  for (const item of items) {
    const sep = count ? SEP : "";
    if (count && lineWidth + visibleWidth(sep) + visibleWidth(item) > width) {
      lines.push(truncateToWidth(line, width, "…", true));
      line = indent;
      lineWidth = visibleWidth(indent);
      count = 0;
    }
    const room = width - lineWidth - (count ? visibleWidth(SEP) : 0);
    if (room <= 0) break;
    const piece = visibleWidth(item) <= room ? item : truncateToWidth(item, room, "…", true);
    if (!visibleWidth(piece)) break;
    line += (count ? SEP : "") + piece;
    lineWidth += (count ? visibleWidth(SEP) : 0) + visibleWidth(piece);
    count++;
  }

  lines.push(truncateToWidth(line, width, "…", true));
  return lines;
}

/** Linhas de um provedor, já na largura da coluna. */
function providerLines(s: Snapshot, width: number, now: number, theme: Theme): string[] {
  const stale = outdated(s, now);
  // Sem corte por largura: quem some é só janela esgotada, e as abaixo dela (ver visible).
  const items = visible(s.windows).map((w) => windowItem(w, now, stale, theme));
  return wrap(paintName(theme, s), items, width);
}

/** Componente do widget: provedores no dock abaixo do editor, até dois por linha. */
export class QuotaPanel implements Component {
  private readonly monitor: Monitor;
  private readonly theme: Theme;

  constructor(monitor: Monitor, theme: Theme) {
    this.monitor = monitor;
    this.theme = theme;
  }

  render(width: number): string[] {
    const now = Date.now() / 1000;
    // Provedor sem nenhuma janela (proxy fora, Codex mudo, Claude sem histórico) não rende linha.
    const active = this.monitor.snapshots().filter((s) => !s.disabled && visible(s.windows).length);
    if (!active.length) return [truncateToWidth(this.theme.fg("dim", "Nenhuma cota disponível. Veja o README."), width, "…", true)];

    const cols = width >= 2 * MIN_COL + visibleWidth(GAP) ? 2 : 1;
    const colWidth = Math.floor((width - (cols - 1) * visibleWidth(GAP)) / cols);
    const lines: string[] = [];

    for (let i = 0; i < active.length; i += cols) {
      const blocks = active.slice(i, i + cols).map((s) => providerLines(s, colWidth, now, this.theme));
      const height = Math.max(...blocks.map((b) => b.length));
      for (let r = 0; r < height; r++) {
        const line = blocks.map((b) => b[r] ?? " ".repeat(colWidth)).join(GAP);
        lines.push(truncateToWidth(line, width, "…", true));
      }
    }
    return lines;
  }

  invalidate(): void {}
}
