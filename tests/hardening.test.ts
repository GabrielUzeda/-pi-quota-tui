// Endurecimento: entradas hostis, bordas numéricas, falhas de coleta e estados inesperados.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bar, details, report, resolveSource } from "../src/format.ts";
import { countdown, forecast, health, pace, resetText } from "../src/rules.ts";
import { outdated, type Snapshot, type Window } from "../src/models.ts";
import {
  agySnapshot, clamped, collapse, COLLECTORS, epoch, estimateReset, nextMonthlyReset, num, paidIndex, parseAgyAccounts,
  parseCodex, parseCommandcode, parseGroups, parseJson, parseOauthUsage, parseOpencode, readJson, ReadError, secret,
} from "../src/providers.ts";
import { QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";

const NOW = 1_800_000_000;
const bad = (value: unknown) => (async () => value) as unknown as () => Promise<Snapshot[]>;
const ok = (snapshots: Snapshot[]) => async () => snapshots;
const win = (used: number, extra: Partial<Window> = {}): Window => ({ label: "5 horas", used, ...extra });
const snap = (id: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  id, name: id, windows: [win(10)], updatedAt: NOW, source: "teste", ...extra,
});

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Casa temporária vazia: HOME, XDG e chaves isolados; nada real é lido. */
async function sandbox(fn: (home: string) => Promise<void>, extra: Record<string, string | undefined> = {}): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "nt-sandbox-"));
  try {
    await withEnv(
      {
        HOME: home,
        XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"),
        OPENCODE_GO_KEY: undefined,
        COMMAND_CODE_API_KEY: undefined,
        COMMANDCODE_API_KEY: undefined,
        ...extra,
      },
      () => fn(home),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeAuth(home: string, content: string, mode = 0o600): Promise<void> {
  const dir = join(home, ".pi", "agent");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "auth.json");
  await writeFile(file, content);
  await chmod(file, mode);
}

/** Codex falso: cada linha vira um comando do script de shell. */
async function fakeCodex(home: string, lines: string[]): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex"), ["#!/bin/sh", ...lines].join("\n") + "\n");
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}

// --- números, datas e JSON ---

test("num rejeita infinito, negativo, fora do intervalo e texto", () => {
  assert.equal(num(Infinity), undefined);
  assert.equal(num(-1), undefined);
  assert.equal(num(101), undefined);
  assert.equal(num("5"), undefined);
  assert.equal(num(100), 100);
});

test("clamped limita o valor em vez de descartar, mas não aceita texto", () => {
  assert.equal(clamped(150, 0, 100), 100);
  assert.equal(clamped(-3, 0, 100), 0);
  assert.equal(clamped(NaN, 0, 100), undefined);
  assert.equal(clamped(Infinity, 0, 100), undefined);
  assert.equal(clamped("50", 0, 100), undefined);
});

test("epoch aceita segundos, milissegundos e ISO com ou sem fuso", () => {
  assert.equal(epoch(1_800_000_000), 1_800_000_000);
  assert.equal(epoch(1_800_000_000_000), 1_800_000_000);
  assert.equal(epoch("2026-01-01T00:00:00"), Date.UTC(2026, 0, 1) / 1000);
  assert.equal(epoch("2026-01-01T00:00:00-03:00"), Date.UTC(2026, 0, 1, 3) / 1000);
});

test("epoch recusa lixo, zero, negativos, datas absurdas e tipos errados", () => {
  const values: unknown[] = ["nope", "2026-13-45", 0, -5, NaN, 1e16, true, null, {}];
  for (const value of values) assert.equal(epoch(value), undefined, String(value));
});

test("parseJson aceita BOM e rejeita texto que não é JSON", () => {
  assert.deepEqual(parseJson('\uFEFF{"a":1}'), { a: 1 });
  assert.throws(() => parseJson("{nope"), SyntaxError);
});

// --- OpenCode ---

test("OpenCode: percentual acima de 100 vira 100 e abaixo de 0 vira 0", () => {
  const s = parseOpencode({ usage: { rolling: { percent: 150 }, weekly: { percent: -4 } } }, NOW);
  assert.equal(s.windows[0].used, 100);
  assert.equal(s.windows[1].used, 0);
});

