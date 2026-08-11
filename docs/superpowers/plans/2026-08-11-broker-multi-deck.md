# Broker persistente + multi-deck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the WebSocket server out of the MCP process into a standalone broker daemon so restarting an MCP client never kills the Figma bridge, and route commands to one of several connected decks.

**Architecture:** A dumb broker daemon owns `:3055`, assigns a `connId` per connection and forwards addressed envelopes between controllers (MCP servers) and plugins (Figma decks). The MCP server becomes a broker *client* that auto-spawns the daemon when absent, keeps the target list in memory, and resolves which deck a call targets. All target-selection intelligence lives in the MCP server; ambiguity surfaces to the agent as an error instead of being guessed at in the transport.

**Tech Stack:** Node 20+, TypeScript bundled with esbuild, `ws`, `@modelcontextprotocol/sdk`, `zod`, `node --test` (no new dependencies).

## Global Constraints

- `protocol: 1` on every `hello`. Constant name: `PROTOCOL_VERSION`.
- Default port stays `3055` (`DEFAULT_BROKER_PORT`); overridable via `FIGMA_SLIDES_BROKER_PORT` for tests only.
- `.mcp.json` must NOT change — the registered command stays `node mcp/dist/mcp-server.mjs`.
- Nothing is written into the Figma file (no `setPluginData`).
- `COMMAND_TIMEOUT_MS` stays 15_000, now per request and per target.
- Broker ping interval 20s, drop after 2 consecutive missed pongs, idle shutdown after 30 min with zero clients, `EADDRINUSE` → `process.exit(0)` silently.
- No new runtime dependencies. Tests use the built ESM artifacts under `mcp/dist/`.
- Removed for good: `killStaleProcess()` and the `process.exit(1)` on bind failure in `mcp-server.ts`.

---

## File Structure

| File | Responsibility | State |
|---|---|---|
| `mcp/src/protocol.ts` | Wire constants + envelope types shared by broker, controller, tests. | create |
| `mcp/src/broker.ts` | The daemon. Registry of connections, envelope forwarding, ping reaper, idle shutdown. Exports `startBroker()`; auto-starts when run as `broker.mjs`. | create |
| `mcp/src/target-resolver.ts` | Pure functions: `resolveTarget`, `matchDeck`, `shortId`, `formatCandidates`. No I/O. | create |
| `mcp/src/broker-client.ts` | `BrokerClient` — connects to the broker, spawns it if absent, backoff reconnect, per-request pending map, in-memory target list. | create |
| `mcp/src/mcp-server.ts` | MCP tool surface only. Owns the session-pinned target. | rewrite transport |
| `mcp/figma-plugin/code.ts` | Supplies `figma.root.name` / `figma.editorType`, drives the reconnect tick from the sandbox. | modify |
| `mcp/figma-plugin/ui.html` | Sends `hello`, reconnects on tick + close. | modify |
| `mcp/build.mjs` | Four node bundles instead of one. | modify |
| `mcp/test/helpers.mjs` | Test helpers: free port, raw ws client, `nextMessage`, `waitFor`. | create |
| `mcp/test/target-resolver.test.mjs` | Four resolution branches + `matchDeck`. | create |
| `mcp/test/broker-routing.test.mjs` | Response reaches only the originating controller. | create |
| `mcp/test/broker-bind-race.test.mjs` | Two daemons race, loser exits 0 silently. | create |
| `mcp/test/broker-reaper.test.mjs` | Non-ponging client leaves `targets`. | create |
| `mcp/test/broker-client.test.mjs` | Per-target rejection. | create |
| `package.json` | `test` script. | modify |
| `README.md`, `CLAUDE.md` | Document the new tools and the daemon. | modify |

---

### Task 1: Wire protocol module

**Files:**
- Create: `mcp/src/protocol.ts`

**Interfaces:**
- Produces: `PROTOCOL_VERSION: number`, `DEFAULT_BROKER_PORT: number`, `interface TargetInfo { connId: string; docName: string; editorType: string }`, and envelope types `CommandMessage`, `TargetsMessage`, `ResponseMessage`, `ErrorMessage`, `BrokerErrorCode`.

- [x] **Step 1: Create the module**

```ts
// Wire protocol shared by the broker, the MCP server (controller) and the plugin UI.
// Every `hello` carries `protocol`; a mismatch is a hard stop, not a degraded mode.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BROKER_PORT = 3055;

export interface TargetInfo {
  connId: string;
  docName: string;
  editorType: string;
}

export interface PluginHello {
  type: "hello";
  role: "plugin";
  protocol: number;
  docName?: string;
  editorType?: string;
}

export interface ControllerHello {
  type: "hello";
  role: "controller";
  protocol: number;
}

export interface CommandMessage {
  type: "command";
  id: string;
  target: string;
  command: string;
  params: Record<string, unknown>;
}

export interface TargetsMessage {
  type: "targets";
  targets: TargetInfo[];
}

export interface ResponseMessage {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type BrokerErrorCode = "no_such_target" | "target_disconnected" | "protocol_mismatch";

export interface ErrorMessage {
  type: "error";
  code: BrokerErrorCode;
  id?: string;
  error?: string;
  brokerProtocol?: number;
}
```

- [x] **Step 2: Commit**

```bash
git add mcp/src/protocol.ts
git commit -m "feat(mcp): add shared broker wire protocol module"
```

---

### Task 2: Target resolution (pure logic, TDD)

**Files:**
- Create: `mcp/src/target-resolver.ts`
- Create: `mcp/test/target-resolver.test.mjs`
- Modify: `mcp/build.mjs` (add the node-bundle factory and the four entries)
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: `TargetInfo` from `./protocol`.
- Produces:
  - `type ResolveOutcome = { ok: true; connId: string } | { ok: false; error: string }`
  - `shortId(connId: string): string` — first 8 chars.
  - `formatCandidates(targets: TargetInfo[]): string`
  - `matchDeck(targets: TargetInfo[], deck: string): ResolveOutcome`
  - `resolveTarget(targets: TargetInfo[], explicitDeck: string | undefined, pinnedConnId: string | null): ResolveOutcome`
  - `NO_DECKS_ERROR: string`

- [x] **Step 1: Rewrite `mcp/build.mjs` so every `src/*.ts` module gets its own ESM bundle**

