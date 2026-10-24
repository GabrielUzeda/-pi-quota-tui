// Ritmo portado de Models.cs/Theme.cs do QuotaDesk; saúde não é atividade.
import { outdated, type Snapshot, type Window } from "./models.ts";

export function pace(w: Window, now: number, stale = false): number | undefined {
  if (stale || w.resetsAt === undefined || w.duration === undefined) return undefined;
  const left = w.resetsAt - now;
  if (!(left > 0 && left <= w.duration)) return undefined;
  return (1 - left / w.duration) * 100;
}

export function delta(w: Window, now: number, stale = false): number | undefined {
  const reference = pace(w, now, stale);
  return reference === undefined ? undefined : w.used - reference;
}

export function paceLabel(value: number | undefined): string {
  if (value === undefined) return "RITMO INDISPONIVEL";
  if (value > 3) return `ADIANTADO ${Math.round(value)}%`;
  if (value < -3) return `FOLGA ${Math.round(-value)}%`;
  return "NO RITMO";
}

export function forecast(w: Window, now: number, stale = false): string {
  const reference = pace(w, now, stale);
  if (reference === undefined || w.duration === undefined || reference < 2 || w.used < 1) return "";
  if (w.used >= 100) return "COTA ESGOTADA; aguardando renovacao";
  const projected = (w.used * 100) / reference;
  if (projected > 100) {
    const elapsed = (w.duration * reference) / 100;
    const left = Math.max(0, elapsed * (100 / w.used - 1));
    return `~esgota em ${countdown(left)} antes de renovar`;
  }
  return `~sobram ${Math.max(0, 100 - projected).toFixed(0)}% na renovacao`;
}

export function countdown(seconds: number): string {
  const minutes = Math.max(1, Math.floor((seconds + 59) / 60));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`;
  return `${minutes}min`;
}

export function resetText(w: Window, now: number): string {
  if (w.resetsAt === undefined) return "RENOVA: horario indisponivel";
  if (w.resetsAt <= now) return "AGUARDANDO NOVA LEITURA";
  return "RENOVA EM " + (w.estimated ? "~" : "") + countdown(w.resetsAt - now);
}

export type Emotion = "comemorando" | "triste" | "desesperado" | "concentrado";

/** Emoção do pet e rótulo de saúde da quota. */
export function health(s: Snapshot, now: number): { emotion: Emotion; status: string } {
  if (!s.windows.length) return { emotion: "triste", status: "SEM SINAL" };
  if (outdated(s, now)) return { emotion: "triste", status: "DESATUALIZADO" };
  if (s.cooldownUntil !== undefined && s.cooldownUntil > now) return { emotion: "desesperado", status: "COOLDOWN" };
  const values = s.windows.map((w) => delta(w, now)).filter((v): v is number => v !== undefined);
  if (s.windows.some((w) => w.used >= 90) || values.some((v) => v > 10))
    return { emotion: "desesperado", status: "ATENCAO" };
  if (values.some((v) => v > 3)) return { emotion: "concentrado", status: "AJUSTANDO A ROTA" };
  if (values.length && values.every((v) => v < -3)) return { emotion: "comemorando", status: "FOLGA" };
  return { emotion: "concentrado", status: "MONITORANDO" };
}

/** Janela que bloqueia primeiro (menor folga); as demais vão para o rodapé. */
export function mainWindow(s: Snapshot): Window | undefined {
  let best: Window | undefined;
  for (const w of s.windows) if (!best || w.used > best.used) best = w;
  return best;
}
