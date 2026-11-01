// Painel em lista: até dois provedores por linha, janelas separadas por │ e quebra com recuo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { barColor, QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";

const NOW = Date.now() / 1000;
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();

function panelWith(...snapshots: Snapshot[]) {
  const monitor = new Monitor();
  for (const s of snapshots) {
    (monitor as unknown as { data: Map<string, Snapshot[]> }).data.set(s.id, [s]);
  }
  return { panel: new QuotaPanel(monitor, theme), monitor };
}

const opencode: Snapshot = { id: "opencode", name: "OpenCode Go",
  windows: [{ label: "Semanal", used: 62, resetsAt: NOW + 3600, duration: 604800 }], updatedAt: NOW, source: "x" };

const openai: Snapshot = { id: "openai", name: "OpenAI Codex",
  windows: [{ label: "5 horas", used: 8, resetsAt: NOW + 10000, duration: 18000 }], updatedAt: NOW, source: "x" };

test("lista: sem separador entre o nome do provedor e a primeira janela", () => {
  const { panel, monitor } = panelWith(opencode);
  try {
    const [line] = panel.render(60);
    assert.match(plain(line), /^OpenCode Go [█│]/);
    // Barra de saldo: só blocos e a marca de ritmo, sem porcentagem
    assert.match(line, /[█│]+░/);
    assert.doesNotMatch(plain(line), /\d+%/);
    assert.match(plain(line), /\d+(\.\d)?[hdm]/);
  } finally {
    monitor.stop();
  }
});

test("lista: dois provedores por linha quando cabem, um por linha quando não", () => {
  const wide = panelWith(opencode, openai);
  try {
    const lines = wide.panel.render(120);
    assert.equal(lines.length, 1, "120 colunas cabem dois provedores");
    assert.match(plain(lines[0]), /^OpenCode Go .*OpenAI Codex /);
  } finally {
    wide.monitor.stop();
  }
  const narrow = panelWith(opencode, openai);
  try {
    const lines = narrow.panel.render(50);
    assert.equal(lines.length, 2);
    assert.match(plain(lines[0]), /^OpenCode Go /);
    assert.match(plain(lines[1]), /^OpenAI Codex /);
  } finally {
    narrow.monitor.stop();
  }
});

test("lista: janelas que não cabem quebram com recuo alinhado sob a primeira janela", () => {
  const snapshot: Snapshot = {
    id: "antigravity", name: "Antigravity", updatedAt: NOW, source: "x",
    windows: [
      { label: "Semanal", used: 0.79, resetsAt: NOW + 6 * 86400, duration: 604800, group: "Gemini" },
      { label: "5 horas", used: 0, resetsAt: NOW + 6 * 3600, duration: 18000, group: "Gemini" },
      { label: "Semanal", used: 100, resetsAt: NOW + 2 * 86400, duration: 604800, group: "Claude" },
      { label: "Semanal", used: 98.46, resetsAt: NOW + 2 * 86400, duration: 604800, group: "Argon" },
    ],
  };
  const { panel, monitor } = panelWith(snapshot);
  try {
    const lines = panel.render(40);
    assert.ok(lines.length > 1, "deve quebrar em mais de uma linha");
    assert.match(plain(lines[0]), /^Antigravity Gemini /);
    assert.ok(plain(lines[1]).startsWith(" ".repeat(12)), "recuo = largura de \"Antigravity \"");
    const text = plain(lines.join("\n"));
    for (const family of ["Gemini", "Claude", "Argon"]) assert.ok(text.includes(family), family);
    for (const l of lines) assert.ok(visibleWidth(l) <= 40);
  } finally {
    monitor.stop();
  }
});

test("lista: todas as janelas aparecem, sem corte (Argon é a 5a do AGY)", () => {
  const snapshot: Snapshot = {
    id: "antigravity", name: "Antigravity", updatedAt: NOW, source: "x",
    windows: [
      { label: "Semanal", used: 51, resetsAt: NOW + 3 * 86400, duration: 604800, group: "Gemini" },
      { label: "5 horas", used: 4, resetsAt: NOW + 3 * 3600, duration: 18000, group: "Gemini" },
      { label: "Semanal", used: 10, resetsAt: NOW + 7 * 86400, duration: 604800, group: "Claude" },
      { label: "5 horas", used: 20, resetsAt: NOW + 3 * 3600, duration: 18000, group: "Claude" },
      { label: "Semanal", used: 0, resetsAt: NOW + 7 * 86400, duration: 604800, group: "Argon" },
    ],
  };
  const { panel, monitor } = panelWith(snapshot);
  try {
    const text = plain(panel.render(60).join("\n"));
    assert.match(text, /Argon [█│]/, text);
  } finally {
    monitor.stop();
  }
});

test("lista: nenhum aviso de estado é escrito no painel", () => {
  const stale: Snapshot = { ...opencode, updatedAt: NOW - 600 };
  const broken: Snapshot = { ...openai, windows: [], error: "Fonte indisponível." };
  const { panel, monitor } = panelWith(stale, broken);
  try {
    const text = plain(panel.render(120).join("\n"));
    for (const word of ["DESATUALIZADO", "ATENCAO", "COTA APERTADA", "COOLDOWN", "SEM SINAL", "FOLGA"]) {
      assert.ok(!text.includes(word), word);
    }
  } finally {
    monitor.stop();
  }
});

test("lista: cores de marca por provedor e sem sequências de imagem", () => {
  const { panel, monitor } = panelWith(opencode, openai);
  try {
    const lines = panel.render(120);
    assert.ok(lines.every((l) => !l.includes("\x1b_G")), "nada do protocolo Kitty");
    // OpenAI (verde) recebe cor ANSI; OpenCode é branco = cor padrão do texto do tema
    assert.match(lines[0], /\x1b\[38;2;16;163;127m\x1b\[1mOpenAI Codex/);
    assert.ok(!lines[0].includes("\x1b[38;2;66"));
  } finally {
    monitor.stop();
  }
});

test("lista: provedor sem nenhuma janela não ocupa linha nem some do /quota", () => {
  const semDados: Snapshot = { id: "antigravity", name: "Antigravity", windows: [], source: "x",
    error: "Abra o proxy AGY para consultar as quotas do Antigravity." };
  const { panel, monitor } = panelWith(opencode, semDados);
  try {
    const text = plain(panel.render(120).join("\n"));
    assert.match(text, /OpenCode Go /);
    assert.doesNotMatch(text, /Antigravity/);
  } finally {
    monitor.stop();
  }
});

test("cor da barra indica o ritmo: folga verde, adiantado amarelo, queimando vermelho", () => {
  const w = (used: number) => ({ label: "x", used });
  assert.equal(barColor(w(20), 20), "success");
  assert.equal(barColor(w(15), 40), "success");
  assert.equal(barColor(w(50), 40), "warning");
  assert.equal(barColor(w(80), 40), "error");
  // Sem ritmo (reset/duração desconhecidos), cai no saldo absoluto
  assert.equal(barColor(w(10), undefined), "accent");
  assert.equal(barColor(w(80), undefined), "warning");
  assert.equal(barColor(w(95), undefined), "error");
});
