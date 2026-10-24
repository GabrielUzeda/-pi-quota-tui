// Coletores das cotas. Só leitura: nenhuma credencial sai daqui e nenhum prompt é enviado.
// Tempos são segundos desde a época, como nas respostas das APIs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Snapshot, Window } from "./models.ts";
import { countdown } from "./rules.ts";

export type Json = Record<string, unknown>;

/** Mensagem segura para a UI: sem URL, headers ou corpo da resposta. */
export class ReadError extends Error {}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const nowSec = () => Date.now() / 1000;

/** Número dentro de um intervalo; percentual acima de 100 vira 100 em vez de sumir. */
export function clamped(value: unknown, low: number, high: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : undefined;
}

/** JSON com BOM (comum em arquivos gravados no Windows) também é aceito. */
export function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export function num(value: unknown, low = 0, high = 100): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) return undefined;
  return value;
}

export function epoch(value: unknown): number | undefined {
  const numeric = num(value, 1, 1e15);
  if (numeric !== undefined) {
    const seconds = numeric > 1e11 ? numeric / 1000 : numeric;
    return seconds < 253402300800 ? seconds : undefined;
  }
  if (typeof value === "string") {
    // Sem fuso explícito, tratamos como UTC (como o notutil original).
    const iso = /([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** Lê o corpo até o limite: resposta maior é cortada durante a leitura, não depois. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new ReadError("Resposta excede o limite de leitura.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GET/POST JSON com timeout; sem redirects, sem proxy de ambiente, HTTP só em loopback. */
export async function readJson(
  url: string,
  options: { headers?: Record<string, string>; body?: string; timeout: number },
): Promise<Json> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReadError("Endereço de quota não permitido.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new ReadError("Endereço de quota não permitido.");
  if (parsed.protocol === "http:" && parsed.hostname !== "127.0.0.1")
    throw new ReadError("HTTP sem TLS permitido apenas em loopback.");
  let text: string;
  try {
    const response = await fetch(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeout * 1000),
    });
    if (!response.ok) throw new ReadError(`Consulta recusada (HTTP ${response.status}).`);
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("Fonte indisponível ou tempo de consulta esgotado.");
  }
  let data: unknown;
  try {
    data = parseJson(text);
  } catch {
    throw new ReadError("Resposta de quota inválida.");
  }
  if (!isObject(data)) throw new ReadError("Formato de quota não reconhecido.");
  return data;
}

// --- credenciais: variável de ambiente primeiro, depois o auth.json do Pi (somente se privado) ---

// Resolvido a cada chamada: HOME pode mudar (testes, sessões diferentes).
const piAuth = () => join(homedir(), ".pi", "agent", "auth.json");

async function authFile(): Promise<Json> {
  try {
    const info = await stat(piAuth());
    if (info.mode & 0o077) return {};
    const data = parseJson(await readFile(piAuth(), "utf8"));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

async function authEntry(section: string): Promise<Json> {
  const item = (await authFile())[section];
  return isObject(item) ? item : {};
}

export async function secret(envNames: string[], section: string): Promise<string> {
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const key = (await authEntry(section)).key;
  return typeof key === "string" ? key.trim() : "";
}

function disabled(id: string, name: string, source: string, error: string): Snapshot {
  return { id, name, pet: id, windows: [], source, error, disabled: true };
}

// --- OpenCode Go: assinatura, não sessões nem saldo Zen ---

const OPENCODE_URL = "https://opencode.ai/zen/go/v1/usage";

export function parseOpencode(root: Json, now: number): Snapshot {
  const usage = "usage" in root ? root.usage : root;
  const windows: Window[] = [];
  if (isObject(usage)) {
    for (const [key, label, duration] of [
      ["rolling", "5 horas", 18000],
      ["weekly", "Semanal", 604800],
      ["monthly", "Mensal", undefined],
    ] as const) {
      const item = usage[key];
      if (!isObject(item)) continue;
      const used = clamped(item.percent, 0, 100);
      if (used !== undefined) windows.push({ label, used, resetsAt: epoch(item.resetsAt), duration });
    }
  }
  if (!windows.length) throw new ReadError("OpenCode não informou janelas de quota reconhecidas.");
  return { id: "opencode", name: "OpenCode Go", pet: "opencode", windows, updatedAt: now, source: "OpenCode Go / usage" };
}

async function collectOpencode(): Promise<Snapshot[]> {
  const key = await secret(["OPENCODE_GO_KEY"], "opencode-go");
  if (!key)
    return [disabled("opencode", "OpenCode Go", "OpenCode Go / usage", "Defina OPENCODE_GO_KEY para consultar a assinatura.")];
  const root = await readJson(OPENCODE_URL, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "opencode/1.18.30" },
    timeout: 10,
  });
  return [parseOpencode(root, nowSec())];
}

// --- CommandCode: saldo de créditos; a janela mensal é saldo + consumido ---

const CC_BASE = "https://api.commandcode.ai/alpha";

function commandcodeWindow(limits: Json, key: string, label: string, duration: number): Window | undefined {
  const item = limits[key];
  if (!isObject(item)) return undefined;
  const cap = num(item.cap, 0, 1e12);
  const used = num(item.used, 0, 1e12);
  if (!cap || used === undefined) return undefined;
  return { label, used: Math.min(100, (used / cap) * 100), resetsAt: epoch(item.resetAt), duration };
}

/** Próximo dia de virada (UTC), limitado a 28 para existir em todo mês. */
export function nextMonthlyReset(day: number, now: number): number {
  const moment = new Date(now * 1000);
  const clamped = Math.min(Math.max(day, 1), 28);
  let reset = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), clamped) / 1000;
  if (now >= reset) reset = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth() + 1, clamped) / 1000;
  return reset;
}

