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

/** Identificação enviada às APIs; acompanha o nome do pacote. */
const USER_AGENT = "pi-quota-tui/0.2";

/** Número dentro de um intervalo; percentual acima de 100 vira 100 em vez de sumir. */
export function clamped(value: unknown, low: number, high: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : undefined;
}

/** JSON com BOM (comum em arquivos gravados no Windows) também é aceito; lixo vira SyntaxError sem ecoar o conteúdo. */
export function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new SyntaxError("JSON inválido");
  }
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
    // Sem fuso explícito, tratamos como UTC.
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
    const init: RequestInit = {
      method: options.body === undefined ? "GET" : "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeout * 1000),
    };
    if (options.headers) init.headers = options.headers;
    if (options.body !== undefined) init.body = options.body;
    const response = await fetch(url, init);
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

// --- credenciais: auth.json do Pi (somente se privado) primeiro, variáveis de ambiente como fallback ---

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
  const key = (await authEntry(section)).key;
  if (typeof key === "string" && key.trim()) return key.trim();
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/** Token OAuth guardado pelo login do pi (`type: "oauth"`); vazio quando a seção é api key ou não existe. */
async function oauthAccess(section: string): Promise<string> {
  const entry = await authEntry(section);
  const token = entry.type === "oauth" ? entry.access : undefined;
  return typeof token === "string" ? token.trim() : "";
}

function disabled(id: string, name: string, source: string, error: string): Snapshot {
  return { id, name, windows: [], source, error, disabled: true };
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
  return { id: "opencode", name: "OpenCode Go", windows, updatedAt: now, source: "OpenCode Go / usage" };
}

async function collectOpencode(): Promise<Snapshot[]> {
  const key = await secret(["OPENCODE_GO_KEY"], "opencode-go");
  if (!key)
    return [disabled("opencode", "OpenCode Go", "OpenCode Go / usage", "Sem credencial: use a entrada `opencode-go` em ~/.pi/agent/auth.json (ou OPENCODE_GO_KEY).")];
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
  return { id: "commandcode", name: "CommandCode", windows, updatedAt: now, source: "CommandCode / billing", note };
}

async function collectCommandcode(): Promise<Snapshot[]> {
  const key = await secret(["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"], "commandcode");
  if (!key) return [disabled("commandcode", "CommandCode", "CommandCode / billing", "Sem credencial: use a entrada `commandcode` em ~/.pi/agent/auth.json (ou COMMAND_CODE_API_KEY).")];
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT, Authorization: `Bearer ${key}` };
  const credits = await readJson(`${CC_BASE}/billing/credits`, { headers, timeout: 10 });
  const summary = await readJson(`${CC_BASE}/usage/summary`, { headers, timeout: 10 }).catch(() => undefined);
  const day = Number((await authEntry("commandcode")).resetDay ?? 16);
  return [parseCommandcode(credits, summary, nowSec(), Number.isFinite(day) ? day : 16)];
}

// --- Antigravity / Cloud Code: OAuth próprio, sem proxy local ---

const AGY_SOURCE = "Antigravity / Cloud Code";
const AGY_PROJECT = "aicode-consumers";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const AGY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
// Credencial do CLI Antigravity, a mesma que o proxy local usava. Ela vai publicada no pacote por
// decisão do autor: se o Google revogar ou limitar este client, este caminho para de funcionar.
const AGY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const AGY_CLIENT_SECRET = "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";
// O Cloud Code recusa (403) quem não se identifica como o CLI; o proxy usava exatamente esta UA.
const AGY_USER_AGENT = "antigravity/cli/1.2.16 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)";

/** Contas do Antigravity: `PI_QUOTA_TUI_AGY_ACCOUNTS` ou o arquivo que o /quota-login mantém. */
export const agyAccountsPath = (): string =>
  process.env.PI_QUOTA_TUI_AGY_ACCOUNTS?.trim() || join(homedir(), ".local", "share", "pi-quota-tui", "agy-accounts.json");

/** accounts.json do AGY Local Proxy: só leitura, compatibilidade com quem já o tinha. */
export const agyLegacyPath = (): string => join(homedir(), ".local", "share", "agy-local-proxy", "accounts.json");

type AgyAccount = Json & { refreshToken: string };

const identityKey = (account: Json, index: number): string => {
  const identity = account.email || account.projectId;
  return identity ? createHash("sha256").update(String(identity)).digest("hex").slice(0, 10) : String(index + 1);
};

