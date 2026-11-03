// Painel de cotas: lista ANSI pura, provedores lado a lado quando cabem. Sem imagens, sem animação.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getTerminalColorMode, mixColors, rgbColor, styleText, truncateToWidth, visibleWidth, type Color, type Component } from "@earendil-works/pi-tui";
import { bar } from "./format.ts";
import { outdated } from "./models.ts";
import type { Snapshot, Window } from "./models.ts";
import { expired, pace, visible } from "./rules.ts";
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

/** Rampa do tempo de espera: verde é logo ali, amarelo ainda demora, vermelho é o ciclo inteiro. */
const WAIT_GREEN = rgbColor(63, 185, 80);
const WAIT_YELLOW = rgbColor(210, 153, 34);
const WAIT_RED = rgbColor(248, 81, 73);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Cor contínua do tempo de espera, sem marcos fixos: quanto mais perto do ideal, mais perto do verde.
 * O ideal é relativo ao ciclo (18h numa semanal é logo ali; 12d numa mensal não), e sem ciclo
 * conhecido a régua cai para 1h..1d.
 */
export function waitColor(duration: number | undefined, left: number | undefined): Color | ThemeColor {
  if (left === undefined) return "dim";
  const bad = clamp01(duration ? (left / duration - 0.15) / 0.45 : (left - 3600) / (86400 - 3600));
  const eased = bad * bad * (3 - 2 * bad);
  return eased <= 0.5
    ? mixColors(WAIT_GREEN, WAIT_YELLOW, eased * 2, "srgb")
    : mixColors(WAIT_YELLOW, WAIT_RED, eased * 2 - 1, "srgb");
}

/**
 * Tudo que está esgotado numa linha só, no fim: quem volta antes aparece primeiro.
 * Provedor cujo único grupo esgotou não some da tela, só sai da lista de janelas.
 */
function expiredLine(snapshots: Snapshot[], now: number, width: number, theme: Theme): string[] {
  const items = snapshots.flatMap((s) =>
    expired(s.windows).map((e) => {
      const left = e.resetsAt === undefined ? undefined : e.resetsAt - now;
      const time = compactReset({ label: "", used: 100, resetsAt: e.resetsAt, estimated: e.estimated }, now);
      const color = waitColor(e.duration, left);
      const painted = typeof color === "string" ? theme.fg(color, time) : styleText(time, { fg: color }, getTerminalColorMode());
      return {
        at: e.resetsAt ?? Infinity,
        text: paintName(theme, s) + (e.group ? " " + e.group.split(/\s+/)[0] : "") + " " + painted,
      };
    }),
  );
  if (!items.length) return [];
  items.sort((a, b) => a.at - b.at);
  const tag = styleText("Expired:", { fg: rgbColor(255, 69, 58) }, getTerminalColorMode());
  return wrap(tag, items.map((i) => i.text), width);
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
    const snapshots = this.monitor.snapshots().filter((s) => !s.disabled && s.windows.length);
    const active = snapshots.filter((s) => visible(s.windows).length);

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
    lines.push(...expiredLine(snapshots, now, width, this.theme));
    if (!lines.length) return [truncateToWidth(this.theme.fg("dim", "Nenhuma cota disponível. Veja o README."), width, "…", true)];
    return lines;
  }

  invalidate(): void {}
}