export function parseCommandcode(credits: Json, summary: Json | undefined, now: number, resetDay = 16): Snapshot {
  const wallet = credits.credits;
  if (!isObject(wallet)) throw new ReadError("CommandCode não informou créditos.");
  const monthly = num(wallet.monthlyCredits, 0, 1e12) ?? 0;
  const purchased = num(wallet.purchasedCredits, 0, 1e12) ?? 0;
  const free = num(wallet.freeCredits, 0, 1e12) ?? 0;
  const limits = isObject(credits.windowLimits) ? credits.windowLimits : undefined;
  const windows: Window[] = [];
  if (limits) {
    for (const [key, label, duration] of [["fiveHour", "5 horas", 18000], ["weekly", "Semanal", 604800]] as const) {
      const window = commandcodeWindow(limits, key, label, duration);
      if (window) windows.push(window);
    }
  }
  const used = summary ? num(summary.totalMonthlyCredits, 0, 1e12) : undefined;
  const cap = monthly + (used ?? 0);
  if (cap > 0)
    windows.push({ label: "Mensal", used: Math.min(100, ((cap - monthly) / cap) * 100), resetsAt: nextMonthlyReset(resetDay, now) });
  const balance = monthly + purchased + free;
  let note = `Saldo ${balance.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} créditos`;
  if (!windows.some((w) => w.label !== "Mensal")) note += " | sem janela de 5h/semanal nesta conta";
  return { id: "commandcode", name: "CommandCode", pet: "commandcode", windows, updatedAt: now, source: "CommandCode / billing", note };
}

async function collectCommandcode(): Promise<Snapshot[]> {
  const key = await secret(["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"], "commandcode");
  if (!key) return [disabled("commandcode", "CommandCode", "CommandCode / billing", "Defina COMMAND_CODE_API_KEY para consultar os créditos.")];
  const headers = { Accept: "application/json", "User-Agent": "notutil/0.1", Authorization: `Bearer ${key}` };
  const credits = await readJson(`${CC_BASE}/billing/credits`, { headers, timeout: 10 });
  const summary = await readJson(`${CC_BASE}/usage/summary`, { headers, timeout: 10 }).catch(() => undefined);
  const day = Number((await authEntry("commandcode")).resetDay ?? 16);
  return [parseCommandcode(credits, summary, nowSec(), Number.isFinite(day) ? day : 16)];
}

// --- AGY: proxy local agy-local-proxy (contas, grupos e cooldowns) ---

const AGY_URL = "http://127.0.0.1:20128/v1/accounts/status";

const identityKey = (account: Json, index: number): string => {
  const identity = account.email || account.projectId;
  return identity ? createHash("sha256").update(String(identity)).digest("hex").slice(0, 10) : String(index + 1);
};

