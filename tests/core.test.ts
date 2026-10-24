// Testes das regras que decidem o que o usuário vê: ritmo, saúde, parsers e reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bar } from "../src/format.ts";
import { health, pace } from "../src/rules.ts";
import { collapse, estimateReset, nextMonthlyReset, paidIndex, parseCodex, parseProxy } from "../src/providers.ts";
import { frameToAnsi } from "../src/pets.ts";
import type { Snapshot } from "../src/models.ts";

const NOW = 1_700_000_000;

test("ritmo: metade do ciclo de 5h com metade usada fica no ritmo", () => {
  const w = { label: "5 horas", used: 50, resetsAt: NOW + 9000, duration: 18000 };
  assert.equal(pace(w, NOW), 50);
  const s: Snapshot = { id: "x", name: "X", pet: "openai", windows: [w], updatedAt: NOW, source: "" };
  assert.deepEqual(health(s, NOW), { emotion: "concentrado", status: "MONITORANDO" });
});

test("saúde: sem janelas é SEM SINAL; uso >= 90% é ATENCAO", () => {
  const empty: Snapshot = { id: "x", name: "X", pet: "x", windows: [], source: "" };
  assert.equal(health(empty, NOW).status, "SEM SINAL");
  const hot: Snapshot = { id: "x", name: "X", pet: "x", windows: [{ label: "Semanal", used: 95 }], updatedAt: NOW, source: "" };
  assert.equal(health(hot, NOW).status, "ATENCAO");
});

test("codex: janelas 5h/semanal pela duração informada", () => {
  const snap = parseCodex({
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: NOW + 600 },
                                    secondary: { usedPercent: 70, windowDurationMins: 10080 } } },
  }, NOW);
  assert.deepEqual(snap.windows.map((w) => [w.label, w.duration]), [["5 horas", 18000], ["Semanal", 604800]]);
});

test("AGY: conta paga escolhida pelo hint e demais contas viram BONUS sem somar", () => {
  const root = {
    quotaAgeMs: 1000,
    accounts: [
      { email: "a@x", quota: { groups: [{ displayName: "Claude", buckets: [{ window: "5h", remainingFraction: 0.5 }] }] } },
      { email: "b@x", quota: { groups: [{ displayName: "Claude", buckets: [{ window: "5h", remainingFraction: 0.9 }] }] } },
    ],
  };
  assert.equal(paidIndex(root, "b@x"), 1);
  const snaps = parseProxy(root, NOW);
  const merged = collapse(snaps, 1, NOW);
  assert.equal(merged.id, "antigravity");
  assert.match(merged.note ?? "", /^PAGA /);
  assert.match(merged.note ?? "", /BONUS 1 contas: 5 horas 50% livre/);
});

test("reset: semanal nunca é inventado; mensal vira próximo dia de virada", () => {
  assert.equal(estimateReset([{ at: NOW, fh: 10 }], "sd", 0, NOW, 604800)[0], undefined);
  const reset = nextMonthlyReset(16, Date.UTC(2024, 0, 20) / 1000);
  assert.equal(new Date(reset * 1000).toISOString(), "2024-02-16T00:00:00.000Z");
});

test("barra marca o ritmo e frame transparente vira espaço", () => {
  assert.equal(bar(50, 50, 10), "█████│░░░░");
  assert.equal(frameToAnsi(["..", ".."])[0], "\x1b[0m \x1b[0m ");
});
