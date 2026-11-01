// Polling independente do painel. Falhas temporárias preservam a última leitura, marcada como antiga.
import { COLLECTORS, ReadError } from "./providers.ts";
import type { Snapshot } from "./models.ts";

const INTERVAL_MS = 120_000;
const COLLECT_TIMEOUT_MS = 25_000;
const PENDING = "Aguardando primeira leitura.";
const GENERIC = "Falha interna na leitura; última quota preservada.";
const NAMES: Record<string, string> = {
  antigravity: "Antigravity",
  opencode: "OpenCode Go",
  openai: "OpenAI Codex",
  claude: "Claude Code",
  commandcode: "CommandCode",
};

type Collector = () => Promise<Snapshot[]>;

export class Monitor {
  private readonly collectors: Record<string, Collector>;
  private readonly timeoutMs: number;
  private data = new Map<string, Snapshot[]>();
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(collectors: Record<string, Collector> = COLLECTORS, timeoutMs = COLLECT_TIMEOUT_MS) {
    this.collectors = collectors;
    this.timeoutMs = timeoutMs;
    for (const id of Object.keys(collectors))
      this.data.set(id, [{ id, name: NAMES[id] ?? id, windows: [], source: "", error: PENDING, disabled: true }]);
  }

  /** Dispara uma coleta em todos os provedores; se já houver uma em andamento, reaproveita. */
  refresh(): Promise<void> {
    this.inFlight ??= this.collectAll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshots(provider?: string): Snapshot[] {
    if (provider) return this.data.get(provider) ?? [];
    return [...this.data.values()].flat();
  }

  private async collectAll(): Promise<void> {
    await Promise.all(Object.entries(this.collectors).map(([id, collect]) => this.run(id, collect)));
  }

  /** Cada provedor é isolado: falha ou resposta inesperada de um não afeta os demais. */
  private async run(id: string, collect: Collector): Promise<void> {
    try {
      this.apply(id, await withTimeout(collect(), this.timeoutMs));
    } catch (reason) {
      this.fail(id, safeMessage(reason));
    }
  }

  private apply(provider: string, fresh: Snapshot[]): void {
    const current = this.data.get(provider) ?? [];
    if (fresh.length && fresh.every((s) => s.disabled)) {
      this.data.set(provider, fresh);
      return;
    }
    if (!fresh.some((s) => s.windows.length && !s.error)) {
      if (fresh.length && !current.some((s) => s.windows.length)) this.data.set(provider, fresh);
      else this.fail(provider, fresh[0]?.error ?? "Nenhuma leitura disponível.");
      return;
    }
    const previous = new Map(current.filter((s) => s.windows.length).map((s) => [s.id, s]));
    const merged: Snapshot[] = fresh.map((snapshot) => {
      const old = previous.get(snapshot.id);
      previous.delete(snapshot.id);
      return !snapshot.windows.length && old ? { ...old, stale: true, error: snapshot.error } : snapshot;
    });
    for (const old of previous.values())
      merged.push({ ...old, stale: true, error: "Conta ausente na leitura atual." });
    this.data.set(provider, merged);
  }

  private fail(provider: string, message: string): void {
    const current = this.data.get(provider) ?? [];
    this.data.set(
      provider,
      current.map((s) => ({ ...s, disabled: false, stale: s.windows.length > 0, error: message })),
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadError("Consulta excedeu o tempo limite.")), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Só a mensagem de ReadError chega à tela; qualquer outro erro vira texto genérico. */
function safeMessage(reason: unknown): string {
  return reason instanceof ReadError ? reason.message : GENERIC;
}