export function parseGroups(groups: unknown): Window[] {
  if (!Array.isArray(groups)) return [];
  const windows: Window[] = [];
  for (const group of groups) {
    if (!isObject(group) || typeof group.displayName !== "string" || !Array.isArray(group.buckets)) continue;
    const name = group.displayName.trim().replace(/\s+models$/i, "").replace(/\band\b/g, "e");
    for (const bucket of group.buckets) {
      if (!isObject(bucket) || bucket.disabled === true) continue;
      const fraction = clamped(bucket.remainingFraction, 0, 1);
      if (fraction === undefined) continue;
      const [label, duration]: [string, number | undefined] =
        bucket.window === "5h" ? ["5 horas", 18000] : bucket.window === "weekly" ? ["Semanal", 604800] : ["Limite", undefined];
      windows.push({ label, used: (1 - fraction) * 100, resetsAt: epoch(bucket.resetTime), duration, group: name });
    }
  }
  return windows;
}

function validAccounts(root: Json): Json[] {
  return Array.isArray(root.accounts) ? root.accounts.filter(isObject) : [];
}

export function parseProxy(root: Json, now: number): Snapshot[] {
  const accounts = validAccounts(root);
  if (root.offline || !accounts.length)
    throw new ReadError("Proxy AGY sem contas disponíveis.");
  const age = num(root.quotaAgeMs, 0, 1e12);
  const ttl = num(root.quotaTtlMs, 1, 1e12);
  // Sem idade conhecida, a quota não é tratada como recém-lida.
  const updated = age === undefined ? undefined : now - age / 1000;
  const result: Snapshot[] = [];
  accounts.forEach((account, index) => {
    const quota = account.quota;
    const windows = isObject(quota) && !quota.error ? parseGroups(quota.groups) : [];
    const cooldown = num(account.coolingDownSec, 0, 1e9);
    const key = identityKey(account, index);
    const cooling = isObject(account.modelCooldowns)
      ? Object.values(account.modelCooldowns).filter((v) => num(v, 0, 1e9) !== undefined && v !== 0).length
      : 0;
    let note = "Contas separadas; percentuais não são somados nem promediados.";
    if (cooling) note += ` COOLDOWN em ${cooling} modelo(s); não significa bloqueio global.`;
    result.push({
      id: `antigravity/${key}`,
      name: `Antigravity / conta ${key.slice(0, 6)}`,
      pet: "antigravity",
      windows,
      updatedAt: updated,
      source: "AGY / servidor local",
      error: windows.length ? undefined : "Conta sem leitura de quota reconhecida.",
      stale: age === undefined || (ttl !== undefined && age > ttl),
      note,
      cooldownUntil: cooldown ? now + cooldown : undefined,
    });
  });
  if (!result.length) throw new ReadError("Proxy AGY sem contas reconhecidas.");
  return result;
}

/** Conta paga: a apontada por NOTUTIL_AGY_PAID (id, email ou projeto) ou a mais completa. */
export function paidIndex(root: Json, hint = ""): number {
  // Mesma filtragem de parseProxy: contas inválidas não entram nos índices.
  const accounts = validAccounts(root);
  if (!accounts.length) return 0;
  const wanted = hint.trim();
  if (wanted) {
    const found = accounts.findIndex(
      (a, i) => isObject(a) && (wanted === (a.email || a.projectId) || identityKey(a, i).startsWith(wanted)),
    );
    if (found >= 0) return found;
  }
  const rank = (account: unknown): [number, number] => {
    if (!isObject(account)) return [0, 0];
    const claude = Array.isArray(account.claudeIds) ? account.claudeIds.length : 0;
    const groups = isObject(account.quota) && Array.isArray(account.quota.groups) ? account.quota.groups : [];
    const buckets = groups.reduce((sum: number, g: unknown) => sum + (isObject(g) && Array.isArray(g.buckets) ? g.buckets.length : 0), 0);
    return [claude, buckets];
  };
  let best = 0;
  let bestRank: [number, number] = [-1, -1];
  accounts.forEach((account, index) => {
    const current = rank(account);
    if (current[0] > bestRank[0] || (current[0] === bestRank[0] && current[1] > bestRank[1])) {
      best = index;
      bestRank = current;
    }
  });
  return best;
}

