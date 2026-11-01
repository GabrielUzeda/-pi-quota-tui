// Ritmo e saúde comparam uso com o tempo que falta até a renovação.
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

/** Rótulo de saúde da quota. */
export function health(s: Snapshot, now: number): string {
  if (!s.windows.length) return "SEM SINAL";
  if (outdated(s, now)) return "DESATUALIZADO";
  // Saldo disponível relativo à fração do ciclo que falta sustentar.
  const coverage = Math.min(...s.windows.map((w) => {
    const remaining = (100 - w.used) / 100;
    const elapsed = pace(w, now);
    // Sem ciclo conhecido, usa saldo absoluto: 60/50/37,5% como faixas.
    return remaining / (elapsed === undefined ? 0.5 : 1 - elapsed / 100);
  }));
  if (coverage <= 0.75) return "ATENCAO";
  if (coverage < 1) return "COTA APERTADA";
  if (coverage > 1.2) return "FOLGA";
  return "MONITORANDO";
}