test("OpenCode: percentual como texto é ignorado e sem janelas vira erro", () => {
  assert.throws(() => parseOpencode({ usage: { rolling: { percent: "50" } } }, NOW), ReadError);
});

test("OpenCode: usage que não é objeto vira erro", () => {
  assert.throws(() => parseOpencode({ usage: [1, 2] }, NOW), ReadError);
});

test("OpenCode: resposta sem a chave usage usa o próprio objeto", () => {
  const s = parseOpencode({ monthly: { percent: 12 } }, NOW);
  assert.equal(s.windows[0].label, "Mensal");
});

// --- CommandCode ---

test("CommandCode: carteira que não é objeto é ReadError", () => {
  assert.throws(() => parseCommandcode({ credits: "x" }, undefined, NOW), ReadError);
});

test("CommandCode: créditos negativos ou em texto contam como zero", () => {
  const s = parseCommandcode({ credits: { monthlyCredits: -5, purchasedCredits: "9", freeCredits: 2 } }, undefined, NOW);
  assert.match(s.note ?? "", /Saldo 2\.00 /);
});

test("CommandCode: janela mensal fica entre 0 e 100 mesmo com consumo enorme", () => {
  const s = parseCommandcode({ credits: { monthlyCredits: 10 } }, { totalMonthlyCredits: 1e15 }, NOW);
  const mensal = s.windows.find((w) => w.label === "Mensal");
  assert.ok(mensal !== undefined && mensal.used >= 0 && mensal.used <= 100);
  const none = parseCommandcode({ credits: { monthlyCredits: 0 } }, undefined, NOW);
  assert.equal(none.windows.some((w) => w.label === "Mensal"), false);
});

test("CommandCode: janela de 5h com capacidade zero é ignorada", () => {
  const s = parseCommandcode(
    { credits: { monthlyCredits: 1, windowLimits: { fiveHour: { cap: 0, used: 5 } } } }, undefined, NOW);
  assert.equal(s.windows.some((w) => w.label === "5 horas"), false);
  assert.match(s.note ?? "", /sem janela de 5h\/semanal/);
});


test("nextMonthlyReset limita o dia a 1..28", () => {
  const jan20 = Date.UTC(2026, 0, 20) / 1000;
  assert.equal(nextMonthlyReset(31, jan20), Date.UTC(2026, 0, 28) / 1000);
  assert.equal(nextMonthlyReset(0, jan20), Date.UTC(2026, 1, 1) / 1000);
  assert.equal(nextMonthlyReset(-5, jan20), Date.UTC(2026, 1, 1) / 1000);
});

test("nextMonthlyReset: no próprio dia da virada já passa para o mês seguinte; dezembro vira janeiro", () => {
  const jan16 = Date.UTC(2026, 0, 16) / 1000;
  assert.equal(nextMonthlyReset(16, jan16), Date.UTC(2026, 1, 16) / 1000);
  const dec20 = Date.UTC(2026, 11, 20) / 1000;
  assert.equal(nextMonthlyReset(16, dec20), Date.UTC(2027, 0, 16) / 1000);
});

// --- Antigravity / Cloud Code (sem proxy) ---

const agyAccount = (extra: Record<string, unknown> = {}) => ({ email: "a@x", projectId: "p", refreshToken: "r", ...extra });
const agyGroups5h = [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.5 }] }];

test("Antigravity: conta sem refreshToken não entra na lista; lixo não derruba as demais", () => {
  const accounts = parseAgyAccounts([null, 3, "x", { email: "a@x" }, { email: "b@x", refreshToken: "r" }]);
  assert.equal(accounts.length, 1);
  assert.equal(parseAgyAccounts(undefined).length, 0);
});