/** Uma cota principal (a paga); as demais viram BONUS. Nada é somado nem promediado. */
export function collapse(snapshots: Snapshot[], primary: number, now: number): Snapshot {
  const chosen = snapshots[primary];
  const others = snapshots.filter((_, index) => index !== primary);
  const parts = [`PAGA ${(chosen.id.split("/").pop() ?? "").slice(0, 6)}`];
  const usable = others.filter((s) => s.windows.length && !s.error);
  if (usable.length) {
    const best = (label: string): string => {
      const cells = usable.flatMap((s) => s.windows.filter((w) => w.label === label).map((w) => ({ left: 100 - w.used, reset: w.resetsAt })));
      if (!cells.length) return `${label.toLowerCase()} sem leitura`;
      const top = cells.reduce((a, b) => (b.left > a.left ? b : a));
      const tail = top.reset !== undefined && top.reset > now ? ` (renova ${countdown(top.reset - now)})` : "";
      return `${label.toLowerCase()} ${top.left.toFixed(0)}% livre${tail}`;
    };
    parts.push(`BONUS ${others.length} contas: ${best("5 horas")} | ${best("Semanal")}`);
  } else {
    parts.push(`BONUS ${others.length} contas sem leitura`);
  }
  if (chosen.note) parts.push(chosen.note);
  return { ...chosen, id: "antigravity", name: "Antigravity", note: parts.join(" | ") };
}

async function collectAntigravity(): Promise<Snapshot[]> {
  const now = nowSec();
  let root: Json;
  try {
    root = await readJson(AGY_URL, { timeout: 5 });
  } catch {
    throw new ReadError("Abra o proxy AGY para consultar as quotas do Antigravity.");
  }
  const snapshots = parseProxy(root, now);
  return [collapse(snapshots, paidIndex(root, process.env.NOTUTIL_AGY_PAID ?? ""), now)];
}

// --- OpenAI/Codex: 'codex app-server --stdio' com a sessão já logada (sem tokens aqui) ---

const CODEX_DURATIONS: Record<number, [string, number]> = { 300: ["5 horas", 18000], 10080: ["Semanal", 604800] };

function codexBucket(result: Json): Json {
  const byId = result.rateLimitsByLimitId;
  if (isObject(byId) && Object.keys(byId).length) {
    if (isObject(byId.codex)) return byId.codex;
    const first = Object.values(byId).find(isObject);
    if (first) return first;
  }
  if (isObject(result.rateLimits)) return result.rateLimits;
  throw new ReadError("O Codex não informou limites de quota para esta conta.");
}

function codexWindow(item: unknown, fallback: string): Window | undefined {
  if (!isObject(item)) return undefined;
  const used = clamped(item.usedPercent, 0, 100);
  if (used === undefined) return undefined;
  const minutes = typeof item.windowDurationMins === "number" ? item.windowDurationMins : undefined;
  const known = minutes === undefined ? undefined : CODEX_DURATIONS[minutes];
  // Duração fora da tabela: rótulo com a duração real, sem chamar de "5 horas".
  const label = known?.[0] ?? (minutes === undefined ? fallback : "Janela de " + minutes + " min");
  return { label, used, resetsAt: epoch(item.resetsAt), duration: known?.[1] };
}

export function parseCodex(result: Json, now: number): Snapshot {
  const bucket = codexBucket(result);
  const windows = [codexWindow(bucket.primary, "5 horas"), codexWindow(bucket.secondary, "Semanal")].filter(
    (w): w is Window => w !== undefined,
  );
  if (!windows.length) throw new ReadError("O Codex informou limites sem percentual utilizável.");
  const credits = result.rateLimitResetCredits;
  const count = isObject(credits) ? credits.availableCount : undefined;
  const note = typeof count === "number" && Number.isInteger(count) && count > 0 ? `${count} reset(s) de limite disponível(is)` : "";
  return { id: "openai", name: "OpenAI Codex", pet: "openai", windows, updatedAt: now, source: "codex app-server", note };
}

class MissingBinary extends ReadError {}

