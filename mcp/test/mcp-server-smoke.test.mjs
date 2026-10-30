import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBroker } from "../dist/broker.mjs";

const serverPath = fileURLToPath(new URL("../dist/mcp-server.mjs", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
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
  ]);

  const readSlide = tools.find((tool) => tool.name === "read_slide");
  assert.deepEqual(readSlide.inputSchema.required, ["slideIndex"]);
  assert.equal(readSlide.inputSchema.properties.slideIndex.type, "integer");
  assert.equal(readSlide.inputSchema.properties.depth.maximum, 10);
});
