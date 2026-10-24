// O painel nunca pode desenhar uma linha mais larga que o terminal (quebra o layout do pi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";

// Tema mínimo: só o que o painel usa. Cores viram nada; a largura é o que importa aqui.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const NOW = Date.now() / 1000;

test("painel: nenhuma linha passa da largura, com e sem provedores", () => {
  const monitor = new Monitor();
  const set = (m: Monitor, snaps: Snapshot[]) => (m as unknown as { data: Map<string, Snapshot[]> }).data.set(snaps[0].pet, snaps);
  const tui = { requestRender() {} } as never;
  const panel = new QuotaPanel(monitor, theme, tui);
  try {
    for (const width of [46, 20]) {
      for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    }
    set(monitor, [{ id: "openai", name: "OpenAI Codex com um nome bem comprido demais", pet: "openai",
      windows: [{ label: "5 horas", used: 97, resetsAt: NOW + 600, duration: 18000 }, { label: "Semanal", used: 40 }],
      updatedAt: NOW, source: "x", note: "uma nota longa que precisa ser cortada para caber no card lateral" }]);
    for (const width of [46, 20]) {
      for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    }
  } finally {
    panel.dispose();
    monitor.stop();
  }
});