```js
import * as esbuild from "esbuild";
import { builtinModules } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Every Node-side module is bundled on its own so the broker can be spawned
// standalone and the tests can import the pure modules without booting a server.
function nodeBuild(entry, outfile) {
  return {
    entryPoints: [path.join(__dirname, entry)],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: path.join(__dirname, outfile),
    external: builtinModules.flatMap((m) => [m, `node:${m}`]),
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire } from "module";',
        "const require = createRequire(import.meta.url);",
      ].join("\n"),
    },
    sourcemap: true,
  };
}

const nodeBuilds = [
  nodeBuild("src/mcp-server.ts", "dist/mcp-server.mjs"),
  nodeBuild("src/broker.ts", "dist/broker.mjs"),
  nodeBuild("src/broker-client.ts", "dist/broker-client.mjs"),
  nodeBuild("src/target-resolver.ts", "dist/target-resolver.mjs"),
];

// Bundle the Figma plugin sandbox code
const pluginBuild = {
  entryPoints: [path.join(__dirname, "figma-plugin/code.ts")],
  bundle: true,
  platform: "browser",
  target: "es2017",
  format: "iife",
  outfile: path.join(__dirname, "dist/figma-plugin/code.js"),
  sourcemap: false,
};

// Copy static plugin files
function copyPluginFiles() {
  const pluginDist = path.join(__dirname, "dist/figma-plugin");
  fs.mkdirSync(pluginDist, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "figma-plugin/manifest.json"),
    path.join(pluginDist, "manifest.json")
  );
  fs.copyFileSync(
    path.join(__dirname, "figma-plugin/ui.html"),
    path.join(pluginDist, "ui.html")
  );
  console.log("Copied plugin static files");
}

async function build() {
  if (watch) {
    for (const config of [...nodeBuilds, pluginBuild]) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    copyPluginFiles();
    console.log("Watching for changes...");
  } else {
    for (const config of [...nodeBuilds, pluginBuild]) {
      await esbuild.build(config);
    }
    copyPluginFiles();
    // Make server executable
    fs.chmodSync(path.join(__dirname, "dist/mcp-server.mjs"), 0o755);
    console.log("Build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [x] **Step 2: Add the `test` script to `package.json`**

In `"scripts"`, after `"dev:mcp"`, add:

```json
"test": "npm run build:mcp && node --test \"mcp/test/*.test.mjs\""
```

- [x] **Step 3: Write the failing test** — `mcp/test/target-resolver.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget, matchDeck, shortId } from "../dist/target-resolver.mjs";

const A = { connId: "a3f1aaaa-1111-4111-8111-111111111111", docName: "Deck de Vendas", editorType: "slides" };
const B = { connId: "b7c2bbbb-2222-4222-8222-222222222222", docName: "Deck de Produto", editorType: "slides" };
const B2 = { connId: "c9d3cccc-3333-4333-8333-333333333333", docName: "Deck de Produto", editorType: "slides" };

test("branch 1: explicit deck wins over the pinned target", () => {
  const out = resolveTarget([A, B], "Vendas", B.connId);
  assert.deepEqual(out, { ok: true, connId: A.connId });
});

test("branch 2: pinned target is used when still connected", () => {
  const out = resolveTarget([A, B], undefined, B.connId);
  assert.deepEqual(out, { ok: true, connId: B.connId });
});

test("branch 2: a pinned target that disconnected falls through", () => {
  const out = resolveTarget([A], undefined, B.connId);
  assert.deepEqual(out, { ok: true, connId: A.connId });
});

test("branch 3: exactly one deck auto-selects", () => {
  const out = resolveTarget([A], undefined, null);
  assert.deepEqual(out, { ok: true, connId: A.connId });
});

test("branch 4: two decks and no hint is an error listing candidates", () => {
  const out = resolveTarget([A, B], undefined, null);
  assert.equal(out.ok, false);
  assert.match(out.error, /Ambiguous target: 2 decks connected/);
  assert.match(out.error, /Deck de Vendas/);
  assert.match(out.error, /Deck de Produto/);
  assert.match(out.error, /use_deck/);
});

test("no decks connected points at the plugin", () => {
  const out = resolveTarget([], undefined, null);
  assert.equal(out.ok, false);
  assert.match(out.error, /Claude Code Slides/);
  assert.match(out.error, /Plugins > Development/);
});

test("matchDeck resolves a full connId", () => {
  assert.deepEqual(matchDeck([A, B], B.connId), { ok: true, connId: B.connId });
});

test("matchDeck resolves a connId prefix", () => {
  assert.deepEqual(matchDeck([A, B], "b7c2"), { ok: true, connId: B.connId });
});

test("matchDeck is case-insensitive on the doc name", () => {
  assert.deepEqual(matchDeck([A, B], "vendas"), { ok: true, connId: A.connId });
});

test("matchDeck reports candidates when a name fragment is ambiguous", () => {
  const out = matchDeck([A, B, B2], "Produto");
  assert.equal(out.ok, false);
  assert.match(out.error, /Ambiguous deck "Produto": 2/);
  assert.match(out.error, new RegExp(shortId(B.connId)));
  assert.match(out.error, new RegExp(shortId(B2.connId)));
});

test("matchDeck reports the connected decks when nothing matches", () => {
  const out = matchDeck([A, B], "Marketing");
  assert.equal(out.ok, false);
  assert.match(out.error, /No connected deck matches "Marketing"/);
  assert.match(out.error, /Deck de Vendas/);
});

test("shortId is the first 8 characters", () => {
  assert.equal(shortId(A.connId), "a3f1aaaa");
});
```

- [x] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../dist/target-resolver.mjs`

- [x] **Step 5: Implement `mcp/src/target-resolver.ts`**