test("Antigravity: conta vira snapshot com id derivado do e-mail e sem somar percentuais", () => {
  const accounts = parseAgyAccounts([agyAccount()]);
  const s = agySnapshot(accounts[0], 0, agyGroups5h, NOW);
  assert.equal(s.id, "antigravity/" + createHash("sha256").update("a@x").digest("hex").slice(0, 10));
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].used, 50);
  assert.equal(s.source, "Antigravity / Cloud Code");
  assert.match(s.note ?? "", /não são somados/);
  assert.equal(agySnapshot(accounts[0], 0, [], NOW).error, "Conta sem leitura de quota reconhecida.");
});

test("Antigravity: paidIndex usa o hint e, sem ele, a conta com mais janelas lidas", () => {
  const accounts = parseAgyAccounts([agyAccount(), agyAccount({ email: "b@x", projectId: "proj-b" })]);
  const snaps = [agySnapshot(accounts[0], 0, agyGroups5h, NOW), agySnapshot(accounts[1], 1, [], NOW)];
  assert.equal(paidIndex(accounts, snaps, "b@x"), 1);
  assert.equal(paidIndex(accounts, snaps, "proj-b"), 1);
  assert.equal(paidIndex(accounts, snaps, ""), 0);
  // o hash da conta (id do snapshot) também serve de dica
  assert.equal(paidIndex(accounts, snaps, snaps[1].id.split("/")[1]), 1);
});

test("Antigravity: collapse escolhe a paga e resume as outras como BONUS", () => {
  const accounts = parseAgyAccounts([agyAccount(), agyAccount({ email: "b@x" })]);
  const snaps = [agySnapshot(accounts[0], 0, agyGroups5h, NOW), agySnapshot(accounts[1], 1, [], NOW)];
  const merged = collapse(snaps, paidIndex(accounts, snaps, "a@x"), NOW);
  const expected = createHash("sha256").update("a@x").digest("hex").slice(0, 6);
  assert.equal(merged.id, "antigravity");
  assert.match(merged.note ?? "", new RegExp("^PAGA " + expected));
  assert.match(merged.note ?? "", /BONUS 1 contas sem leitura/);
});

test("AGY: parseGroups ignora grupos e buckets inválidos e limita a fração", () => {
  const w = parseGroups([
    null,
    { displayName: 5, buckets: [] },
    { displayName: "Gemini Pro models", buckets: "x" },
    {
      displayName: "Gemini Pro models",
      buckets: [
        { window: "5h", remainingFraction: 2, resetTime: "2026-01-01T00:00:00Z" },
        { window: "5h", remainingFraction: "0.5" },
        { window: "5h", remainingFraction: 0.5, disabled: true },
      ],
    },
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0].used, 0);
  assert.equal(w[0].group, "Gemini Pro");
});

test("AGY: grupo do Argon vira \"Argon\" e mantém a janela semanal", () => {
  const [w] = parseGroups([{
    displayName: "Gemini 4 Argon",
    buckets: [{ window: "weekly", remainingFraction: 0.0154, resetTime: "2026-10-26T14:39:30Z" }],
  }]);
  assert.equal(w.group, "Argon");
  assert.equal(w.label, "Semanal");
  assert.equal(w.duration, 604800);
  assert.ok(Math.abs(w.used - 98.46) < 0.01);
});

// --- Codex ---

test("Codex: percentual acima de 100 vira 100 e duração desconhecida não recebe rótulo de 5 horas", () => {
  const s = parseCodex({
    rateLimits: { primary: { usedPercent: 150, windowDurationMins: 999 }, secondary: { usedPercent: 5, windowDurationMins: 10080 } },
  }, NOW);
  assert.equal(s.windows[0].used, 100);
  assert.equal(s.windows[0].label, "Janela de 999 min");
  assert.equal(s.windows[0].duration, undefined);
  assert.equal(s.windows[1].label, "Semanal");
});

test("Codex: sem limites ou sem percentual utilizável vira erro legível", () => {
  assert.throws(() => parseCodex({}, NOW), /não informou limites/);
  assert.throws(() => parseCodex({ rateLimits: { primary: { usedPercent: "x" } } }, NOW), /sem percentual utilizável/);
});

test("Codex: sem o bucket 'codex' usa o primeiro disponível", () => {
  const s = parseCodex({ rateLimitsByLimitId: { other: { primary: { usedPercent: 33, windowDurationMins: 300 } } } }, NOW);
  assert.equal(s.windows[0].used, 33);
});

