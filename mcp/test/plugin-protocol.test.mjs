import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROTOCOL_VERSION } from "../dist/protocol-constants.mjs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

// ui.html is copied verbatim into the plugin, so it carries its own copy of the
// protocol number. Bumping protocol.ts alone makes the broker refuse every plugin.
test("the plugin UI speaks the protocol version the broker expects", () => {
  const match = read("../figma-plugin/ui.html").match(/const PROTOCOL = (\d+);/);
  assert.ok(match, "ui.html no longer declares `const PROTOCOL = <n>;`");
  assert.equal(Number(match[1]), PROTOCOL_VERSION);
});