function codexRateLimits(): Promise<Json> {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    const finish = (error?: Error, value?: Json) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const noAnswer = () => new ReadError("O Codex não respondeu à leitura de quotas.");
    const timer = setTimeout(() => finish(noAnswer()), 20_000);
    proc.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? new MissingBinary("Codex CLI não encontrado no PATH.") : noAnswer()));
    proc.on("close", () => finish(noAnswer()));
    proc.stdin?.on("error", () => finish(noAnswer())); // EPIPE se o processo morrer antes
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(message) || message.id !== 2) return;
      if (isObject(message.error)) return finish(new ReadError("O Codex recusou a leitura de quotas."));
      return isObject(message.result) ? finish(undefined, message.result) : finish(noAnswer());
    });
    const requests = [
      { method: "initialize", id: 1, params: { clientInfo: { name: "notutil", title: "notutil", version: "0" } } },
      { method: "initialized" },
      { method: "account/rateLimits/read", id: 2 },
    ];
    for (const request of requests) proc.stdin?.write(JSON.stringify(request) + "\n");
  });
}

async function collectOpenai(): Promise<Snapshot[]> {
  try {
    return [parseCodex(await codexRateLimits(), nowSec())];
  } catch (error) {
    if (error instanceof MissingBinary) return [disabled("openai", "OpenAI Codex", "codex app-server", error.message)];
    throw error;
  }
}

// --- Claude: arquivos locais (statusLine exato ou histórico do app desktop); sem rede ---

const CLAUDE_SOURCE = "App Claude / histórico do plano";
const CLAUDE_NO_DATA = "Sem dados locais do Claude: use o Claude Code com statusLine ou abra o app desktop.";
const FIVE_HOURS = 18000;
const WEEKLY = 604800;

interface Sample {
  at: number;
  org?: string;
  fh?: number;
  sd?: number;
}

type SampleKey = "fh" | "sd";

const statuslinePath = () =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "notutil", "claude-limits.json");

