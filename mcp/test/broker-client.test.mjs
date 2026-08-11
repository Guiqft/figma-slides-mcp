import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { startBroker } from "../dist/broker.mjs";
import { BrokerClient } from "../dist/broker-client.mjs";
import { freePort, helloPlugin, nextMessage, send } from "./helpers.mjs";

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

test("a pre-broker server squatting the port is named in the error", async (t) => {
  // A figma-slides-mcp from before the broker owned :3055 itself: it completes
  // the WebSocket handshake and then ignores the hello.
  const port = await freePort();
  const squatter = new WebSocketServer({ port });
  const client = new BrokerClient({ port, autoSpawn: false, commandTimeoutMs: 1000 });
  t.after(async () => {
    client.close();
    await new Promise((r) => squatter.close(r));
  });

  client.start();
  assert.equal(await client.ready(800), false, "no targets frame ever arrives");
  assert.match(client.connectionHint(), /older figma-slides-mcp still holding the port/);
  assert.match(client.connectionHint(), new RegExp(`lsof -ti :${port}`));
  await assert.rejects(client.send("anything", "execute", {}), /older figma-slides-mcp/);
});

test("the client reconnects and repopulates targets after the broker restarts", async (t) => {
  const broker = await startBroker({ port: 0, pingIntervalMs: 60_000 });
  const port = broker.port;
  const client = new BrokerClient({ port, autoSpawn: false, commandTimeoutMs: 5000 });
  t.after(() => client.close());

  client.start();
  await client.ready(3000);

  const plugin = await helloPlugin(port, "Deck A");
  await waitForTargetCount(client, 1);

  plugin.terminate();
  await broker.close();
  await waitForTargetCount(client, 0);

  const revived = await startBroker({ port, pingIntervalMs: 60_000 });
  t.after(() => revived.close());

  assert.equal(await client.ready(5000), true);
  const plugin2 = await helloPlugin(port, "Deck A reopened");
  const targets = await waitForTargetCount(client, 1, 5000);
  assert.equal(targets[0].docName, "Deck A reopened");
  plugin2.close();
});
