// Erros de consulta: cada falha vira mensagem segura (sem URL, corpo ou stack) e o provedor continua listado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTORS, ReadError, readJson } from "../src/providers.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";
import { report } from "../src/format.ts";

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const route = req.url ?? "";
    if (route === "/500") {
      res.statusCode = 500;
      res.end("segredo-no-corpo");
    } else if (route === "/401") {
      res.statusCode = 401;
      res.end("{}");
    } else if (route === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/html");
      res.end();
    } else if (route === "/html") {
      res.end("<html>");
    } else if (route === "/array") {
      res.end("[1]");
    } else if (route === "/slow") {
      setTimeout(() => res.end("{}"), 1500);
    } else if (route === "/big") {
      res.end('{"a":"' + "x".repeat(2 * 1024 * 1024 + 10) + '"}');
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

async function errorOf(promise: Promise<unknown>): Promise<ReadError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ReadError, "erro deve ser ReadError: " + String(error));
    return error;
  }
  assert.fail("esperava falha");
}

/** Ambiente isolado: HOME e XDG em pasta temporária, sem chaves reais e sem PATH de Codex. */
async function isolated(extra: Record<string, string | undefined>, fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "nt-home-"));
  const vars: Record<string, string | undefined> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    OPENCODE_GO_KEY: undefined,
    COMMAND_CODE_API_KEY: undefined,
    COMMANDCODE_API_KEY: undefined,
    PI_QUOTA_TUI_AGY_PAID: undefined,
    ...extra,
  };
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn(home);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  }
}

// --- readJson: transporte e validação ---

test("conexão recusada vira mensagem de indisponibilidade", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const error = await errorOf(readJson("http://127.0.0.1:" + port + "/x", { timeout: 2 }));
  assert.equal(error.message, "Fonte indisponível ou tempo de consulta esgotado.");
});

test("HTTP 500 não vaza o corpo da resposta", async () => {
  const error = await errorOf(readJson(base + "/500", { timeout: 2 }));
  assert.equal(error.message, "Consulta recusada (HTTP 500).");
  assert.ok(!error.message.includes("segredo"));
});

test("HTTP 401 e redirecionamento são recusados sem seguir", async () => {
  assert.equal((await errorOf(readJson(base + "/401", { timeout: 2 }))).message, "Consulta recusada (HTTP 401).");
  assert.equal((await errorOf(readJson(base + "/redirect", { timeout: 2 }))).message, "Consulta recusada (HTTP 302).");
});

test("JSON inválido e formato inesperado", async () => {
  assert.equal((await errorOf(readJson(base + "/html", { timeout: 2 }))).message, "Resposta de quota inválida.");
  assert.equal((await errorOf(readJson(base + "/array", { timeout: 2 }))).message, "Formato de quota não reconhecido.");
});

test("tempo esgotado vira mensagem de indisponibilidade", async () => {
  const error = await errorOf(readJson(base + "/slow", { timeout: 0.2 }));
  assert.equal(error.message, "Fonte indisponível ou tempo de consulta esgotado.");
});

test("resposta acima de 2 MiB é cortada durante a leitura", async () => {
  const error = await errorOf(readJson(base + "/big", { timeout: 5 }));
  assert.equal(error.message, "Resposta excede o limite de leitura.");
});

test("URL não permitida é recusada antes de qualquer conexão", async () => {
  for (const url of ["não é url", "ftp://127.0.0.1/x", "http://user:pw@127.0.0.1/x"]) {
    assert.equal((await errorOf(readJson(url, { timeout: 1 }))).message, "Endereço de quota não permitido.");
  }
  assert.equal(
    (await errorOf(readJson("http://example.com/x", { timeout: 1 }))).message,
    "HTTP sem TLS permitido apenas em loopback.",
  );
});

// --- Monitor: o que chega ao relatório ---

const NOW = Date.now() / 1000;
const okSnapshot: Snapshot = {
  id: "opencode", name: "OpenCode Go",
  windows: [{ label: "5 horas", used: 30 }], updatedAt: NOW, source: "x",
};
const offSnapshot = (id: string): Snapshot => ({ id, name: id, windows: [], source: "x", disabled: true });