function historyCandidates(): string[] {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [
    join(config, "Claude", "plan-usage-history.json"),
    join(homedir(), ".local", "share", "Claude", "plan-usage-history.json"),
    join(homedir(), ".claude", "plan-usage-history.json"),
  ];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function historyPath(): Promise<string | undefined> {
  const found: { path: string; mtime: number }[] = [];
  for (const path of historyCandidates()) {
    try {
      const info = await stat(path);
      if (info.isFile()) found.push({ path, mtime: info.mtimeMs });
    } catch {
      // ausente: ignora
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

export async function readStatusline(now: number, path = statuslinePath()): Promise<Snapshot | undefined> {
  let raw: unknown;
  let updated: number;
  try {
    raw = parseJson(await readFile(path, "utf8"));
    if (!isObject(raw)) return undefined;
    updated = epoch(raw.captured_at) ?? (await stat(path)).mtimeMs / 1000;
  } catch {
    return undefined;
  }
  const limits = (raw as Json).rate_limits;
  if (!isObject(limits)) return undefined;
  const windows: Window[] = [];
  for (const [key, label, duration] of [["five_hour", "5 horas", FIVE_HOURS], ["seven_day", "Semanal", WEEKLY]] as const) {
    const item = limits[key];
    if (!isObject(item)) continue;
    const used = clamped(item.used_percentage, 0, 100);
    const reset = epoch(item.resets_at);
    if (used === undefined || (reset !== undefined && reset <= now)) continue;
    windows.push({ label, used, resetsAt: reset, duration });
  }
  if (!windows.length) return undefined;
  const stale = now - updated > 30 * 60;
  return {
    id: "claude",
    name: "Claude Code",
    pet: "claude",
    windows,
    updatedAt: updated,
    source: "Claude Code / statusLine",
    note: stale ? "statusLine vencido; abra o Claude Code." : "statusLine do Claude Code (exato)",
    stale,
  };
}

async function readSamples(path: string): Promise<Sample[]> {
  let raw: unknown;
  try {
    raw = parseJson(await readFile(path, "utf8"));
  } catch {
    throw new ReadError("Não foi possível ler o histórico do app Claude.");
  }
  const items = isObject(raw) ? raw.samples : undefined;
  if (!Array.isArray(items)) throw new ReadError("Histórico do Claude em formato desconhecido.");
  const rows: Sample[] = [];
  for (const item of items) {
    if (!isObject(item) || typeof item.t !== "number") continue;
    const usage = isObject(item.u) ? item.u : {};
    rows.push({
      at: item.t / 1000,
      org: typeof item.org === "string" ? item.org : undefined,
      fh: clamped(usage.fh, 0, 100),
      sd: clamped(usage.sd, 0, 100),
    });
  }
  rows.sort((a, b) => a.at - b.at);
  if (!rows.length) throw new ReadError("O app Claude ainda não registrou uso do plano.");
  const org = rows[rows.length - 1].org;
  return rows.filter((row) => row.org === org);
}

function latestIndex(rows: Sample[], key: SampleKey): number | undefined {
  for (let index = rows.length - 1; index >= 0; index--) if (rows[index][key] !== undefined) return index;
  return undefined;
}

/** Reset da janela de 5h = meio do intervalo sem amostras + duração. Semanal nunca é inventado. */
export function estimateReset(rows: Sample[], key: SampleKey, index: number, now: number, duration: number): [number | undefined, string] {
  if (duration === WEEKLY) return [undefined, "aguardando horário oficial de renovação"];
  const latest = rows[index];
  const used = latest[key];
  if (now - latest.at > duration) return [undefined, "janela expirou desde a última amostra"];
  if (used === undefined || used <= 0) return [undefined, "janela inicia no próximo uso"];
  let first = index;
  let previous: number | undefined;
  for (let j = index - 1; j >= 0; j--) {
    const value = rows[j][key];
    if (value === undefined) continue;
    if (value <= 0 || value > used || latest.at - rows[j].at > duration) {
      previous = j;
      break;
    }
    first = j;
  }
  if (previous === undefined || rows[first].at - rows[previous].at > 7200)
    return [undefined, "horário de renovação indisponível"];
  return [(rows[previous].at + rows[first].at) / 2 + duration, "reset estimado pelo início da janela"];
}

async function readHistory(now: number): Promise<Snapshot | undefined> {
  const path = await historyPath();
  if (!path) return undefined;
  const rows = await readSamples(path);
  const windows: Window[] = [];
  const hints: string[] = [];
  let stale = false;
  for (const [key, label, duration] of [["fh", "5 horas", FIVE_HOURS], ["sd", "Semanal", WEEKLY]] as const) {
    const index = latestIndex(rows, key);
    if (index === undefined) continue;
    const [resetsAt, hint] = estimateReset(rows, key, index, now, duration);
    windows.push({ label, used: rows[index][key] as number, resetsAt, duration, estimated: true });
    if (resetsAt === undefined) hints.push(hint);
    stale = stale || now - rows[index].at > 40 * 60;
  }
  let note = CLAUDE_SOURCE;
  if (hints.length) note += ` | ${[...new Set(hints)].join(" | ")}`;
  if (stale) note += " | abra o app Claude para atualizar";
  return {
    id: "claude",
    name: "Claude Code",
    pet: "claude",
    windows,
    updatedAt: rows[rows.length - 1].at,
    source: CLAUDE_SOURCE,
    note,
    stale,
  };
}

const noClaudeData = (): Snapshot => disabled("claude", "Claude Code", CLAUDE_SOURCE, CLAUDE_NO_DATA);

async function collectClaude(): Promise<Snapshot[]> {
  const now = nowSec();
  if (!(await isFile(statuslinePath())) && !(await historyPath())) return [noClaudeData()];
  const statusline = await readStatusline(now);
  let desktop: Snapshot | undefined;
  try {
    desktop = await readHistory(now);
  } catch (error) {
    desktop = { id: "claude", name: "Claude Code", pet: "claude", windows: [], source: CLAUDE_SOURCE,
      error: error instanceof ReadError ? error.message : "Falha ao ler o histórico do app Claude." };
  }
  const candidates = [statusline, desktop].filter((s): s is Snapshot => s !== undefined && s.windows.length > 0);
  if (!candidates.length) return [desktop ?? noClaudeData()];
  let chosen = candidates[0];
  if (candidates.length > 1) {
    chosen = candidates.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
    // Quando o desktop vence, a renovação exata do statusLine prevalece.
    const exact = chosen === statusline ? undefined : statusline;
    if (exact)
      chosen = {
        ...chosen,
        windows: chosen.windows.map((w) => ({
          ...w,
          resetsAt: exact.windows.find((e) => e.label === w.label && e.resetsAt)?.resetsAt ?? w.resetsAt,
        })),
      };
  }
  return [chosen];
}

// --- registro dos coletores, por provedor ---

export const COLLECTORS: Record<string, () => Promise<Snapshot[]>> = {
  antigravity: collectAntigravity,
  opencode: collectOpencode,
  openai: collectOpenai,
  claude: collectClaude,
  commandcode: collectCommandcode,
};
