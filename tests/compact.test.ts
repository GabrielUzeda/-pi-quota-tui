import { test } from "node:test";
import assert from "node:assert/strict";
import { compactReset } from "../src/panel.ts";
test("reset compacto: horas, dias, minutos, estimado e indisponível", () => {
  const now = 1700000000;
  for (const [seconds, expected] of [[11520, "3.2h"], [371520, "4.3d"], [1728000, "20d"], [30, "1m"], [0, "0m"]] as const)
    assert.equal(compactReset({ label: "x", used: 0, resetsAt: now + seconds }, now), expected);
  assert.equal(compactReset({ label: "x", used: 0 }, now), "--");
  assert.equal(compactReset({ label: "x", used: 0, resetsAt: now + 11520, estimated: true }, now), "~3.2h");
});
