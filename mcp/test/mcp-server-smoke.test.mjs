import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBroker } from "../dist/broker.mjs";

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

// The tool handlers are not covered elsewhere: this boots the built server over
// stdio, the way an MCP client does, so an SDK or zod upgrade that breaks tool
// registration or schema conversion fails here instead of in a user's session.
test("the built server boots over stdio and registers every tool", async (t) => {
  // An in-process broker on a free port, so the server never spawns the daemon.
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
