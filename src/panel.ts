// Painel lateral: um card por provedor, com mascote animado. Overlay não-capturante: o editor mantém o foco.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { bar, resetShort } from "./format.ts";
import { outdated, type Snapshot } from "./models.ts";
import { health, mainWindow, pace } from "./rules.ts";
import { petFrames } from "./pets.ts";
import type { Monitor } from "./service.ts";

export const PANEL_WIDTH = 46;
/** Abaixo disso o painel some para não cobrir o chat. */
export const PANEL_MIN_TERMINAL = 110;
const PET_COLS = 12;
/** NOTUTIL_PET_FPS: 0 desliga; padrão 2; teto 10 (cada quadro redesenha o pi inteiro). */
export function frameMsFrom(raw: string | undefined): number {
  const fps = raw === undefined || raw.trim() === "" ? 2 : Number(raw);
  if (!Number.isFinite(fps)) return 500;
  if (fps <= 0) return 0;
  return 1000 / Math.min(fps, 10);
}
const FRAME_MS = frameMsFrom(process.env.NOTUTIL_PET_FPS);

const EMOTION_COLOR: Record<string, ThemeColor> = {
  comemorando: "success",
  concentrado: "accent",
  desesperado: "error",
  triste: "warning",
};

const usageColor = (used: number): ThemeColor => (used < 75 ? "accent" : used < 90 ? "warning" : "error");
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

function card(s: Snapshot, now: number, theme: Theme, width: number, frame: number): string[] {
  const { emotion, status } = health(s, now);
  const stale = outdated(s, now);
  const sprite = petFrames(s.pet, emotion)[frame % 6] ?? [];
  const right = width - PET_COLS - 1;
  const lines = [`${theme.bold(theme.fg("text", s.name))}  ${theme.fg(EMOTION_COLOR[emotion], theme.bold(status))}`];
  const main = mainWindow(s);
  if (main) {
    const reference = pace(main, now, stale);
    lines.push(`${theme.fg(usageColor(main.used), bar(main.used, reference, 16))} ${theme.bold(`${Math.round(main.used)}%`)}`);
    lines.push(theme.fg("muted", `${main.label} · renova ${resetShort(main, now)}`));
    for (const w of s.windows)
      if (w !== main) lines.push(theme.fg("dim", `${w.label} ${Math.round(w.used)}% · ${resetShort(w, now)}`));
  }
  if (s.error) lines.push(theme.fg("warning", s.error));
  else if (s.note) lines.push(theme.fg("dim", s.note));
  const height = Math.max(sprite.length, lines.length);
  return Array.from({ length: height }, (_, y) =>
    pad(sprite[y] ?? "", PET_COLS) + " " + truncateToWidth(lines[y] ?? "", right, "…", true));
}

/** Componente do overlay. Renderiza a partir do Monitor e se redesenha sozinho para animar. */
export class QuotaPanel implements Component {
  private readonly monitor: Monitor;
  private readonly theme: Theme;
  private readonly timer?: ReturnType<typeof setInterval>;

  constructor(monitor: Monitor, theme: Theme, tui: TUI) {
    this.monitor = monitor;
    this.theme = theme;
    if (FRAME_MS) this.timer = setInterval(() => tui.requestRender(), FRAME_MS);
  }

  render(width: number): string[] {
    const { theme } = this;
    const now = Date.now() / 1000;
    const frame = FRAME_MS ? Math.floor(Date.now() / FRAME_MS) : 0;
    const active = this.monitor.snapshots().filter((s) => !s.disabled);
    const lines = [pad(theme.fg("accent", theme.bold("QUOTAS")) + theme.fg("dim", ` · ${active.length} provedor(es)`), width)];
    if (!active.length) {
      lines.push(theme.fg("dim", "Nenhuma assinatura configurada. Veja o README."));
    }
    for (const s of active) {
      lines.push(theme.fg("dim", "─".repeat(width)));
      lines.push(...card(s, now, theme, width, frame));
    }
    return lines.map((line) => truncateToWidth(line, width, "…", true));
  }

  // Sem cache: o render lê o Monitor a cada quadro.
  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