test("Codex: contagem de resets que não é inteiro não gera nota", () => {
  const s = parseCodex({ rateLimits: { primary: { usedPercent: 1 } }, rateLimitResetCredits: { availableCount: 1.5 } }, NOW);
  assert.equal(s.note, "");
});

test("Codex: leitura pelo app-server (falso) traz as janelas, mesmo com lixo antes da resposta", () =>
  sandbox(async (home) => {
    const result = '{"id":2,"result":{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":40,"windowDurationMins":300,"resetsAt":1900000000}}},"rateLimitResetCredits":{"availableCount":2}}}';
    const bin = await fakeCodex(home, ["read a", "read b", "read c", "echo 'lixo que não é JSON'", "echo '" + result + "'", "read d"]);
    await withEnv({ PATH: bin }, async () => {
      const [s] = await COLLECTORS.openai();
      assert.equal(s.windows[0].used, 40);
      assert.match(s.note ?? "", /2 reset/);
    });
  }));

test("Codex: chaves de outros provedores não vão para o subprocesso", () =>
  sandbox(async (home) => {
    const bin = await fakeCodex(home, ['echo "OPENCODE_GO_KEY=${OPENCODE_GO_KEY:-ausente}" > "$HOME/leak.txt"']);
    await withEnv({ PATH: bin, OPENCODE_GO_KEY: "chave-secreta" }, async () => {
      await COLLECTORS.openai().catch(() => undefined);
      assert.equal(await readFile(join(home, "leak.txt"), "utf8"), "OPENCODE_GO_KEY=ausente\n");
    });
  }));


test("Claude: sem nenhum dado local fica desligado com a instrução", () =>
  sandbox(async () => {
    const [s] = await COLLECTORS.claude();
    assert.equal(s.disabled, true);
    assert.match(s.error ?? "", /app desktop/);
  }));

test("Claude: histórico corrompido vira erro no relatório, sem derrubar a coleta", () =>
  sandbox(async (home) => {
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), "{garbage");
    const [s] = await COLLECTORS.claude();
    assert.equal(s.error, "Não foi possível ler o histórico do app Claude.");
  }));

test("Claude: histórico com várias contas usa só a conta mais recente", () =>
  sandbox(async (home) => {
    const real = Date.now() / 1000;
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    const samples = [
      { t: (real - 600) * 1000, org: "A", u: { fh: 10 } },
      { t: (real - 60) * 1000, org: "B", u: { fh: 40 } },
    ];
    await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ samples }));
    const [s] = await COLLECTORS.claude();
    assert.equal(s.windows[0].used, 40);
  }));

test("Claude: histórico sem uso registrado não inventa janela e deixa o OAuth assumir", () =>
  sandbox(async (home) => {
    const real = Date.now() / 1000;
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ samples: [{ t: real * 1000, org: "A", u: {} }] }));
    const [s] = await COLLECTORS.claude();
    assert.equal(s.windows.length, 0);
    assert.equal(s.disabled, true);
    assert.match(s.error ?? "", /login/);
  }));

test("Claude: janela de 5h expirada não estima horário de renovação", () =>
  sandbox(async (home) => {
    const real = Date.now() / 1000;
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ samples: [{ t: (real - 40000) * 1000, org: "A", u: { fh: 30 } }] }));
    const [s] = await COLLECTORS.claude();
    assert.equal(s.windows[0].resetsAt, undefined);
    assert.match(s.note ?? "", /janela expirou/);
  }));

test("estimateReset: semanal nunca é inventado", () => {
  const rows = [{ at: NOW - 100, sd: 20 }];
  assert.equal(estimateReset(rows, "sd", 0, NOW, 604800)[0], undefined);
});

test("estimateReset: com a janela iniciando depois de um zero, estima o meio do intervalo + duração", () => {
  const rows = [{ at: NOW - 8000, fh: 0 }, { at: NOW - 1000, fh: 20 }];
  const [resetsAt] = estimateReset(rows, "fh", 1, NOW, 18000);
  assert.equal(resetsAt, NOW - 4500 + 18000);
});