```ts
// Which deck does this call target? Pure decision logic — no sockets, no I/O.
// Branch 4 is the point of the whole module: with two decks and no hint the
// tool refuses to act and hands the candidates back to the agent.

import type { TargetInfo } from "./protocol";

export type ResolveOutcome = { ok: true; connId: string } | { ok: false; error: string };

export const NO_DECKS_ERROR =
  "No Figma deck is connected. Open the 'Claude Code Slides' plugin in Figma Slides (Plugins > Development).";

export function shortId(connId: string): string {
  return connId.slice(0, 8);
}

export function formatCandidates(targets: TargetInfo[]): string {
  return targets.map((t) => `  - "${t.docName}" (${shortId(t.connId)})`).join("\n");
}

export function matchDeck(targets: TargetInfo[], deck: string): ResolveOutcome {
  if (targets.length === 0) return { ok: false, error: NO_DECKS_ERROR };

  const needle = deck.trim();
  const exact = targets.find((t) => t.connId === needle);
  if (exact) return { ok: true, connId: exact.connId };

  const byId = targets.filter((t) => t.connId.startsWith(needle));
  if (byId.length === 1) return { ok: true, connId: byId[0].connId };

  const lower = needle.toLowerCase();
  const byName = targets.filter((t) => t.docName.toLowerCase().includes(lower));
  if (byName.length === 1) return { ok: true, connId: byName[0].connId };

  const ambiguous = byName.length > 1 ? byName : byId;
  if (ambiguous.length > 1) {
    return {
      ok: false,
      error: `Ambiguous deck "${deck}": ${ambiguous.length} connected decks match.\n${formatCandidates(ambiguous)}`,
    };
  }

  return {
    ok: false,
    error: `No connected deck matches "${deck}". Connected decks:\n${formatCandidates(targets)}`,
  };
}

export function resolveTarget(
  targets: TargetInfo[],
  explicitDeck: string | undefined,
  pinnedConnId: string | null
): ResolveOutcome {
  if (explicitDeck) return matchDeck(targets, explicitDeck);
  if (targets.length === 0) return { ok: false, error: NO_DECKS_ERROR };
  if (pinnedConnId && targets.some((t) => t.connId === pinnedConnId)) {
    return { ok: true, connId: pinnedConnId };
  }
  if (targets.length === 1) return { ok: true, connId: targets[0].connId };

  return {
    ok: false,
    error:
      `Ambiguous target: ${targets.length} decks connected. Pass \`deck\` or call use_deck first.\n` +
      formatCandidates(targets),
  };
}
```

- [x] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 12 tests.

- [x] **Step 7: Commit**

```bash
git add mcp/build.mjs package.json mcp/src/target-resolver.ts mcp/test/target-resolver.test.mjs
git commit -m "feat(mcp): add deck target resolution with ambiguity errors"
```

---

### Task 3: Broker daemon — routing

**Files:**
- Create: `mcp/src/broker.ts`
- Create: `mcp/test/helpers.mjs`
- Create: `mcp/test/broker-routing.test.mjs`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION`, `DEFAULT_BROKER_PORT`, `TargetInfo` from `./protocol`.
- Produces:
  - `startBroker(options?: BrokerOptions): Promise<BrokerHandle>`
  - `interface BrokerOptions { port?: number; pingIntervalMs?: number; maxMissedPongs?: number; idleShutdownMs?: number; onIdleShutdown?: () => void }`
  - `interface BrokerHandle { port: number; close(): Promise<void> }`

- [x] **Step 1: Write the test helpers** — `mcp/test/helpers.mjs`

```js
import net from "node:net";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../dist/protocol-constants.mjs";

export const PROTOCOL = PROTOCOL_VERSION;

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function connectRaw(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, opts);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

export function nextMessage(ws, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for a matching message"));
    }, timeoutMs);
    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
  });
}

export function collect(ws, predicate = () => true) {
  const seen = [];
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (predicate(msg)) seen.push(msg);
  });
  return seen;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function helloPlugin(port, docName, editorType = "slides", opts = {}) {
  const ws = await connectRaw(port, opts);
  send(ws, { type: "hello", role: "plugin", protocol: PROTOCOL, docName, editorType });
  return ws;
}

export async function helloController(port) {
  const ws = await connectRaw(port);
  const first = nextMessage(ws, (m) => m.type === "targets");
  send(ws, { type: "hello", role: "controller", protocol: PROTOCOL });
  await first;
  return ws;
}

export function waitForTargets(ws, count, timeoutMs = 3000) {
  return nextMessage(ws, (m) => m.type === "targets" && m.targets.length === count, timeoutMs);
}
```

Note: `helpers.mjs` imports `PROTOCOL_VERSION` from `../dist/protocol-constants.mjs`. Add that bundle in Step 2 below so the tests never hardcode the version.

- [x] **Step 2: Add the protocol bundle to `mcp/build.mjs`**

In the `nodeBuilds` array, add a fifth entry after `target-resolver`:

```js
  nodeBuild("src/protocol.ts", "dist/protocol-constants.mjs"),
```

- [x] **Step 3: Write the failing test** — `mcp/test/broker-routing.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../dist/broker.mjs";
import {
  PROTOCOL,
  collect,
  delay,
  helloController,
  helloPlugin,
  nextMessage,
  send,
  waitForTargets,
  connectRaw,
} from "./helpers.mjs";

test("a response goes only to the controller that issued the command", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  t.after(() => broker.close());

  const controller1 = await helloController(broker.port);
  const controller2 = await helloController(broker.port);

  const twoTargets = waitForTargets(controller1, 2);
  const pluginA = await helloPlugin(broker.port, "Deck A");
  const pluginB = await helloPlugin(broker.port, "Deck B");
  const { targets } = await twoTargets;

  const a = targets.find((x) => x.docName === "Deck A");
  const b = targets.find((x) => x.docName === "Deck B");
  assert.ok(a && b, "both decks are registered");
  assert.equal(a.editorType, "slides");

  const eavesdropped = collect(controller2, (m) => m.type !== "targets");

  pluginA.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.command === "execute") send(pluginA, { id: msg.id, success: true, data: "from A" });
  });
  pluginB.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.command === "execute") send(pluginB, { id: msg.id, success: true, data: "from B" });
  });

  const answer = nextMessage(controller1, (m) => m.type === "response" && m.id === "req_x1");
  send(controller1, {
    type: "command",
    id: "req_x1",
    target: a.connId,
    command: "execute",
    params: { code: "1" },
  });
  const response = await answer;

  assert.equal(response.success, true);
  assert.equal(response.data, "from A");

  await delay(150);
  assert.deepEqual(eavesdropped, [], "the other controller saw no command traffic");

  pluginA.close();
  pluginB.close();
  controller1.close();
  controller2.close();
});

test("an unknown target comes back as no_such_target with the original id", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const err = nextMessage(controller, (m) => m.type === "error");
  send(controller, { type: "command", id: "req_y1", target: "nope", command: "execute", params: {} });
  const message = await err;

  assert.equal(message.code, "no_such_target");
  assert.equal(message.id, "req_y1");
  controller.close();
});

test("a plugin that drops mid-flight yields target_disconnected", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const oneTarget = waitForTargets(controller, 1);
  const plugin = await helloPlugin(broker.port, "Deck A");
  const { targets } = await oneTarget;

  const delivered = nextMessage(plugin, (m) => m.command === "execute");
  send(controller, {
    type: "command",
    id: "req_z1",
    target: targets[0].connId,
    command: "execute",
    params: {},
  });
  await delivered;

  const err = nextMessage(controller, (m) => m.type === "error");
  plugin.terminate();
  const message = await err;

  assert.equal(message.code, "target_disconnected");
  assert.equal(message.id, "req_z1");
  controller.close();
});

test("a hello with the wrong protocol is refused before anything else", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  t.after(() => broker.close());

  const ws = await connectRaw(broker.port);
  const err = nextMessage(ws, (m) => m.type === "error");
  send(ws, { type: "hello", role: "plugin", protocol: PROTOCOL + 1, docName: "Old" });
  const message = await err;

  assert.equal(message.code, "protocol_mismatch");
  assert.equal(message.brokerProtocol, PROTOCOL);
});
```