/** Monitor em que só o OpenCode é controlado; os demais provedores ficam desligados. */
function monitorWith(opencode: () => Promise<Snapshot[]>): Monitor {
  const collectors: Record<string, () => Promise<Snapshot[]>> = {};
  for (const id of Object.keys(COLLECTORS)) collectors[id] = async () => [offSnapshot(id)];
  collectors.opencode = opencode;
  return new Monitor(collectors);
}

test("erro de consulta chega ao relatório com a mensagem específica", async () => {
  const monitor = monitorWith(async () => {
    throw new ReadError("Consulta recusada (HTTP 401).");
  });
  await monitor.refresh();
  const [s] = monitor.snapshots("opencode");
  assert.equal(s.error, "Consulta recusada (HTTP 401).");
  assert.equal(s.disabled, false);
  monitor.stop();
});

test("erro inesperado não vaza detalhes internos", async () => {
  const monitor = monitorWith(async () => {
    throw new TypeError("boom interno");
  });
  await monitor.refresh();
  const [s] = monitor.snapshots("opencode");
  assert.equal(s.error, "Falha interna na leitura; última quota preservada.");
  assert.ok(!(s.error ?? "").includes("boom"));
  monitor.stop();
});

test("falha depois de leitura boa preserva a quota, marcada como antiga", async () => {
  let failing = false;
  const monitor = monitorWith(async () => {
    if (failing) throw new ReadError("Fonte indisponível ou tempo de consulta esgotado.");
    return [okSnapshot];
  });
  await monitor.refresh();
  failing = true;
  await monitor.refresh();
  const [s] = monitor.snapshots("opencode");
  assert.equal(s.windows.length, 1);
  assert.equal(s.stale, true);
  assert.equal(s.error, "Fonte indisponível ou tempo de consulta esgotado.");
  monitor.stop();
});

// --- coletores: erros por provedor ---

test("OpenCode sem chave fica desligado com instrução, não erro", async () => {
  await isolated({}, async () => {
    const [s] = await COLLECTORS.opencode();
    assert.equal(s.disabled, true);
    assert.match(s.error ?? "", /OPENCODE_GO_KEY/);
  });
});

test("Codex ausente no PATH fica desligado com instrução", async () => {
  await isolated({}, async (home) => {
    const empty = join(home, "empty");
    await mkdir(empty);
    await isolated({ PATH: empty }, async () => {
      const [s] = await COLLECTORS.openai();
      assert.equal(s.disabled, true);
      assert.equal(s.error, "Codex CLI não encontrado no PATH.");
    });
  });
});

/** Cria um "codex" falso em pasta própria; o script roda no lugar do binário real. */
async function fakeCodex(home: string, lines: string[]): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex"), ["#!/bin/sh", ...lines].join("\n") + "\n");
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}

test("Codex que encerra sem responder vira erro legível", async () => {
  await isolated({}, async (home) => {
    const bin = await fakeCodex(home, ["exit 0"]);
    await isolated({ PATH: bin }, async () => {
      const error = await errorOf(COLLECTORS.openai());
      assert.equal(error.message, "O Codex não respondeu à leitura de quotas.");
    });
  });
});

test("Codex que recusa a leitura vira erro legível", async () => {
  await isolated({}, async (home) => {
    const bin = await fakeCodex(home, ["read a", "read b", "read c", 'echo \'{"id":2,"error":{"code":-1}}\''] );
    await isolated({ PATH: bin }, async () => {
      const error = await errorOf(COLLECTORS.openai());
      assert.equal(error.message, "O Codex recusou a leitura de quotas.");
    });
  });
});

test("histórico do Claude em formato desconhecido vira erro no relatório", async () => {
  await isolated({}, async (home) => {
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), '{"nope":1}');
    const [s] = await COLLECTORS.claude();
    assert.equal(s.error, "Histórico do Claude em formato desconhecido.");
  });
});

test("Codex ausente some do relatório; outro provedor sem chave continua listado", () => {
  const codexOff: Snapshot = { id: "openai", name: "OpenAI Codex", windows: [], source: "codex app-server",
    error: "Codex CLI não encontrado no PATH.", disabled: true };
  const ocOff: Snapshot = { id: "opencode", name: "OpenCode Go", windows: [], source: "x",
    error: "Defina OPENCODE_GO_KEY.", disabled: true };
  const text = report([codexOff, ocOff], Date.now() / 1000);
  assert.ok(!text.includes("Codex"), "Codex não deve aparecer");
  assert.match(text, /Nao configurado: OpenCode Go\./);
});
