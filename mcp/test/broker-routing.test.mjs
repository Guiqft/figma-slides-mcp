import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../dist/broker.mjs";
import {
  PROTOCOL,
  collect,
  connectRaw,
  delay,
  helloController,
  helloPlugin,
  nextMessage,
  send,
  waitForTargets,
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

test("two controllers reusing the same request id do not cross wires", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  t.after(() => broker.close());

  const controller1 = await helloController(broker.port);
  const controller2 = await helloController(broker.port);

  const oneTarget = waitForTargets(controller1, 1);
  const plugin = await helloPlugin(broker.port, "Deck A");
  const { targets } = await oneTarget;
  const target = targets[0].connId;

  // Answer only once both commands have landed, so both routes coexist.
  const seen = [];
  plugin.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.command !== "execute") return;
    seen.push(msg.id);
    if (seen.length === 2) {
      send(plugin, { id: seen[0], success: true, data: "first" });
      send(plugin, { id: seen[1], success: true, data: "second" });
    }
  });

  const answer1 = nextMessage(controller1, (m) => m.type === "response");
  const answer2 = nextMessage(controller2, (m) => m.type === "response");
  send(controller1, { type: "command", id: "req_1", target, command: "execute", params: {} });
  await delay(50);
  send(controller2, { type: "command", id: "req_1", target, command: "execute", params: {} });

  const [r1, r2] = await Promise.all([answer1, answer2]);
  assert.equal(r1.id, "req_1");
  assert.equal(r1.data, "first");
  assert.equal(r2.id, "req_1");
  assert.equal(r2.data, "second");

  plugin.close();
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