test("estimateReset: sem amostra anterior de referência não estima", () => {
  const rows = [{ at: NOW - 1000, fh: 20 }];
  assert.equal(estimateReset(rows, "fh", 0, NOW, 18000)[0], undefined);
});

// --- Claude: OAuth da assinatura ---

test("OAuth do Claude: utilization e resets_at viram janelas de 5h e semanal", () => {
  const s = parseOauthUsage({
    five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" },
    seven_day: { utilization: 180, resets_at: "2030-01-02T00:00:00Z", locked_reason: "limit" },
    extra_usage: { utilization: 99 },
  }, NOW);
  assert.deepEqual(s.windows.map((w) => [w.label, w.used, w.duration]), [["5 horas", 42, 18000], ["Semanal", 100, 604800]]);
  assert.equal(s.windows[0].resetsAt, Date.parse("2030-01-01T00:00:00Z") / 1000);
  assert.match(s.note ?? "", /bloqueado: Semanal/);
});

test("OAuth do Claude: sem janela reconhecida é ReadError", () => {
  assert.throws(() => parseOauthUsage({ extra_usage: { utilization: 10 }, seven_day_opus: { utilization: 5 } }, NOW), ReadError);
});

// --- credenciais ---

test("secret: auth.json tem prioridade sobre a variável de ambiente", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ "opencode-go": { key: "from-file" } }));
    await withEnv({ OPENCODE_GO_KEY: "from-env" }, async () => {
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "from-file");
    });
  }));

test("secret: sem auth.json a variável de ambiente é o fallback", () =>
  sandbox(async () => {
    await withEnv({ OPENCODE_GO_KEY: "from-env" }, async () => {
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "from-env");
    });
  }));

test("secret: chave em branco no auth.json cai para a variável de ambiente", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ "opencode-go": { key: "   " } }));
    await withEnv({ OPENCODE_GO_KEY: "from-env" }, async () => {
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "from-env");
    });
  }));

test("secret: auth.json com permissão de grupo ou outros é ignorado", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ "opencode-go": { key: "from-file" } }), 0o644);
    assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "");
  }));

test("secret: auth.json corrompido, lista, seção não-objeto ou chave não-texto é ignorado", () =>
  sandbox(async (home) => {
    const cases = ["{nope", "[1]", JSON.stringify({ "opencode-go": "texto" }), JSON.stringify({ "opencode-go": { key: 42 } })];
    for (const content of cases) {
      await writeAuth(home, content);
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "", content);
    }
  }));

test("secret: auth.json com BOM é lido normalmente", () =>
  sandbox(async (home) => {
    await writeAuth(home, "\uFEFF" + JSON.stringify({ "opencode-go": { key: "bom-key" } }));
    assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "bom-key");
  }));

