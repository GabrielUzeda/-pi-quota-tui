// Testes das regras que decidem o que o usuário vê: ritmo, saúde, parsers e reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bar } from "../src/format.ts";
import { health, pace, visible } from "../src/rules.ts";
import { agySnapshot, collapse, estimateReset, nextMonthlyReset, paidIndex, parseAgyAccounts, parseCodex } from "../src/providers.ts";
import type { Snapshot } from "../src/models.ts";

const NOW = 1_700_000_000;

test("ritmo: metade do ciclo de 5h com metade usada fica no ritmo", () => {
  const w = { label: "5 horas", used: 50, resetsAt: NOW + 9000, duration: 18000 };
  assert.equal(pace(w, NOW), 50);
  const s: Snapshot = { id: "x", name: "X", windows: [w], updatedAt: NOW, source: "" };
  assert.equal(health(s, NOW), "MONITORANDO");
});

test("saúde: sem janelas é SEM SINAL; saldo curto para o ciclo é ATENCAO", () => {
  const empty: Snapshot = { id: "x", name: "X", windows: [], source: "" };
  assert.equal(health(empty, NOW), "SEM SINAL");
  const hot: Snapshot = { id: "x", name: "X", windows: [{ label: "Semanal", used: 95 }], updatedAt: NOW, source: "" };
  assert.equal(health(hot, NOW), "ATENCAO");
});

test("codex: janelas 5h/semanal pela duração informada", () => {
  const snap = parseCodex({
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: NOW + 600 },
                                    secondary: { usedPercent: 70, windowDurationMins: 10080 } } },
  }, NOW);
  assert.deepEqual(snap.windows.map((w) => [w.label, w.duration]), [["5 horas", 18000], ["Semanal", 604800]]);
});

test("Antigravity: conta paga escolhida pelo hint e demais contas viram BONUS sem somar", () => {
  const accounts = parseAgyAccounts([
    { email: "a@x", refreshToken: "r" },
    { email: "b@x", refreshToken: "r" },
  ]);
  const groups = (fraction: number) => [{ displayName: "Claude", buckets: [{ window: "5h", remainingFraction: fraction }] }];
  const snaps = [agySnapshot(accounts[0], 0, groups(0.5), NOW), agySnapshot(accounts[1], 1, groups(0.9), NOW)];
  assert.equal(paidIndex(accounts, snaps, "b@x"), 1);
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

test("barra marca o ritmo", () => {
  assert.equal(bar(50, 50, 10), "█████│░░░░");
});

test("visivel: janela esgotada esconde as de baixo (mensal > semanal > 5h)", () => {
  const names = (windows: { label: string; used: number }[]) => visible(windows.map((w) => ({ ...w }))).map((w) => w.label);
  const all = [{ label: "5 horas", used: 10 }, { label: "Semanal", used: 20 }, { label: "Mensal", used: 30 }];
  assert.deepEqual(names(all), ["5 horas", "Semanal", "Mensal"]);
  assert.deepEqual(names([{ ...all[0], used: 100 }, all[1], all[2]]), ["Semanal", "Mensal"]);
  assert.deepEqual(names([all[0], { ...all[1], used: 100 }, all[2]]), ["Mensal"]);
  assert.deepEqual(names([all[0], all[1], { ...all[2], used: 100 }]), []);
  // 99.96 tambem conta: a tela arredonda para 0% restante
  assert.deepEqual(names([all[0], all[1], { ...all[2], used: 99.96 }]), []);
  assert.deepEqual(names([all[0], all[1], { ...all[2], used: 99.4 }]), ["5 horas", "Semanal", "Mensal"]);
  // Rank desconhecido (familias do AGY) nunca some nem esgota o grupo
  const agy = [{ label: "5 horas", used: 100, group: "Gemini" }, { label: "5 horas", used: 5, group: "Claude" },
               { label: "Limite", used: 100, group: "Gemini" }];
  assert.deepEqual(visible(agy).map((w) => w.group + "/" + w.label), ["Claude/5 horas", "Gemini/Limite"]);
});