- [x] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../dist/broker.mjs`

- [x] **Step 5: Implement `mcp/src/broker.ts`**

```ts
// figma-slides broker — the daemon that owns :3055.
//
// It is deliberately dumb: it knows nothing about slides, never interprets a
// command and never picks a target. It keeps a registry of connections and
// forwards addressed envelopes. All selection intelligence lives in the MCP
// server, which is what lets ambiguity travel up to the agent instead of being
// guessed at down here.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_BROKER_PORT, PROTOCOL_VERSION, type TargetInfo } from "./protocol";

export interface BrokerOptions {
  port?: number;
  pingIntervalMs?: number;
  maxMissedPongs?: number;
  idleShutdownMs?: number;
  onIdleShutdown?: () => void;
}

export interface BrokerHandle {
  port: number;
  close(): Promise<void>;
}

interface PluginConn {
  connId: string;
  ws: WebSocket;
  docName: string;
  editorType: string;
}

interface Route {
  controllerId: string;
  target: string;
  replyId: string;
}

export function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  const port = options.port ?? DEFAULT_BROKER_PORT;
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const maxMissedPongs = options.maxMissedPongs ?? 2;
  const idleShutdownMs = options.idleShutdownMs ?? 30 * 60_000;
  const onIdleShutdown = options.onIdleShutdown ?? (() => process.exit(0));

  const plugins = new Map<string, PluginConn>();
  const controllers = new Map<string, WebSocket>();
  const routes = new Map<string, Route>();
  const missedPongs = new WeakMap<WebSocket, number>();
  let lastActive = Date.now();
  let wireCounter = 0;

  function send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function targetList(): TargetInfo[] {
    return [...plugins.values()].map((p) => ({
      connId: p.connId,
      docName: p.docName,
      editorType: p.editorType,
    }));
  }

  function broadcastTargets(): void {
    const msg = { type: "targets", targets: targetList() };
    for (const ws of controllers.values()) send(ws, msg);
  }

  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    missedPongs.set(ws, 0);
    lastActive = Date.now();
    let identity: { role: "plugin" | "controller"; connId: string } | null = null;

    ws.on("pong", () => missedPongs.set(ws, 0));
    ws.on("error", () => {
      // 'close' always follows; nothing useful to do with the error itself.
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "hello") {
        if (identity) return;
        if (msg.protocol !== PROTOCOL_VERSION) {
          send(ws, { type: "error", code: "protocol_mismatch", brokerProtocol: PROTOCOL_VERSION });
          ws.close();
          return;
        }
        const connId = randomUUID();
        if (msg.role === "plugin") {
          identity = { role: "plugin", connId };
          plugins.set(connId, {
            connId,
            ws,
            docName: typeof msg.docName === "string" && msg.docName ? msg.docName : "Untitled",
            editorType: typeof msg.editorType === "string" ? msg.editorType : "unknown",
          });
          broadcastTargets();
        } else if (msg.role === "controller") {
          identity = { role: "controller", connId };
          controllers.set(connId, ws);
          send(ws, { type: "targets", targets: targetList() });
        } else {
          ws.close();
        }
        return;
      }

      if (!identity) return;

      if (identity.role === "controller" && msg.type === "command") {
        if (typeof msg.id !== "string") return;
        const plugin = plugins.get(msg.target);
        if (!plugin) {
          send(ws, {
            type: "error",
            id: msg.id,
            code: "no_such_target",
            error: `No connected deck with id "${msg.target}".`,
          });
          return;
        }
        // Two controllers pick request ids independently, so ids can collide on
        // the wire. Rename on collision and map back on the way out.
        const wireId = routes.has(msg.id) ? `${msg.id}~${++wireCounter}` : msg.id;
        routes.set(wireId, { controllerId: identity.connId, target: msg.target, replyId: msg.id });
        send(plugin.ws, { id: wireId, command: msg.command, params: msg.params ?? {} });
        return;
      }

      if (identity.role === "plugin" && typeof msg.id === "string") {
        const route = routes.get(msg.id);
        if (!route || route.target !== identity.connId) return;
        routes.delete(msg.id);
        const controller = controllers.get(route.controllerId);
        if (!controller) return;
        send(controller, {
          type: "response",
          id: route.replyId,
          success: msg.success !== false,
          data: msg.data,
          error: msg.error,
        });
      }
    });

    ws.on("close", () => {
      if (!identity) return;
      if (identity.role === "plugin") {
        plugins.delete(identity.connId);
        // Reject only this target's in-flight work. A second deck's commands
        // keep flying.
        for (const [wireId, route] of [...routes]) {
          if (route.target !== identity.connId) continue;
          routes.delete(wireId);
          const controller = controllers.get(route.controllerId);
          if (controller) {
            send(controller, {
              type: "error",
              id: route.replyId,
              code: "target_disconnected",
              error: "The Figma plugin for this deck disconnected before answering.",
            });
          }
        }
        broadcastTargets();
      } else {
        controllers.delete(identity.connId);
        for (const [wireId, route] of [...routes]) {
          if (route.controllerId === identity.connId) routes.delete(wireId);
        }
      }
    });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongs.get(ws) ?? 0;
      if (missed >= maxMissedPongs) {
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, missed + 1);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
    if (plugins.size > 0 || controllers.size > 0) {
      lastActive = Date.now();
    } else if (Date.now() - lastActive >= idleShutdownMs) {
      onIdleShutdown();
    }
  }, pingIntervalMs);
  timer.unref?.();

  function close(): Promise<void> {
    clearInterval(timer);
    return new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    });
  }

  return new Promise((resolve, reject) => {
    wss.once("listening", () => {
      const addr = wss.address();
      wss.on("error", (err) => console.error(`[figma-slides-broker] ${err.message}`));
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, close });
    });
    wss.once("error", (err) => {
      clearInterval(timer);
      reject(err);
    });
  });
}

