// Smoke: carrega src/index.ts com o jiti do pi e confere o que a extensão registra.
// Não chama modelo nem rede: só o factory, com uma API falsa.
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": piEntry } });
const mod = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname);
const factory = mod.default;
assert.equal(typeof factory, "function", "index.ts precisa exportar uma factory");

const commands = [], tools = [], events = [];
const pi = {
  registerCommand: (name) => commands.push(name),
  registerTool: (tool) => tools.push(tool.name),
  registerEntryRenderer: () => {},
  appendEntry: () => {},
  on: (event) => events.push(event),
};
factory(pi);
assert.deepEqual(commands.sort(), ["quota", "quota-login", "quotas", "usage"]);
assert.deepEqual(tools, ["get_quotas"]);
assert.ok(events.includes("session_start") && events.includes("session_shutdown"));
console.log("smoke ok:", { commands, tools, events });
