import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBroker } from "../dist/broker.mjs";
import { helloPlugin, send } from "./helpers.mjs";

const serverPath = fileURLToPath(new URL("../dist/mcp-server.mjs", import.meta.url));
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const pkg = JSON.parse(read("../../package.json"));

const TOOLS = [
  "duplicate_slide",
  "execute",
  "get_styleguide",
  "list_decks",
  "list_slides",
  "ping",
  "read_slide",
  "screenshot_presentation",
  "screenshot_slide",
  "update_text",
  "use_deck",
];

// The built server over stdio, the way an MCP client runs it, against an
// in-process broker on a free port so it never spawns the daemon.
async function startServer(t) {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, FIGMA_SLIDES_BROKER_PORT: String(broker.port) },
    stderr: "ignore",
  });
  t.after(async () => {
    await client.close();
    await broker.close();
  });
  await client.connect(transport);
  return { broker, client };
}

const text = (result) => result.content.map((c) => c.text).join("\n");

// The tool handlers are not covered elsewhere: an SDK or zod upgrade that breaks
// tool registration or schema conversion fails here instead of in a user's session.
test("the built server boots over stdio and registers every tool", async (t) => {
  const { client } = await startServer(t);
  const { name, version } = client.getServerVersion();
  assert.deepEqual({ name, version }, { name: "figma-slides", version: pkg.version });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);

  const readSlide = tools.find((tool) => tool.name === "read_slide");
  assert.deepEqual(readSlide.inputSchema.required, ["slideIndex"]);
  assert.equal(readSlide.inputSchema.properties.slideIndex.type, "integer");
  assert.equal(readSlide.inputSchema.properties.depth.maximum, 10);
});

// The tool list is repeated in prose for humans (README), for agents working in
// this repo (CLAUDE.md) and for agents using the server (the skill). The test
// above pins TOOLS to what the server registers; this one keeps the docs in step.
test("every registered tool is documented", () => {
  for (const doc of [
    "../../README.md",
    "../../CLAUDE.md",
    "../../.claude/skills/figma-slides-api/SKILL.md",
  ]) {
    const text = read(doc);
    const missing = TOOLS.filter((tool) => !text.includes(`\`${tool}`));
    assert.deepEqual(
      missing,
      [],
      `${doc.replace("../../", "")} does not mention ${missing.join(", ")}`,
    );
  }
});

test("a deck on an outdated plugin is flagged; one on the shipped plugin is not", async (t) => {
  // What a plugin built from this tree reports: the build step compiles the same
  // fingerprint into the plugin and the server.
  const pluginBuild = read("../dist/figma-plugin/code.js").match(
    /pluginBuild: "([0-9a-f]{12})"/,
  )[1];
  assert.ok(read("../dist/mcp-server.mjs").includes(`"${pluginBuild}"`), "server and plugin agree");

  const { broker, client } = await startServer(t);
  const current = await helloPlugin(
    broker.port,
    "Deck Atual",
    "slides",
    {},
    {
      pluginVersion: pkg.version,
      pluginBuild,
    },
  );
  // A 2.0–2.1 plugin: speaks the protocol, reports no version, lacks newer commands.
  const old = await helloPlugin(broker.port, "Deck Velho");
  old.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id) send(old, { id: msg.id, success: false, error: `Unknown command: ${msg.command}` });
  });
  t.after(() => {
    current.close();
    old.close();
  });

  let decks;
  for (let i = 0; i < 50; i++) {
    decks = await client.callTool({ name: "list_decks", arguments: {} });
    if (text(decks).includes("Deck Velho") && text(decks).includes("Deck Atual")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const notices = decks.content.slice(0, -1).map((c) => c.text);
  assert.equal(notices.length, 1, "only the outdated deck gets a notice");
  assert.match(notices[0], /"Deck Velho" is running an outdated/);
  const listed = JSON.parse(decks.content.at(-1).text);
  assert.equal(listed.find((d) => d.docName === "Deck Atual").pluginVersion, pkg.version);

  // A command the old plugin doesn't know fails with the reason attached.
  const failed = await client.callTool({
    name: "list_slides",
    arguments: { deck: "Velho" },
  });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /Unknown command: list_slides/);
  assert.match(text(failed), /outdated 'Claude Code Slides' plugin/);
});
