// Which deck does this call target? Pure decision logic — no sockets, no I/O.
// The last branch is the point of the whole module: with two decks and no hint
// the tool refuses to act and hands the candidates back to the agent.

import type { TargetInfo } from "./protocol";

export type ResolveOutcome = { ok: true; connId: string } | { ok: false; error: string };

export const NO_DECKS_ERROR =
  "No Figma deck is connected. Open the 'Claude Code Slides' plugin in Figma Slides (Plugins > Development).";

/**
 * A pre-2.0 plugin connects and never sends a `hello`, so the bridge looks
 * empty while the user is staring at a running plugin. Say so instead of
 * telling them to open something that is already open.
 */
export function noDecksError(unidentifiedCount = 0): string {
  if (unidentifiedCount <= 0) return NO_DECKS_ERROR;
  const plural = unidentifiedCount === 1 ? "client" : "clients";
  return (
    `No Figma deck is connected, but ${unidentifiedCount} ${plural} on the bridge never identified ` +
    `themselves — almost certainly an outdated 'Claude Code Slides' plugin. Reload the plugin in Figma ` +
    `(Plugins > Development) using the build shipped with the installed server version; the plugin and ` +
    `server must match.`
  );
}

export function shortId(connId: string): string {
  return connId.slice(0, 8);
}

export function formatCandidates(targets: TargetInfo[]): string {
  return targets.map((t) => `  - "${t.docName}" (${shortId(t.connId)})`).join("\n");
}

export function matchDeck(
  targets: TargetInfo[],
  deck: string,
  unidentifiedCount = 0
): ResolveOutcome {
  if (targets.length === 0) return { ok: false, error: noDecksError(unidentifiedCount) };

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
  pinnedConnId: string | null,
  unidentifiedCount = 0
): ResolveOutcome {
  if (explicitDeck) return matchDeck(targets, explicitDeck, unidentifiedCount);
  if (targets.length === 0) return { ok: false, error: noDecksError(unidentifiedCount) };
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