// Auto-start only when this bundle is the process entry point. Tests import
// startBroker() from the same file and must not get a listening socket.
if (path.basename(process.argv[1] ?? "") === "broker.mjs") {
  const envPort = Number(process.env.FIGMA_SLIDES_BROKER_PORT);
  startBroker({ port: Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_BROKER_PORT }).then(
    (handle) => {
      console.error(`[figma-slides-broker] listening on ws://localhost:${handle.port}`);
    },
    (err: NodeJS.ErrnoException) => {
      // Losing the race for the port is the expected outcome when two MCP
      // servers start together: another broker won and is already serving.
      if (err.code === "EADDRINUSE") process.exit(0);
      console.error(`[figma-slides-broker] Fatal: ${err.message}`);
      process.exit(1);
    }
  );
}
```

- [x] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — the four routing tests plus Task 2's tests.

- [x] **Step 7: Commit**

```bash
git add mcp/src/broker.ts mcp/test/helpers.mjs mcp/test/broker-routing.test.mjs mcp/build.mjs
git commit -m "feat(mcp): add broker daemon with per-controller envelope routing"
```

---

### Task 4: Broker lifecycle — bind race and zombie reaper

**Files:**
- Create: `mcp/test/broker-bind-race.test.mjs`
- Create: `mcp/test/broker-reaper.test.mjs`

**Interfaces:**
- Consumes: `startBroker` from `../dist/broker.mjs`; `freePort`, `helloController`, `helloPlugin`, `waitForTargets` from `./helpers.mjs`.
- Produces: nothing — behaviour already implemented in Task 3, these tests lock it in.

- [x] **Step 1: Write the bind-race test** — `mcp/test/broker-bind-race.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delay, freePort } from "./helpers.mjs";

const brokerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "broker.mjs"
);

function spawnBroker(port) {
  const child = spawn(process.execPath, [brokerPath], {
    env: { ...process.env, FIGMA_SLIDES_BROKER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (d) => (child.stdoutText += d.toString()));
  child.stderr.on("data", (d) => (child.stderrText += d.toString()));
  child.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return child;
}

test("two brokers racing for the port: one wins, the loser exits 0 in silence", async () => {
  const port = await freePort();
  const first = spawnBroker(port);
  const second = spawnBroker(port);

  await delay(1500);

  const alive = [first, second].filter((c) => c.exitCode === null);
  const dead = [first, second].filter((c) => c.exitCode !== null);

  assert.equal(alive.length, 1, "exactly one broker keeps the port");
  assert.equal(dead.length, 1, "exactly one broker steps aside");
  assert.equal(dead[0].exitCode, 0, "the loser exits 0");
  assert.equal(dead[0].stdoutText, "", "the loser prints nothing on stdout");
  assert.equal(dead[0].stderrText, "", "the loser prints nothing on stderr");

  alive[0].kill("SIGTERM");
  await alive[0].exited;
});
```

- [x] **Step 2: Write the reaper test** — `mcp/test/broker-reaper.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../dist/broker.mjs";
import { helloController, helloPlugin, waitForTargets } from "./helpers.mjs";

test("a client that stops answering pongs is dropped from targets", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60, maxMissedPongs: 2 });
  t.after(() => broker.close());

  const controller = await helloController(broker.port);

  const registered = waitForTargets(controller, 1);
  // autoPong: false makes the client look alive at the socket level while never
  // answering a ping — exactly the zombie the reaper exists for.
  const zombie = await helloPlugin(broker.port, "Zombie Deck", "slides", { autoPong: false });
  await registered;

  const reaped = await waitForTargets(controller, 0, 3000);
  assert.deepEqual(reaped.targets, []);

  zombie.terminate();
  controller.close();
});
```

- [x] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS — bind race and reaper included.

- [x] **Step 4: Commit**

```bash
git add mcp/test/broker-bind-race.test.mjs mcp/test/broker-reaper.test.mjs
git commit -m "test(mcp): cover broker bind race and zombie connection reaping"
```

---

### Task 5: Broker client (controller transport)

**Files:**
- Create: `mcp/src/broker-client.ts`
- Create: `mcp/test/broker-client.test.mjs`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION`, `DEFAULT_BROKER_PORT`, `TargetInfo` from `./protocol`.
- Produces:
  - `class BrokerClient`
    - `constructor(options?: BrokerClientOptions)`
    - `start(): void` — begins connecting; never throws, never blocks.
    - `ready(timeoutMs: number): Promise<boolean>` — resolves true once the socket is open and the first `targets` frame landed.
    - `getTargets(): TargetInfo[]`
    - `send(target: string, command: string, params: Record<string, unknown>): Promise<unknown>`
    - `close(): void`
    - `protocolError: string | null`
  - `interface BrokerClientOptions { port?: number; autoSpawn?: boolean; commandTimeoutMs?: number; log?: (msg: string) => void }`

- [x] **Step 1: Write the failing test** — `mcp/test/broker-client.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../dist/broker.mjs";
import { BrokerClient } from "../dist/broker-client.mjs";
import { helloPlugin, nextMessage, send } from "./helpers.mjs";

async function waitForTargetCount(client, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.getTargets().length === count) return client.getTargets();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`targets never reached ${count} (saw ${client.getTargets().length})`);
}

test("one deck dropping does not reject the other deck's in-flight command", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  const client = new BrokerClient({ port: broker.port, autoSpawn: false, commandTimeoutMs: 5000 });
  t.after(async () => {
    client.close();
    await broker.close();
  });

  client.start();
  assert.equal(await client.ready(3000), true);

  const pluginA = await helloPlugin(broker.port, "Deck A");
  const pluginB = await helloPlugin(broker.port, "Deck B");
  const targets = await waitForTargetCount(client, 2);

  const a = targets.find((x) => x.docName === "Deck A");
  const b = targets.find((x) => x.docName === "Deck B");

  // A never answers; B does.
  pluginB.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.command === "execute") send(pluginB, { id: msg.id, success: true, data: "B is fine" });
  });

  const deliveredToA = nextMessage(pluginA, (m) => m.command === "execute");
  const fromA = client.send(a.connId, "execute", { code: "1" });
  const fromB = client.send(b.connId, "execute", { code: "2" });

  await deliveredToA;
  pluginA.terminate();

  await assert.rejects(fromA, /disconnected/i);
  assert.equal(await fromB, "B is fine");

  pluginB.close();
});

test("sending to an unknown deck rejects with the broker's reason", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  const client = new BrokerClient({ port: broker.port, autoSpawn: false, commandTimeoutMs: 5000 });
  t.after(async () => {
    client.close();
    await broker.close();
  });

  client.start();
  await client.ready(3000);
  await assert.rejects(client.send("ghost", "execute", {}), /No connected deck/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../dist/broker-client.mjs`

