// Contas do Antigravity num arquivo do próprio TUI: /quota-login importa o que o AGY já tinha e,
// quando o refresh token não vale mais, faz o login Google aqui mesmo (OAuth loopback + PKCE).
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  AGY_CLIENT,
  agyAccountsPath,
  agyLegacyPath,
  agyLoginToken,
  agyToken,
  parseAgyAccounts,
  readPrivateJson,
} from "./providers.ts";
import type { Json } from "./providers.ts";

export type Notify = (message: string, level?: "info" | "warning" | "error") => void;

const SCOPE = "openid email profile https://www.googleapis.com/auth/cloud-platform";
const TIMEOUT_MS = 5 * 60_000;

/** Grava a lista de contas com modo 600: são refresh tokens. */
export async function saveAccounts(target: string, accounts: readonly Json[]): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600 });
  // writeFile não aperta o modo de um arquivo que já existia.
  await chmod(target, 0o600);
}

/** Só as contas cujo refresh token o Google ainda renova. */
export async function validAccounts(
  accounts: readonly ({ refreshToken: string } & Json)[],
  refresh: (token: string) => Promise<unknown> = agyToken,
): Promise<Json[]> {
  const valid: Json[] = [];
  for (const account of accounts) {
    try {
      await refresh(account.refreshToken.trim());
      valid.push(account);
    } catch {
      // Token revogado ou emitido para outro client: fica de fora.
    }
  }
  return valid;
}

const CONSENT_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export function agyConsentUrl(redirect: string, challenge: string): string {
  const query = new URLSearchParams({
    client_id: AGY_CLIENT,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return `${CONSENT_ENDPOINT}?${query}`;
}

/** E-mail do id_token. Vem assinado pelo Google, mas aqui só serve de rótulo local. */
export function emailFromIdToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof (payload as Json).email === "string" ? ((payload as Json).email as string) : undefined;
  } catch {
    return undefined;
  }
}

const b64url = (buffer: Buffer): string => buffer.toString("base64url");

async function consentLogin(notify: Notify): Promise<Json> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let grant: (code: string) => void = () => {};
  let refuse: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    grant = resolve;
    refuse = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void response.writeHead(404).end();
    const error = url.searchParams.get("error");
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error ? "Login cancelado." : "Login concluído, pode fechar esta aba.");
    if (error) refuse(new Error("Login Google cancelado."));
    else grant(url.searchParams.get("code") ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirect = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => refuse(new Error("Tempo esgotado esperando o login no navegador.")), TIMEOUT_MS);
  notify(`Abra no navegador para entrar na conta Antigravity: ${agyConsentUrl(redirect, challenge)}`, "info");
  try {
    const granted = await code;
    if (!granted) throw new Error("O Google não devolveu o código de autorização.");
    const root = await agyLoginToken(granted, redirect, verifier);
    const refresh = root.refresh_token;
    if (typeof refresh !== "string" || !refresh) throw new Error("O Google não devolveu refresh token; tente o login de novo.");
    // projectId fica de fora: sem ele a coleta usa o projeto padrão do Cloud Code.
    return { refreshToken: refresh, email: emailFromIdToken(root.id_token) };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** Importa do AGY se der, senão faz o login na própria extensão. */
export async function loginAgy(notify: Notify): Promise<void> {
  const target = agyAccountsPath();
  const own = parseAgyAccounts(await readPrivateJson(target));
  if (own.length && (await validAccounts(own)).length === own.length) {
    notify(`Antigravity: ${own.length} conta(s) já validadas em ${target}.`, "info");
    return;
  }
  const imported = await validAccounts(parseAgyAccounts(await readPrivateJson(agyLegacyPath())));
  if (imported.length) {
    await saveAccounts(target, imported);
    notify(`Antigravity: ${imported.length} conta(s) importada(s) do AGY para ${target}.`, "info");
    return;
  }
  notify("Antigravity: nenhum token do AGY valeu; abrindo o login do Google.", "warning");
  const account = await consentLogin(notify);
  await saveAccounts(target, [account]);
  notify(`Antigravity: conta ${account.email ?? "nova"} salva em ${target}.`, "info");
}
