import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../dist/broker.mjs";
import { connectRaw, helloController, nextMessage, send, waitForTargets } from "./helpers.mjs";

/**
 * A pre-2.0 plugin: it opens the socket, says nothing, and answers anything
 * shaped like `{id, command}` with `{id, success, data}`. `answers` maps a
 * command to the data it returns; a command that is absent comes back as the
 * failure a 1.x plugin sends for an unknown command.
 */
async function legacyPlugin(port, answers = {}) {
  const ws = await connectRaw(port);
  const probes = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!msg.id || !msg.command) return;
    probes.push(msg);
    if (msg.command in answers) {
      send(ws, { id: msg.id, success: true, data: answers[msg.command] });
    } else {
      send(ws, { id: msg.id, success: false, error: `Unknown command: ${msg.command}` });
    }
  });
  ws.probes = probes;
  return ws;
}

const opts = { port: 0, pingIntervalMs: 60_000, identifyGraceMs: 60, legacyProbeMs: 400 };

test("a pre-2.0 plugin is probed and registered as a routable deck", async (t) => {
  const broker = await startBroker(opts);
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const plugin = await legacyPlugin(broker.port, { execute: "Deck Antigo" });

  const registered = await waitForTargets(controller, 1);
  assert.equal(registered.targets[0].docName, "Deck Antigo", "the probe reads the real file name");
  assert.equal(registered.targets[0].legacy, true, "it is flagged so the server can nag");
  assert.equal(registered.unidentified, 0, "it is no longer a mystery socket");

  assert.equal(plugin.probes.length, 1);
  assert.equal(plugin.probes[0].command, "execute");
  assert.match(plugin.probes[0].params.code, /figma\.root\.name/);

  plugin.close();
  controller.close();
});

test("commands route to a legacy deck and its response comes back", async (t) => {
  const broker = await startBroker(opts);
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const plugin = await legacyPlugin(broker.port, { execute: "Deck Antigo", ping: { pong: true } });
  const registered = await waitForTargets(controller, 1);

  send(controller, {
    type: "command",
    id: "req_1",
    target: registered.targets[0].connId,
    command: "ping",
    params: {},
  });
  const response = await nextMessage(controller, (m) => m.type === "response" && m.id === "req_1");

  assert.equal(response.success, true);
  assert.deepEqual(response.data, { pong: true });

  plugin.close();
  controller.close();
});

test("a plugin too old to run the probe still registers, under a fallback name", async (t) => {
  const broker = await startBroker(opts);
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const plugin = await legacyPlugin(broker.port, {}); // every command comes back as a failure

  const registered = await waitForTargets(controller, 1);
  assert.equal(registered.targets[0].legacy, true);
  assert.match(registered.targets[0].docName, /legacy/i, "answering at all is enough to identify it");

  plugin.close();
  controller.close();
});

test("a 2.x plugin that says hello late replaces its legacy registration", async (t) => {
  const broker = await startBroker(opts);
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const plugin = await legacyPlugin(broker.port, { execute: "Deck Antigo" });
  const asLegacy = await waitForTargets(controller, 1);
  assert.equal(asLegacy.targets[0].legacy, true);

  send(plugin, {
    type: "hello",
    role: "plugin",
    protocol: 1,
    docName: "Deck Novo",
    editorType: "slides",
  });

  const upgraded = await nextMessage(
    controller,
    (m) => m.type === "targets" && m.targets.some((target) => target.docName === "Deck Novo")
  );
  assert.equal(upgraded.targets.length, 1, "the legacy entry is gone, not duplicated");
  assert.equal(upgraded.targets[0].legacy, undefined);

  plugin.close();
  controller.close();
});