- [x] **Step 3: Implement `mcp/src/broker-client.ts`**

```ts
// Controller side of the bridge. Connects to the broker, starts one if none is
// running, and keeps reconnecting with backoff. Losing the broker is a normal,
// recoverable event — it must never take the MCP process down with it.

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_BROKER_PORT, PROTOCOL_VERSION, type TargetInfo } from "./protocol";

const COMMAND_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const SPAWN_COOLDOWN_MS = 3_000;

export interface BrokerClientOptions {
  port?: number;
  autoSpawn?: boolean;
  commandTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Pending {
  target: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrokerClient {
  readonly port: number;
  protocolError: string | null = null;

  private readonly autoSpawn: boolean;
  private readonly commandTimeoutMs: number;
  private readonly log: (msg: string) => void;

  private ws: WebSocket | null = null;
  private connected = false;
  private targets: TargetInfo[] = [];
  private pending = new Map<string, Pending>();
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpawnAt = 0;
  private closed = false;
  private readonly idPrefix = randomUUID().slice(0, 8);
  private idCounter = 0;

  constructor(options: BrokerClientOptions = {}) {
    this.port = options.port ?? DEFAULT_BROKER_PORT;
    this.autoSpawn = options.autoSpawn ?? true;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  getTargets(): TargetInfo[] {
    return this.targets;
  }

  async ready(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.connected;
  }

  async send(target: string, command: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.protocolError) throw new Error(this.protocolError);
    await this.ready(this.commandTimeoutMs);

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Not connected to the figma-slides broker on ws://localhost:${this.port}. It is still starting — retry in a moment.`
      );
    }

    const id = `req_${this.idPrefix}_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${command}' timed out after ${this.commandTimeoutMs / 1000}s`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { target, resolve, reject, timer });
      ws.send(JSON.stringify({ type: "command", id, target, command, params }));
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.rejectAll("The MCP server is shutting down");
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(`ws://localhost:${this.port}`);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.protocolError = null;
      ws.send(JSON.stringify({ type: "hello", role: "controller", protocol: PROTOCOL_VERSION }));
      this.log(`connected to broker on ws://localhost:${this.port}`);
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));

    ws.on("error", () => {
      // 'close' follows and owns the reconnect.
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.targets = [];
      this.rejectAll("Lost the connection to the figma-slides broker");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.maybeSpawnBroker();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private maybeSpawnBroker(): void {
    if (!this.autoSpawn) return;
    const now = Date.now();
    if (now - this.lastSpawnAt < SPAWN_COOLDOWN_MS) return;
    this.lastSpawnAt = now;

    const brokerPath = fileURLToPath(new URL("./broker.mjs", import.meta.url));
    try {
      const child = spawn(process.execPath, [brokerPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      this.log(`starting broker daemon (${brokerPath})`);
    } catch {
      // The next reconnect tick tries again.
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "targets" && Array.isArray(msg.targets)) {
      this.targets = msg.targets;
      this.connected = true;
      return;
    }

    if (msg.type === "response" && typeof msg.id === "string") {
      const pending = this.take(msg.id);
      if (!pending) return;
      if (msg.success) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error || "Unknown plugin error"));
      return;
    }

    if (msg.type === "error") {
      if (msg.code === "protocol_mismatch") {
        this.protocolError =
          `The broker on port ${this.port} speaks protocol ${msg.brokerProtocol ?? "?"}, ` +
          `this MCP server speaks ${PROTOCOL_VERSION}. An older figma-slides-mcp is still running — ` +
          `stop it with \`lsof -ti :${this.port} | xargs kill\` and retry.`;
        this.log(this.protocolError);
        this.rejectAll(this.protocolError);
        return;
      }
      if (typeof msg.id === "string") {
        const pending = this.take(msg.id);
        if (pending) pending.reject(new Error(msg.error || msg.code));
      }
    }
  }

  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add mcp/src/broker-client.ts mcp/test/broker-client.test.mjs
git commit -m "feat(mcp): add broker client with auto-spawn and per-target pending requests"
```

---

### Task 6: MCP tool surface on the broker client

**Files:**
- Modify: `mcp/src/mcp-server.ts` (full rewrite of the transport half, tools kept and extended)

**Interfaces:**
- Consumes: `BrokerClient` from `./broker-client`; `resolveTarget`, `matchDeck`, `shortId` from `./target-resolver`; `DEFAULT_BROKER_PORT` from `./protocol`.
- Produces: MCP tools `list_decks`, `use_deck`, `execute`, `screenshot_slide`.

- [x] **Step 1: Replace `mcp/src/mcp-server.ts` entirely**

```ts
// Figma Slides MCP Server
// Bridges Claude Code (via stdio MCP) ↔ the figma-slides broker (WebSocket on
// :3055) ↔ one or more Figma plugin instances. The broker outlives this
// process, so restarting the MCP client no longer breaks the bridge.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrokerClient } from "./broker-client";
import { matchDeck, resolveTarget, shortId } from "./target-resolver";
import { DEFAULT_BROKER_PORT } from "./protocol";

const READY_TIMEOUT_MS = 5_000;

const envPort = Number(process.env.FIGMA_SLIDES_BROKER_PORT);
const client = new BrokerClient({
  port: Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_BROKER_PORT,
  log: (msg) => console.error(`[figma-slides-mcp] ${msg}`),
});

let pinnedConnId: string | null = null;

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

async function resolveDeck(deck?: string): Promise<string> {
  await client.ready(READY_TIMEOUT_MS);
  const outcome = resolveTarget(client.getTargets(), deck, pinnedConnId);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.connId;
}

// ── MCP Server ───────────────────────────────────────────

const server = new McpServer({
  name: "figma-slides",
  version: "0.2.0",
});

const deckParam = z
  .string()
  .optional()
  .describe(
    "Which connected deck to target: a connId from list_decks or part of the Figma file name. Defaults to the deck pinned with use_deck, or the only connected deck."
  );

server.tool(
  "list_decks",
  "List the Figma decks currently connected to the bridge. Each entry has connId (routing key), docName (Figma file name), editorType, and isPinned.",
  {},
  async () => {
    await client.ready(READY_TIMEOUT_MS);
    const decks = client.getTargets().map((t) => ({
      connId: t.connId,
      docName: t.docName,
      editorType: t.editorType,
      isPinned: t.connId === pinnedConnId,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(decks, null, 2) }] };
  }
);

server.tool(
  "use_deck",
  "Pin one connected deck as the target for the rest of this session. Accepts a full connId or part of the deck's Figma file name.",
  { deck: z.string().describe("connId (full or prefix) or part of the deck's Figma file name") },
  async ({ deck }) => {
    await client.ready(READY_TIMEOUT_MS);
    const targets = client.getTargets();
    const outcome = matchDeck(targets, deck);
    if (!outcome.ok) return errorResult(outcome.error);
    pinnedConnId = outcome.connId;
    const target = targets.find((t) => t.connId === outcome.connId)!;
    return {
      content: [
        {
          type: "text" as const,
          text: `Pinned "${target.docName}" (${shortId(target.connId)}) as this session's deck.`,
        },
      ],
    };
  }
);

server.tool(
  "execute",
  `Run JavaScript in the Figma plugin sandbox. The code is the body of an async function with these in scope:
  - figma — the Figma Plugin API global
  - getSlide(index) — returns the slide at the given index (navigates SLIDE_GRID → SLIDE_ROW → SLIDE automatically)
  - findSlides() — returns an array of all SLIDE nodes in presentation order
  - serialize(node) — returns a JSON-friendly summary of a node (id, name, type, x, y, width, height, visible, opacity, characters, fills, childCount)
  - loadFont(family, style?) — shorthand for figma.loadFontAsync({ family, style })

Return a value and it will be sent back as the tool result.`,
  {
    code: z.string().describe("JavaScript code to execute (body of an async function)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const target = await resolveDeck(params.deck);
      const result = await client.send(target, "execute", { code: params.code });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) ?? "OK" }],
      };
    } catch (err: any) {
      return errorResult(err.message);
    }
  }
);

