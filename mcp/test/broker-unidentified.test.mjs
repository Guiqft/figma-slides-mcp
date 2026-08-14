import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../dist/broker.mjs";
import { connectRaw, helloController, helloPlugin, nextMessage } from "./helpers.mjs";

function waitForUnidentified(ws, count, timeoutMs = 3000) {
  return nextMessage(ws, (m) => m.type === "targets" && m.unidentified === count, timeoutMs);
}

test("a client that never says hello is reported as unidentified", async (t) => {
  const broker = await startBroker({
    port: 0,
    pingIntervalMs: 60_000,
    identifyGraceMs: 80,
    legacyProbeMs: 80,
  });
  t.after(() => broker.close());

  const controller = await helloController(broker.port);

  // Neither a hello nor an answer to the legacy probe — this is not a plugin.
  const outdated = await connectRaw(broker.port);
  const reported = await waitForUnidentified(controller, 1);

  assert.deepEqual(reported.targets, [], "it never becomes a routable deck");
  assert.equal(reported.unidentified, 1);

  outdated.close();
  const cleared = await waitForUnidentified(controller, 0);
  assert.equal(cleared.unidentified, 0, "it stops being counted once it goes away");

  controller.close();
});

test("a plugin that says hello in time is never counted as unidentified", async (t) => {
  const broker = await startBroker({
    port: 0,
    pingIntervalMs: 60_000,
    identifyGraceMs: 80,
    legacyProbeMs: 80,
  });
  t.after(() => broker.close());

  const controller = await helloController(broker.port);
  const plugin = await helloPlugin(broker.port, "Deck A");

  const registered = await nextMessage(
    controller,
    (m) => m.type === "targets" && m.targets.length === 1
  );
  assert.equal(registered.unidentified, 0);

  // Well past the grace period, still zero.
  await new Promise((r) => setTimeout(r, 250));
  const decks = await nextMessage(controller, () => true, 500).catch(() => null);
  assert.equal(decks, null, "no further targets frame is pushed");

  plugin.close();
  controller.close();
});