export function parseGroups(groups: unknown): Window[] {
  if (!Array.isArray(groups)) return [];
  const windows: Window[] = [];
  for (const group of groups) {
    if (!isObject(group) || typeof group.displayName !== "string" || !Array.isArray(group.buckets)) continue;
    const name = group.displayName
      .trim()
      .replace(/\s+models$/i, "")
      .replace(/\band\b/g, "e")
      // "Gemini 4 Argon" vira "Argon": a linha do modelo fica curta no painel.
      .replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, "");
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

/** Contas utilizáveis: sem refreshToken não há como renovar o token, então ficam de fora. */
export function parseAgyAccounts(root: unknown): AgyAccount[] {
  if (!Array.isArray(root)) return [];
  return root
    .filter(isObject)
    .filter((account): account is AgyAccount => typeof account.refreshToken === "string" && account.refreshToken.trim() !== "");
}

/** JSON privado: guarda refresh tokens, então só o dono pode ler, como o auth.json. */
export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (info.mode & 0o077) return undefined;
    return parseJson(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function agyAccountsFile(): Promise<unknown> {
  return (await readPrivateJson(agyAccountsPath())) ?? (await readPrivateJson(agyLegacyPath()));
}

const googleToken = (body: Record<string, string>): Promise<Json> =>
  readJson(GOOGLE_TOKEN_URL, {
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: AGY_CLIENT_ID, client_secret: AGY_CLIENT_SECRET, ...body }).toString(),
    timeout: 10,
  });

/** Client público do CLI Antigravity; o /quota-login monta a URL de consentimento com ele. */
export const AGY_CLIENT = AGY_CLIENT_ID;

/** Código do consentimento Google trocado por refresh token (login feito pela própria extensão). */
export const agyLoginToken = (code: string, redirect: string, verifier: string): Promise<Json> =>
  googleToken({ code, redirect_uri: redirect, code_verifier: verifier, grant_type: "authorization_code" });

export async function agyToken(refreshToken: string): Promise<string> {
  const root = await googleToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  const token = root.access_token;
  if (typeof token !== "string" || !token) throw new ReadError("O Google não renovou o token desta conta Antigravity.");
  return token;
}

/** O primeiro endpoint é o do dia; o segundo cobre contas que só respondem no host antigo. */
async function agyGroups(token: string, project: string): Promise<unknown[]> {
  let failure: ReadError | undefined;
  for (const url of AGY_QUOTA_URLS) {
    try {
      const root = await readJson(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": AGY_USER_AGENT },
        body: JSON.stringify({ project }),
        timeout: 10,
      });
      if (Array.isArray(root.groups)) return root.groups;
      failure = new ReadError("O Cloud Code não informou grupos de quota.");
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      failure = error;
    }
  }
  throw failure ?? new ReadError("O Cloud Code não informou grupos de quota.");
}

/** Uma conta Antigravity vira um snapshot; a paga é escolhida depois por paidIndex. */
export function agySnapshot(account: AgyAccount, index: number, groups: unknown[], now: number): Snapshot {
  const key = identityKey(account, index);
  const windows = parseGroups(groups);
  return {
    id: `antigravity/${key}`,
    name: `Antigravity / conta ${key.slice(0, 6)}`,
    windows,
    updatedAt: now,
    source: AGY_SOURCE,
    error: windows.length ? undefined : "Conta sem leitura de quota reconhecida.",
    note: "Contas separadas; percentuais não são somados nem promediados.",
  };
}

/** Conta paga: a apontada por PI_QUOTA_TUI_AGY_PAID (id, e-mail ou projeto) ou a com mais janelas lidas. */
export function paidIndex(accounts: AgyAccount[], snapshots: Snapshot[], hint = ""): number {
  const wanted = hint.trim();
  if (wanted) {
    const found = accounts.findIndex(
      (a, i) => wanted === a.email || wanted === a.projectId || identityKey(a, i).startsWith(wanted),
    );
    if (found >= 0) return found;
  }
  let best = 0;
  let bestCount = -1;
  snapshots.forEach((s, index) => {
    if (s.windows.length > bestCount) {
      best = index;
      bestCount = s.windows.length;
    }
  });
  return best;
}

/** Uma cota principal (a paga); as demais viram BONUS. Nada é somado nem promediado. */
export function collapse(snapshots: Snapshot[], primary: number, now: number): Snapshot {
  const chosen = snapshots[primary] ?? snapshots[0];
  if (!chosen) throw new ReadError("Nenhuma conta Antigravity disponível.");
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
  const accounts = parseAgyAccounts(await agyAccountsFile());
  if (!accounts.length)
    return [disabled("antigravity", "Antigravity", AGY_SOURCE,
      "Sem contas Antigravity: rode /quota-login para importar do AGY ou entrar com o Google.")];
  const snapshots = await Promise.all(accounts.map(async (account, index) => {
    try {
      const token = await agyToken(account.refreshToken.trim());
      return agySnapshot(account, index, await agyGroups(token, String(account.projectId ?? AGY_PROJECT)), now);
    } catch (error) {
      const key = identityKey(account, index);
      return {
        id: `antigravity/${key}`,
        name: `Antigravity / conta ${key.slice(0, 6)}`,
        windows: [],
        source: AGY_SOURCE,
        error: error instanceof ReadError ? error.message : "Falha na leitura do Antigravity.",
      } satisfies Snapshot;
    }
  }));
  // Nenhuma conta legível: devolve os erros por conta para /quota explicar cada uma.
  if (!snapshots.some((s) => s.windows.length)) return snapshots;
  return [collapse(snapshots, paidIndex(accounts, snapshots, process.env.PI_QUOTA_TUI_AGY_PAID ?? ""), now)];
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
  return { id: "openai", name: "OpenAI Codex", windows, updatedAt: now, source: "codex app-server", note };
}