server.tool(
  "screenshot_slide",
  "Export a slide as a PNG screenshot. Returns base64-encoded image data.",
  {
    slideIndex: z.number().int().min(0).describe("Slide index to screenshot"),
    scale: z.number().optional().describe("Export scale (default 1, use 0.5 for thumbnails)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const target = await resolveDeck(params.deck);
      const result = (await client.send(target, "screenshot_slide", {
        slideIndex: params.slideIndex,
        scale: params.scale,
      })) as { base64: string; format: string; slideIndex: number };
      return {
        content: [
          {
            type: "image" as const,
            data: result.base64,
            mimeType: "image/png",
          },
        ],
      };
    } catch (err: any) {
      return errorResult(err.message);
    }
  }
);

// ── Start ────────────────────────────────────────────────

async function main() {
  // Connecting to (or spawning) the broker is deliberately not awaited: the MCP
  // server must come up healthy even when no broker is running yet.
  client.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[figma-slides-mcp] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[figma-slides-mcp] Fatal:", err);
  process.exit(1);
});
```

- [x] **Step 2: Verify the build and that the old failure modes are gone**

Run: `npm run build:mcp && grep -c "killStaleProcess\|WebSocketServer" mcp/src/mcp-server.ts`
Expected: build succeeds; grep prints `0`.

- [x] **Step 3: Verify the server starts without a broker and does not exit**

Run:
```bash
node mcp/dist/mcp-server.mjs < /dev/null & sleep 2; kill %1 2>/dev/null; lsof -ti :3055 | xargs kill 2>/dev/null; true
```
Expected: stderr shows `MCP server running on stdio` and a broker start line, no `Exiting.`

- [x] **Step 4: Commit**

```bash
git add mcp/src/mcp-server.ts
git commit -m "feat(mcp): route tools through the broker and add list_decks/use_deck"
```

---

### Task 7: Figma plugin — identity, hello, sandbox reconnect clock

**Files:**
- Modify: `mcp/figma-plugin/code.ts:5` (add the tick) and `mcp/figma-plugin/code.ts:108-112` (message relay)
- Modify: `mcp/figma-plugin/ui.html:23-77` (script block)

**Interfaces:**
- Sandbox → UI: `{ type: "identity", docName: string, editorType: string }`, `{ type: "tick" }`, `{ id, success, data?, error? }`
- UI → sandbox: `{ type: "ui-ready" }`, and forwarded broker commands `{ id, command, params }`
- UI → broker: `{ type: "hello", role: "plugin", protocol: 1, docName, editorType }` and `{ id, success, data?, error? }`

- [x] **Step 1: Add the reconnect clock in `mcp/figma-plugin/code.ts`, right after `figma.showUI(...)`**

```ts
figma.showUI(__html__, { visible: false, width: 0, height: 0 });

// The UI iframe is hidden, and Figma throttles timers in hidden frames — so the
// reconnect clock lives here in the sandbox and nudges the UI instead.
const RECONNECT_TICK_MS = 3000;
setInterval(() => figma.ui.postMessage({ type: "tick" }), RECONNECT_TICK_MS);
```

- [x] **Step 2: Replace the message relay at the bottom of `mcp/figma-plugin/code.ts`**

```ts
// ── Message relay ────────────────────────────────────────

type UiMessage =
  | { type: "ui-ready" }
  | { id: string; command: string; params: Record<string, unknown> };

