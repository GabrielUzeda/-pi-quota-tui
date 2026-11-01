// Erros de resposta por provedor: respostas válidas em JSON mas inúteis viram ReadError, não crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agySnapshot, parseAgyAccounts, parseCommandcode, parseOpencode, ReadError } from "../src/providers.ts";

const NOW = 1_700_000_000;

test("Antigravity: contas sem refreshToken são descartadas e lixo não derruba a lista", () => {
  assert.equal(parseAgyAccounts([{}, { refreshToken: "" }, null, 3, "x"]).length, 0);
  assert.equal(parseAgyAccounts({ accounts: [{ refreshToken: "r" }] }).length, 0);
});

test("Antigravity: conta sem grupos reconhecidos fica com erro próprio, sem janelas", () => {
  const s = agySnapshot({ refreshToken: "r", email: "a@x" }, 0, [], NOW);
  assert.equal(s.windows.length, 0);
  assert.equal(s.error, "Conta sem leitura de quota reconhecida.");
});

test("OpenCode: resposta sem janelas reconhecidas é ReadError", () => {
  assert.throws(() => parseOpencode({ usage: { rolling: { percent: "abc" } } }, NOW), ReadError);
});

test("CommandCode: sem créditos é ReadError", () => {
  assert.throws(() => parseCommandcode({}, undefined, NOW), ReadError);
});

test("CommandCode: sem janela de 5h/semanal avisa na nota, não falha", () => {
  const s = parseCommandcode({ credits: { monthlyCredits: 5 } }, undefined, NOW);
  assert.match(s.note ?? "", /sem janela de 5h\/semanal/);
});
