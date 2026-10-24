// Erros de resposta por provedor: respostas válidas em JSON mas inúteis viram ReadError, não crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommandcode, parseProxy, parseOpencode, ReadError } from "../src/providers.ts";

const NOW = 1_700_000_000;

test("AGY: proxy offline ou sem contas é ReadError", () => {
  assert.throws(() => parseProxy({ offline: true, accounts: [{}] }, NOW), ReadError);
  assert.throws(() => parseProxy({ accounts: [] }, NOW), ReadError);
  assert.throws(() => parseProxy({}, NOW), ReadError);
});

test("AGY: conta sem quota reconhecida fica com erro próprio, sem janelas", () => {
  const [s] = parseProxy({ accounts: [{ email: "a@x", quota: { error: "x" } }] }, NOW);
  assert.equal(s.windows.length, 0);
  assert.equal(s.error, "Conta sem leitura de quota reconhecida.");
});

test("AGY: idade ausente marca a quota como antiga", () => {
  const [s] = parseProxy({ accounts: [{ email: "a@x", quota: { groups: [] } }] }, NOW);
  assert.equal(s.stale, true);
  assert.equal(s.updatedAt, undefined);
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