figma.ui.onmessage = async (msg: UiMessage & { type?: string; id?: string; command?: string }) => {
  if (msg && msg.type === "ui-ready") {
    figma.ui.postMessage({
      type: "identity",
      docName: figma.root.name,
      editorType: figma.editorType,
    });
    return;
  }
  if (!msg || !msg.id || !msg.command) return;
  const result = await handleCommand(msg.command, (msg as any).params || {});
  figma.ui.postMessage({ id: msg.id, ...result });
};
```

- [x] **Step 3: Replace the `<script>` block in `mcp/figma-plugin/ui.html`**

```html
    <script>
      const WS_URL = "ws://localhost:3055";
      const PROTOCOL = 1;
      const RETRY_MS = 500;

      let ws = null;
      let identity = null;
      const statusEl = document.getElementById("status");

      function setStatus(text, cls) {
        statusEl.textContent = text;
        statusEl.className = cls;
      }

      function connect() {
        if (!identity) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
          setStatus("Connected — " + identity.docName, "connected");
          ws.send(
            JSON.stringify({
              type: "hello",
              role: "plugin",
              protocol: PROTOCOL,
              docName: identity.docName,
              editorType: identity.editorType,
            })
          );
        };

        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch (e) {
            return;
          }
          if (msg && msg.type === "error" && msg.code === "protocol_mismatch") {
            setStatus("Broker version mismatch — update figma-slides-mcp", "disconnected");
            return;
          }
          if (!msg || !msg.id || !msg.command) return;
          parent.postMessage({ pluginMessage: msg }, "*");
        };

        ws.onclose = () => {
          setStatus("Disconnected — reconnecting...", "disconnected");
          ws = null;
          setTimeout(connect, RETRY_MS);
        };

        ws.onerror = () => {
          // onclose fires after this and owns the retry.
        };
      }

      window.onmessage = (event) => {
        const msg = event.data && event.data.pluginMessage;
        if (!msg) return;
        if (msg.type === "identity") {
          identity = { docName: msg.docName, editorType: msg.editorType };
          connect();
          return;
        }
        if (msg.type === "tick") {
          connect();
          return;
        }
        if (!msg.id) return;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      };

      parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
    </script>
```

- [x] **Step 4: Build and confirm the plugin bundle carries the new relay**

Run: `npm run build:mcp && grep -c "ui-ready" mcp/dist/figma-plugin/code.js mcp/dist/figma-plugin/ui.html`
Expected: build succeeds; both files report at least `1`.

- [x] **Step 5: Commit**

```bash
git add mcp/figma-plugin/code.ts mcp/figma-plugin/ui.html
git commit -m "feat(plugin): send hello with the deck name and drive reconnect from the sandbox"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (tool list, architecture, install/run notes)
- Modify: `CLAUDE.md` (Architecture and MCP Server sections)

**Interfaces:**
- Consumes: the tool names from Task 6.
- Produces: nothing consumed by other tasks.

- [x] **Step 1: Update `README.md`**

Add `list_decks` and `use_deck` to the tool table, note the `deck` parameter on `execute` and `screenshot_slide`, and add a short "How it connects" note:

```markdown
The MCP server does not own the WebSocket port. A small broker daemon
(`mcp/dist/broker.mjs`) owns `ws://localhost:3055`; the MCP server starts it on
demand and reconnects to it. The broker outlives MCP client restarts, so
restarting Claude Code no longer breaks the bridge — and several Figma files can
be connected at once, each addressed by `deck`.

With a single deck connected nothing changes. With two or more, `execute` and
`screenshot_slide` refuse to guess: they return the connected deck names and
wait for a `deck` argument or a `use_deck` call.
```

- [x] **Step 2: Update `CLAUDE.md`**

In **Architecture**, change the `mcp/` bullet to say the server bridges MCP clients and the Figma plugin sandbox *through a broker daemon on `:3055`*. In **MCP Server → Tools**, add:

```markdown
- `list_decks` — List connected Figma decks (`connId`, `docName`, `isPinned`)
- `use_deck` — Pin one deck as the session target (accepts connId or file-name fragment)
```

and note that `execute` and `screenshot_slide` take an optional `deck`.

- [x] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the broker daemon and multi-deck tools"
```

---

### Task 9: Full verification

**Files:** none.

- [x] **Step 1: Clean build from scratch**

Run: `rm -rf mcp/dist && npm run build:mcp && ls mcp/dist`
Expected: `broker.mjs`, `broker-client.mjs`, `mcp-server.mjs`, `protocol-constants.mjs`, `target-resolver.mjs`, `figma-plugin/`.

- [x] **Step 2: Run the whole suite**

Run: `npm test`
Expected: all tests pass, no open-handle warnings that keep the run alive.

- [x] **Step 3: Confirm `.mcp.json` is untouched**

Run: `git diff --stat origin/main -- .mcp.json`
Expected: empty output.

- [x] **Step 4: Commit anything outstanding**

```bash
git status --short
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| `broker.ts` → `dist/broker.mjs` daemon owning :3055 | 3 |
| MCP server becomes a broker client | 5, 6 |
| `ui.html` hello + reconnect | 7 |
| `code.ts` provides `figma.root.name`, drives the heartbeat | 7 |
| `build.mjs` third entry, watch path included | 2 (factory covers build + watch) |
| `.mcp.json` unchanged | 9 step 3 |
| Broker is dumb (no target choice) | 3 |
| `connId` UUID per connection, `docName` label, nothing written to the file | 3 |
| `protocol: 1` on every hello, `protocol_mismatch` handshake error | 1, 3, 5, 7 |
| Addressed `command` envelope, response only to the origin controller | 3 |
| Pushed `targets` on join/leave and on connect | 3 |
| `no_such_target`, `target_disconnected` | 3 |
| `list_decks`, `use_deck`, `deck?` on both existing tools | 6 |
| Four-branch target resolution incl. ambiguity error | 2 |
| No-deck error keeps the "Plugins > Development" instruction | 2 |
| 20s ping, drop after 2 missed pongs | 3, 4 |
| 30 min idle shutdown | 3 |
| EADDRINUSE → exit 0 silently | 3, 4 |
| Auto-spawn detached + `stdio: "ignore"` + `unref()`, backoff to ~5s | 5 |
| `killStaleProcess()` and `process.exit(1)` removed | 6 step 2 |
| Protocol divergence reported clearly | 5 |
| Reconnect clock in the sandbox, immediate reconnect on close, re-hello | 7 |
| Per-target rejection, 15s timeout per request | 3, 5 |
| Tests: routing, resolution, bind race, reaper, per-target rejection | 2, 3, 4, 5 |
| Migration: rebuild + reload plugin, old broker detected | 5, 8 |

**Placeholder scan:** none — every code step carries complete source.

**Type consistency:** `TargetInfo` is defined once in Task 1 and consumed unchanged by Tasks 2, 3, 5. `ResolveOutcome` returned by `matchDeck`/`resolveTarget` is destructured identically in Tasks 2 and 6. `BrokerClient.send(target, command, params)` as produced in Task 5 matches every call site in Task 6. The `{ id, command, params }` / `{ id, success, data, error }` plugin-facing shapes in Task 3 match what `ui.html` and `code.ts` produce and consume in Task 7.
