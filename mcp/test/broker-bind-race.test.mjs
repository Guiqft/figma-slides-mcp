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
