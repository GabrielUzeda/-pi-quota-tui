// Provedor com falha continua visível como SEM SINAL, não some do painel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { health } from "../src/rules.ts";
import { Monitor } from "../src/service.ts";

test("serviço: provedor com falha continua visível como SEM SINAL, não some", () => {
  const monitor = new Monitor();
  (monitor as unknown as { fail(provider: string, message: string): void }).fail("antigravity", "Abra o proxy AGY");
  const [s] = monitor.snapshots("antigravity");
  assert.equal(s.disabled, false);
  assert.equal(s.name, "Antigravity");
  assert.equal(s.error, "Abra o proxy AGY");
  assert.equal(health(s, Date.now() / 1000), "SEM SINAL");
  monitor.stop();
});
