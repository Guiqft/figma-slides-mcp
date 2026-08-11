import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget, matchDeck, shortId, noDecksError } from "../dist/target-resolver.mjs";

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

test("no decks and an unidentified client blames the outdated plugin", () => {
  const out = resolveTarget([], undefined, null, 1);
  assert.equal(out.ok, false);
  assert.match(out.error, /never identified/);
  assert.match(out.error, /outdated/i);
  assert.match(out.error, /Claude Code Slides/);
  assert.doesNotMatch(out.error, /^No Figma deck is connected\.$/);
});

test("the unidentified wording is pluralised", () => {
  assert.match(resolveTarget([], undefined, null, 1).error, /1 client on the bridge never/);
  assert.match(resolveTarget([], undefined, null, 3).error, /3 clients on the bridge never/);
});

test("matchDeck also blames the outdated plugin when nothing is connected", () => {
  const out = matchDeck([], "Vendas", 2);
  assert.equal(out.ok, false);
  assert.match(out.error, /never identified/);
});

test("with zero unidentified the plain no-decks message is unchanged", () => {
  const out = resolveTarget([], undefined, null, 0);
  assert.match(out.error, /Open the 'Claude Code Slides' plugin/);
  assert.doesNotMatch(out.error, /never identified/);
});
