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