// --- HTTP: casos extras ---

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/204") {
      res.statusCode = 204;
      res.end();
    } else if (req.url === "/null") {
      res.end("null");
    } else if (req.url === "/bom") {
      res.end("\uFEFF" + '{"a":1}');
    } else {
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("readJson: resposta 204 sem corpo é resposta inválida", async () => {
  await assert.rejects(readJson(base + "/204", { timeout: 2 }), { message: "Resposta de quota inválida." });
});

test("readJson: JSON null é formato não reconhecido", async () => {
  await assert.rejects(readJson(base + "/null", { timeout: 2 }), { message: "Formato de quota não reconhecido." });
});

test("readJson: BOM na resposta é aceito", async () => {
  assert.deepEqual(await readJson(base + "/bom", { timeout: 2 }), { a: 1 });
});

test("readJson: localhost e IPv6 em HTTP são recusados (só 127.0.0.1)", async () => {
  for (const url of ["http://localhost:1/x", "http://[::1]:1/x", "http://0.0.0.0:1/x"]) {
    await assert.rejects(readJson(url, { timeout: 1 }), (error: unknown) =>
      error instanceof ReadError && error.message === "HTTP sem TLS permitido apenas em loopback.", url);
  }
});

// --- regras, modelos e relatório ---

test("ritmo: sem reset, sem duração, obsoleto ou já passado não há ritmo", () => {
  assert.equal(pace(win(10), NOW), undefined);
  assert.equal(pace(win(10, { resetsAt: NOW + 100, duration: 18000 }), NOW, true), undefined);
  assert.equal(pace(win(10, { resetsAt: NOW - 5, duration: 18000 }), NOW), undefined);
});

test("previsão: cota esgotada não inventa previsão; sem ritmo fica vazia", () => {
  assert.equal(forecast(win(100, { resetsAt: NOW + 100, duration: 18000 }), NOW), "COTA ESGOTADA; aguardando renovacao");
  assert.equal(forecast(win(10), NOW), "");
});

test("saúde: leitura com erro ou antiga vira DESATUALIZADO", () => {
  assert.equal(health(snap("x", { error: "x" }), NOW), "DESATUALIZADO");
  assert.equal(health(snap("x", { updatedAt: NOW - 600 }), NOW), "DESATUALIZADO");
});

test("outdated: horário no futuro ou reset passado é antiga; desligada nunca é", () => {
  assert.equal(outdated(snap("x", { updatedAt: NOW + 3600 }), NOW), true);
  assert.equal(outdated(snap("x", { windows: [win(1, { resetsAt: NOW - 1 })] }), NOW), true);
  assert.equal(outdated(snap("x", { disabled: true }), NOW), false);
});

test("countdown: zero, dias e horas formatam sem NaN", () => {
  assert.equal(countdown(0), "1min");
  assert.equal(countdown(190800), "2d 5h");
});

test("resetText: sem reset, passado e estimado", () => {
  assert.equal(resetText(win(1), NOW), "RENOVA: horario indisponivel");
  assert.equal(resetText(win(1, { resetsAt: NOW - 5 }), NOW), "AGUARDANDO NOVA LEITURA");
  assert.equal(resetText(win(1, { resetsAt: NOW + 3600 }), NOW), "RENOVA EM 1h 00min");
  assert.equal(resetText(win(1, { resetsAt: NOW + 3600, estimated: true }), NOW), "RENOVA EM ~1h 00min");
});

test("barra: uso acima de 100, referência fora do intervalo e largura mínima não quebram", () => {
  const full = bar(150, undefined, 20);
  assert.equal(full.length, 20);
  assert.ok(!full.includes("░"));
  const ref = bar(-10, 200, 10);
  assert.equal(ref.length, 10);
  assert.ok(ref.endsWith("│"));
  assert.equal(bar(50, -50, 10).indexOf("│"), 0);
  assert.equal(bar(0, undefined, 1).length, 1);
});

test("relatório: lista vazia não quebra; detalhes sem reset ou duração dizem isso", () => {
  assert.match(report([], NOW), /QUOTA WATCH/);
  const lines = details(snap("x", { name: "X", windows: [win(40)] }), NOW);
  assert.ok(lines.some((l) => l.includes("RITMO INDISPONIVEL")));
  assert.ok(lines.some((l) => l.includes("RENOVA: horario indisponivel")));
});

test("resolveSource: nomes herdados de objeto, espaços e maiúsculas", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "cmd", "x y"])
    assert.equal(resolveSource(name).valid, false, name);
  assert.equal(resolveSource("  AGY ").provider, "antigravity");
  assert.equal(resolveSource("ALL").valid, true);
  assert.equal(resolveSource("").valid, true);
  assert.equal(resolveSource("").provider, undefined);
});

// --- Monitor: falhas de coleta ---

test("monitor: falha de um provedor não afeta os outros", async () => {
  const m = new Monitor({
    a: ok([snap("a")]),
    b: async () => {
      throw new TypeError("boom");
    },
  });
  await m.refresh();
  assert.equal(m.snapshots("a")[0].windows.length, 1);
  assert.equal(m.snapshots("b")[0].error, "Falha interna na leitura; última quota preservada.");
  m.stop();
});

