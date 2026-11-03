// Painel em lista: até dois provedores por linha, janelas separadas por │ e quebra com recuo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { barColor, QuotaPanel, waitColor } from "../src/panel.ts";
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
    // Claude está com a Semanal esgotada: as janelas somem da lista, mas voltam na linha Expired.
    for (const family of ["Gemini", "Argon"]) assert.ok(text.includes(family), family);
    const [last] = lines.slice(-1);
    assert.match(plain(last), /^Expired: Antigravity Claude 2d$/, plain(last));
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

test("lista: Expired agrupa o que esgotou, do que volta antes para o que volta depois", () => {
  const semanal: Snapshot = { id: "claude", name: "Claude Code", updatedAt: NOW, source: "x",
    windows: [{ label: "Semanal", used: 100, resetsAt: NOW + 4 * 86400, duration: 604800 }] };
  const mensal: Snapshot = { id: "outro", name: "Outro", updatedAt: NOW, source: "x",
    windows: [{ label: "Mensal", used: 100, resetsAt: NOW + 7200 }, { label: "Semanal", used: 20, resetsAt: NOW + 7200 }] };
  const { panel, monitor } = panelWith(opencode, semanal, mensal);
  try {
    const lines = panel.render(60).map(plain);
    // Ordem = quem volta antes; o que esgotou sai da grade mas fica na linha final.
    assert.equal(lines.at(-1), "Expired: Outro 2h │ Claude Code 4d", lines.join("\n"));
    assert.match(lines[0], /^OpenCode Go /);
    assert.doesNotMatch(lines.slice(0, -1).join("\n"), /Outro|Claude Code/, "só o esgotado sai da grade");
  } finally {
    monitor.stop();
  }
});

test("lista: Expired em vermelho, tempo pela rampa do ciclo (verde = volta logo)", () => {
  // 18h de uma semanal e 1.2d de uma semanal: verdes. 12.2d de uma mensal de 30d: vermelho.
  const rgb = (duration: number | undefined, left: number | undefined) => {
    const c = waitColor(duration, left) as { r: number; g: number; b: number };
    return [c.r, c.g, c.b];
  };
  const [r1, g1] = rgb(604800, 18 * 3600);
  assert.ok(g1 > r1, "18h/7d verde: " + [r1, g1]);
  const [r2, g2] = rgb(604800, 1.2 * 86400);
  assert.ok(g2 > r2, "1.2d/7d ainda verde: " + [r2, g2]);
  const [r3, g3] = rgb(30 * 86400, 12.2 * 86400);
  assert.ok(r3 > g3, "12.2d/30d vermelho: " + [r3, g3]);
  // Sem ciclo conhecido, a régua cai para 1h..1d
  const [r4, g4] = rgb(undefined, 1800);
  assert.ok(g4 > r4, "30min sem ciclo é verde");
  const [r5, g5] = rgb(undefined, 2 * 86400);
  assert.ok(r5 > g5, "2d sem ciclo é vermelho");
  assert.equal(waitColor(604800, undefined), "dim");
  // A rampa é contínua: nada de saltos entre marcos
  assert.notDeepEqual(rgb(604800, 3 * 86400), rgb(604800, 3.5 * 86400));
});

test("lista: corrida de cores da linha Expired mantém nome da marca e tag vermelha", () => {
  const marked = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => t } as never;
  const longe: Snapshot = { id: "outro", name: "Outro", updatedAt: NOW, source: "x",
    windows: [{ label: "Semanal", used: 100, resetsAt: NOW + 4 * 86400, duration: 604800 }] };
  const monitor = new Monitor();
  (monitor as unknown as { data: Map<string, Snapshot[]> }).data.set(longe.id, [longe]);
  try {
    const line = new QuotaPanel(monitor, marked).render(80)[0];
    assert.match(line, /^\u001b\[38;2;255;69;58mExpired:\u001b\[39m /);
    // name comes from paintName (brand/default), the wait is an ANSI truecolor escape
    assert.match(line, /Outro \u001b\[38;2;\d+;\d+;\d+m4d/);
  } finally {
    monitor.stop();
  }
});

test("lista: provedor só com cotas esgotadas ainda aparece na linha Expired", () => {
  const dead: Snapshot = { id: "opencode", name: "OpenCode Go", updatedAt: NOW, source: "x",
    windows: [{ label: "Semanal", used: 100, resetsAt: NOW + 1800, duration: 604800 }] };
  const { panel, monitor } = panelWith(dead);
  try {
    assert.match(plain(panel.render(60).at(-1)!), /^Expired: OpenCode Go 3\dm$/);
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
