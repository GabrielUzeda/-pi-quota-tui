import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyConsentUrl, emailFromIdToken, saveAccounts, validAccounts } from "../src/agy-login.ts";

test("saveAccounts cria o diretório e grava com modo 600", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "quota-login-")), "nested");
  const file = join(dir, "agy-accounts.json");
  await saveAccounts(file, [{ refreshToken: "r1", email: "a@b.c" }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ refreshToken: "r1", email: "a@b.c" }]);
});

test("saveAccounts aperta o modo de um arquivo que já existia", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-login-"));
  const file = join(dir, "agy.json");
  await saveAccounts(file, [{ refreshToken: "r1" }]);
  const { chmod } = await import("node:fs/promises");
  await chmod(file, 0o644);
  await saveAccounts(file, [{ refreshToken: "r2" }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("validAccounts descarta token que o Google não renova", async () => {
  const accounts = [{ refreshToken: " bom " }, { refreshToken: "morto" }];
  const vistos: string[] = [];
  const valid = await validAccounts(accounts, async (token) => {
    vistos.push(token);
    if (token === "morto") throw new Error("revogado");
    return "access";
  });
  assert.deepEqual(vistos, ["bom", "morto"]);
  assert.deepEqual(valid, [{ refreshToken: " bom " }]);
});

test("agyConsentUrl leva client, escopo offline e PKCE", () => {
  const url = new URL(agyConsentUrl("http://127.0.0.1:1234/callback", "desafio"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1234/callback");
  assert.equal(url.searchParams.get("code_challenge"), "desafio");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.match(url.searchParams.get("scope") ?? "", /cloud-platform/);
  assert.ok((url.searchParams.get("client_id") ?? "").endsWith(".apps.googleusercontent.com"));
});

test("emailFromIdToken lê o e-mail e ignora lixo", () => {
  const payload = Buffer.from(JSON.stringify({ email: "conta@exemplo.com" })).toString("base64url");
  assert.equal(emailFromIdToken(`header.${payload}.assinatura`), "conta@exemplo.com");
  assert.equal(emailFromIdToken(undefined), undefined);
  assert.equal(emailFromIdToken("sem.pontos"), undefined);
  assert.equal(emailFromIdToken("a.nao-json.c"), undefined);
});