class MissingBinary extends ReadError {}

/** Chaves de quota não vão para o subprocesso: o Codex não precisa delas. */
const FOREIGN_SECRETS = ["OPENCODE_GO_KEY", "COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"];

function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of FOREIGN_SECRETS) delete env[name];
  return env;
}

function codexRateLimits(): Promise<Json> {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"], env: codexEnv() });
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
      { method: "initialize", id: 1, params: { clientInfo: { name: "pi-quota-tui", title: "pi-quota-tui", version: "0" } } },
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

// --- Claude: histórico local do app desktop; sem rede ---

const CLAUDE_SOURCE = "App Claude / histórico do plano";
const CLAUDE_NO_DATA = "Sem dados do Claude: abra o app desktop ou faça login (Claude Pro/Max) no pi.";
const FIVE_HOURS = 18000;
const WEEKLY = 604800;

interface Sample {
  at: number;
  org?: string;
  fh?: number;
  sd?: number;
}

type SampleKey = "fh" | "sd";

// shortcut: o caminho OAuth (api/oauth/usage) não tem teste de integração — só parseOauthUsage é
// testado, porque a chamada exige login Claude Pro/Max real; cobrir quando houver credencial de teste.
function historyCandidates(): string[] {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [
    join(config, "Claude", "plan-usage-history.json"),
    join(homedir(), ".local", "share", "Claude", "plan-usage-history.json"),
    join(homedir(), ".claude", "plan-usage-history.json"),
  ];
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
    windows,
    updatedAt: rows[rows.length - 1].at,
    source: CLAUDE_SOURCE,
    note,
    stale,
  };
}

const noClaudeData = (): Snapshot => disabled("claude", "Claude Code", CLAUDE_SOURCE, CLAUDE_NO_DATA);

// --- Claude: OAuth da assinatura (fallback quando não há arquivo local) ---

const ANTHROPIC_USAGE = "https://api.anthropic.com/api/oauth/usage";

/** Uso da assinatura pelo OAuth: utilization 0..100 e resets_at em ISO. */
export function parseOauthUsage(root: Json, now: number): Snapshot {
  const windows: Window[] = [];
  const locked: string[] = [];
  for (const [key, label, duration] of [["five_hour", "5 horas", FIVE_HOURS], ["seven_day", "Semanal", WEEKLY]] as const) {
    const item = root[key];
    if (!isObject(item)) continue;
    const used = clamped(item.utilization, 0, 100);
    if (used === undefined) continue;
    windows.push({ label, used, resetsAt: epoch(item.resets_at), duration });
    if (typeof item.locked_reason === "string" && item.locked_reason) locked.push(label);
  }
  if (!windows.length) throw new ReadError("O Claude (OAuth) não informou janelas de quota.");
  const parts = ["OAuth do pi / uso da assinatura"];
  if (locked.length) parts.push(`bloqueado: ${locked.join(", ")}`);
  return { id: "claude", name: "Claude Code", windows, updatedAt: now, source: "Claude / OAuth usage", note: parts.join(" | ") };
}

async function readOauthUsage(now: number): Promise<Snapshot | undefined> {
  const token = await oauthAccess("anthropic");
  if (!token) return undefined;
  const root = await readJson(ANTHROPIC_USAGE, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "x-app": "cli",
      "User-Agent": USER_AGENT,
    },
    timeout: 10,
  });
  return parseOauthUsage(root, now);
}

/** Histórico do app desktop; erro local só aparece se o OAuth também não render nada. */
async function localClaude(now: number): Promise<{ snapshot?: Snapshot; error?: Snapshot }> {
  if (!(await historyPath())) return {};
  try {
    const desktop = await readHistory(now);
    return desktop?.windows.length ? { snapshot: desktop } : {};
  } catch (error) {
    const message = error instanceof ReadError ? error.message : "Falha ao ler o histórico do app Claude.";
    return { error: { id: "claude", name: "Claude Code", windows: [], source: CLAUDE_SOURCE, error: message } };
  }
}

async function collectClaude(): Promise<Snapshot[]> {
  const now = nowSec();
  const local = await localClaude(now);
  if (local.snapshot) return [local.snapshot];
  try {
    const oauth = await readOauthUsage(now);
    if (oauth) return [oauth];
  } catch (error) {
    if (error instanceof ReadError) return [{ id: "claude", name: "Claude Code", windows: [], source: "Claude / OAuth usage", error: error.message }];
    throw error;
  }
  return [local.error ?? noClaudeData()];
}

// --- registro dos coletores, por provedor ---

export const COLLECTORS: Record<string, () => Promise<Snapshot[]>> = {
  antigravity: collectAntigravity,
  opencode: collectOpencode,
  openai: collectOpenai,
  claude: collectClaude,
  commandcode: collectCommandcode,
};
