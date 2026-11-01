import { test } from "node:test";
import assert from "node:assert/strict";
import { health } from "../src/rules.ts";
import { parseCodex } from "../src/providers.ts";
const NOW = 1_700_000_000;
const DAY = 86400;
function quota(left: number, days: number) {
  return parseCodex({ rateLimits: { secondary: {
    usedPercent: 100 - left, windowDurationMins: 10080, resetsAt: NOW + days * DAY,
  } } }, NOW);
}
test("saúde compara saldo semanal com tempo restante", () => {
  for (const [left, days, status] of [
    [75, 3, "FOLGA"], [55, 3.5, "MONITORANDO"],
    [83, 5, "MONITORANDO"], [83, 4, "FOLGA"],
    [45, 3.5, "COTA APERTADA"], [30, 3.5, "ATENCAO"],
    [5, 0.1, "FOLGA"], [0, 0.1, "ATENCAO"],
  ] as const) assert.equal(health(quota(left, days), NOW), status, left + "/" + days);
});
test("janela mais apertada prevalece, não soma nem calcula média", () => {
  const s = quota(75, 3);
  s.windows.push({ label: "5 horas", used: 95, resetsAt: NOW + 9000, duration: 18000 });
  assert.equal(health(s, NOW), "ATENCAO");
});
test("sem duração ou reset usa apenas saldo, sem inventar tempo", () => {
  const s = quota(83, 4);
  delete s.windows[0].duration;
  assert.equal(health(s, NOW), "FOLGA");
  s.windows[0].used = 95;
  assert.equal(health(s, NOW), "ATENCAO");
});
