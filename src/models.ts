// Dados normalizados: nunca guardam credenciais nem respostas brutas.

export interface Window {
  label: string;
  /** Percentual usado, 0..100. */
  used: number;
  resetsAt?: number;
  /** Segundos; só 18000 (5h) e 604800 (semanal) geram ritmo. */
  duration?: number;
  group?: string;
  estimated?: boolean;
}

export interface Snapshot {
  id: string;
  name: string;
  /** Nome do pet/provedor: antigravity, opencode, openai, claude, commandcode. */
  pet: string;
  windows: Window[];
  updatedAt?: number;
  source: string;
  error?: string;
  stale?: boolean;
  note?: string;
  cooldownUntil?: number;
  disabled?: boolean;
}

export function outdated(s: Snapshot, now: number): boolean {
  if (s.disabled) return false;
  return (
    !!s.stale ||
    !!s.error ||
    s.updatedAt === undefined ||
    s.updatedAt > now + 60 ||
    now - s.updatedAt > 120 ||
    s.windows.some((w) => w.resetsAt !== undefined && w.resetsAt <= now)
  );
}