test("monitor: resposta inesperada (undefined, objeto, texto, null) vira erro, sem exceção", async () => {
  const values: unknown[] = [undefined, {}, "x", null];
  for (const value of values) {
    const m = new Monitor({ p: bad(value) });
    await m.refresh();
    const [s] = m.snapshots("p");
    assert.ok(s.error, String(value));
    assert.equal(s.disabled, false);
    m.stop();
  }
});

test("monitor: rejeição com texto em vez de Error não vaza o texto", async () => {
  const m = new Monitor({
    p: async () => {
      throw "segredo-token-123";
    },
  });
  await m.refresh();
  const [s] = m.snapshots("p");
  assert.equal(s.error, "Falha interna na leitura; última quota preservada.");
  assert.ok(!(s.error ?? "").includes("segredo"));
  m.stop();
});

test("monitor: coleta presa é encerrada pelo tempo limite", async () => {
  const m = new Monitor({ p: () => new Promise<Snapshot[]>(() => {}) }, 30);
  await m.refresh();
  assert.equal(m.snapshots("p")[0].error, "Consulta excedeu o tempo limite.");
  m.stop();
});

test("monitor: refresh simultâneos reaproveitam uma única coleta", async () => {
  let calls = 0;
  const m = new Monitor({
    p: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [snap("p")];
    },
  });
  await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
  assert.equal(calls, 1);
  m.stop();
});

test("monitor: lista vazia mantém a última leitura marcada como antiga", async () => {
  let next: Snapshot[] = [snap("p")];
  const m = new Monitor({ p: async () => next });
  await m.refresh();
  next = [];
  await m.refresh();
  const [s] = m.snapshots("p");
  assert.equal(s.windows.length, 1);
  assert.equal(s.stale, true);
  assert.equal(s.error, "Nenhuma leitura disponível.");
  m.stop();
});

test("monitor: conta que some da leitura continua visível como antiga", async () => {
  let next: Snapshot[] = [snap("acc1"), snap("acc2")];
  const m = new Monitor({ p: async () => next });
  await m.refresh();
  next = [snap("acc1")];
  await m.refresh();
  const all = m.snapshots("p");
  assert.equal(all.length, 2);
  const gone = all.find((s) => s.id === "acc2");
  assert.equal(gone?.stale, true);
  assert.equal(gone?.error, "Conta ausente na leitura atual.");
  m.stop();
});

test("monitor: leitura boa depois de falha limpa o erro", async () => {
  let failing = true;
  const m = new Monitor({
    p: async () => {
      if (failing) throw new ReadError("Fonte indisponível ou tempo de consulta esgotado.");
      return [snap("p")];
    },
  });
  await m.refresh();
  failing = false;
  await m.refresh();
  const [s] = m.snapshots("p");
  assert.equal(s.error, undefined);
  assert.notEqual(s.stale, true);
  m.stop();
});

test("monitor: start é idempotente, stop pode repetir, provedor desconhecido dá lista vazia", async () => {
  const m = new Monitor({ p: ok([snap("p")]) });
  m.start();
  m.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  m.stop();
  m.stop();
  assert.equal(m.snapshots("p").length, 1);
  assert.deepEqual(m.snapshots("nao-existe"), []);
});

// --- painel ---

const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

test("painel: nenhuma linha passa da largura, de 1 a 60 colunas", async () => {
  const m = new Monitor({
    opencode: ok([snap("opencode", {
      name: "Nome muito longo para caber numa linha estreita de verdade",
      windows: [win(120, { resetsAt: NOW + 4000, duration: 18000 })],
      note: "nota longa ".repeat(10),
    })]),
  });
  await m.refresh();
  const panel = new QuotaPanel(m, fakeTheme);
  for (let width = 1; width <= 60; width++)
    for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, width + ": " + line);
  m.stop();
});

test("painel: provedor desconhecido, nomes de objeto e cartão só com erro renderizam sem quebrar", async () => {
  const m = new Monitor({
    zzz: ok([snap("zzz", { windows: [], error: "x" })]),
    odd: ok([snap("odd", { windows: [], error: "y" })]),
  });
  await m.refresh();
  const panel = new QuotaPanel(m, fakeTheme);
  assert.ok(panel.render(40).length > 0);
  m.stop();
});

