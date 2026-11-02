// Texto puro das cotas: relatório de /quota e tool get_quotas. Sem ANSI, para o LLM também ler.
import type { Snapshot } from "./models.ts";
import { outdated } from "./models.ts";
import { delta, forecast, health, pace, paceLabel, resetText, visible } from "./rules.ts";

/** Barra de uso com marca de ritmo (│) quando há referência. */
export function bar(used: number, reference: number | undefined, width: number): string {
  const filled = Math.round((used * width) / 100);
  const chars: string[] = Array.from({ length: width }, (_, i) => (i < filled ? "█" : "░"));
  if (reference !== undefined) {
    const mark = Math.min(width - 1, Math.max(0, Math.round((reference * (width - 1)) / 100)));
    chars[mark] = "│";
  }
  return chars.join("");
}

export function details(s: Snapshot, now: number): string[] {
  const stale = outdated(s, now);
  const windows = visible(s.windows);
  const lines = [s.name.toUpperCase(), health({ ...s, windows }, now)];
  if (s.updatedAt !== undefined) lines.push(`Leitura ${new Date(s.updatedAt * 1000).toLocaleTimeString("pt-BR")}`);
  if (s.error) lines.push(s.error);
  for (const w of windows) {
    lines.push(
      "",
      (w.group ? `${w.group} / ` : "") + w.label,
      `${Math.round(w.used)}% USADO  |  ${Math.round(100 - w.used)}% RESTANTE`,
      bar(w.used, pace(w, now, stale), 20),
      paceLabel(delta(w, now, stale)),
      resetText(w, now),
    );
    const estimate = forecast(w, now, stale);
    if (estimate) lines.push(estimate);
  }
  if (!windows.length) lines.push("Sem dados da assinatura.");
  if (s.note) lines.push("", s.note);
  lines.push(`Origem: ${s.source}`);
  return lines;
}

/** Provedores opcionais: sem o pré-requisito, somem em vez de aparecer como não configurado. */
const OPTIONAL = new Set(["openai"]);

/** Relatório completo; provedores sem configuração ficam listados como não configurados. */
export function report(snapshots: Snapshot[], now: number): string {
  const out = ["QUOTA WATCH // MONITOR DE IA", "Cota da assinatura; nao e contexto nem custo de sessao."];
  for (const s of snapshots.filter((x) => !x.disabled && visible(x.windows).length)) out.push("", ...details(s, now));
  const off = snapshots.filter((x) => x.disabled && !OPTIONAL.has(x.id)).map((x) => x.name);
  if (off.length) out.push("", `Nao configurado: ${off.join(", ")}.`);
  return out.join("\n");
}

/** Fontes aceitas por /quota e pela tool: nome -> provedor (undefined = todos). */
const SOURCES: Record<string, string | undefined> = { all: undefined, opencode: "opencode", agy: "antigravity", commandcode: "commandcode" };
export const SOURCE_NAMES = Object.keys(SOURCES);

/** Nome digitado (maiúsculas e espaços tolerados) para o provedor; nunca herda de Object.prototype. */
export function resolveSource(raw: string): { valid: boolean; provider?: string } {
  const key = raw.trim().toLowerCase() || "all";
  if (!Object.hasOwn(SOURCES, key)) return { valid: false };
  return { valid: true, provider: SOURCES[key] };
}
