// Figma Slides MCP Server
// Bridges Claude Code (via stdio MCP) ↔ the figma-slides broker (WebSocket on
// :3055) ↔ one or more Figma plugin instances. The broker owns the port and
// outlives this process, so restarting the MCP client no longer breaks the
// bridge, and several decks can be connected at once.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { BrokerClient } from "./broker-client"
import { matchDeck, resolveTarget, shortId } from "./target-resolver"
import { DEFAULT_BROKER_PORT } from "./protocol"

const COMMAND_TIMEOUT_MS = 30_000
const READY_TIMEOUT_MS = 5_000

const envPort = Number(process.env.FIGMA_SLIDES_BROKER_PORT)
const client = new BrokerClient({
  port: Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_BROKER_PORT,
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
  log: (msg) => console.error(`[figma-slides-mcp] ${msg}`),
})

let pinnedConnId: string | null = null

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  }
}

async function resolveDeck(deck?: string): Promise<string> {
  // A bridge that never came up is a different problem from "no deck open", and
  // the two errors send the user to completely different places.
  if (!(await client.ready(READY_TIMEOUT_MS))) throw new Error(client.connectionHint())
  const outcome = resolveTarget(
    client.getTargets(),
    deck,
    pinnedConnId,
    client.getUnidentifiedCount()
  )
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.connId
}

/**
 * Every deck-addressed tool has the same shape: resolve the target, forward the
 * command, render the result. Only the rendering differs.
 */
async function run<T>(
  deck: string | undefined,
  command: string,
  params: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  const target = await resolveDeck(deck)
  return (await client.send(target, command, params, timeoutMs)) as T
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) ?? "OK" }] }
}

// ── MCP Server ───────────────────────────────────────────

const server = new McpServer({
  name: "figma-slides",
  version: "2.0.1",
  description: `Control the currently open Figma Slides presentation. No file URL needed — the plugin auto-connects via WebSocket.

IMPORTANT — slide indexing is 0-based:
Slide indices start at 0. When a user refers to "slide 1", that is index 0. "Slide 7" is index 6. Always subtract 1 from the user's slide number.

IMPORTANT — preferred workflow:
1. Before creating or editing slides, study the existing deck: use list_slides, get_styleguide, and read_slide.
2. To change text, ALWAYS use update_text — it auto-loads fonts and supports batch updates. Do NOT use execute for text changes.
3. To duplicate slides, use duplicate_slide then update_text on the copy.
4. Only use execute for operations that no dedicated tool covers (creating shapes, changing fills, etc.).
5. Match the existing style — treat the deck as a template with established patterns.

IMPORTANT — more than one deck can be connected:
With a single deck open, ignore the \`deck\` parameter entirely. If a tool reports an ambiguous target, it will list the connected decks — match one against what the user is talking about, or ask them. Never guess: editing the wrong deck is silent damage. Pin a deck for the session with use_deck.`,
})

const deckParam = z
  .string()
  .optional()
  .describe(
    "Which connected deck to target: a connId from list_decks or part of the Figma file name. Defaults to the deck pinned with use_deck, or the only connected deck."
  )

server.tool(
  "list_decks",
  "List the Figma decks currently connected to the bridge. Each entry has connId (routing key), docName (the Figma file name), editorType, and isPinned. Use this when a tool reports an ambiguous target.",
  {},
  async () => {
    if (!(await client.ready(READY_TIMEOUT_MS))) return errorResult(client.connectionHint())
    const decks = client.getTargets().map((t) => ({
      connId: t.connId,
      docName: t.docName,
      editorType: t.editorType,
      isPinned: t.connId === pinnedConnId,
    }))
    return jsonResult(decks)
  }
)

server.tool(
  "use_deck",
  "Pin one connected deck as the target for the rest of this session. Accepts a full connId, a connId prefix, or part of the deck's Figma file name. A connId changes whenever the plugin is relaunched, so prefer the file name.",
  { deck: z.string().describe("connId (full or prefix) or part of the deck's Figma file name") },
  async ({ deck }) => {
    if (!(await client.ready(READY_TIMEOUT_MS))) return errorResult(client.connectionHint())
    const targets = client.getTargets()
    const outcome = matchDeck(targets, deck, client.getUnidentifiedCount())
    if (!outcome.ok) return errorResult(outcome.error)
    pinnedConnId = outcome.connId
    const target = targets.find((t) => t.connId === outcome.connId)!
    return {
      content: [
        {
          type: "text" as const,
          text: `Pinned "${target.docName}" (${shortId(target.connId)}) as this session's deck.`,
        },
      ],
    }
  }
)

server.tool(
  "get_styleguide",
  "Extract the design system from the current deck: colors (sorted by frequency with usage context), fonts, slide dimensions, and layout regions for every slide. Use this before creating or editing slides to match the existing style.",
  { deck: deckParam },
  async (params) => {
    try {
      return jsonResult(await run(params.deck, "get_styleguide", {}, 30_000))
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "ping",
  "Check if the Figma plugin is connected and responding. Returns slide count and timestamp. Use this to diagnose connection issues.",
  { deck: deckParam },
  async (params) => {
    try {
      return jsonResult(await run(params.deck, "ping", {}, 5_000))
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "execute",
  `Run JavaScript in the Figma plugin sandbox of the currently open Figma Slides file. No URL or file ID needed — the plugin is already connected.

The code is the body of an async function with these in scope:
  - figma — the Figma Plugin API global
  - getSlide(index) — returns the slide at the given index (navigates SLIDE_GRID → SLIDE_ROW → SLIDE automatically)
  - findSlides() — returns an array of all SLIDE nodes in presentation order
  - serialize(node) — returns a JSON-friendly summary of a node (id, name, type, x, y, width, height, visible, opacity, characters, fills, childCount)
  - loadFont(family, style?) — shorthand for figma.loadFontAsync({ family, style })

Return a value and it will be sent back as the tool result. Keep output concise — large recursive trees can exceed size limits.`,
  {
    code: z.string().describe("JavaScript code to execute (body of an async function)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      return jsonResult(await run(params.deck, "execute", { code: params.code }))
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "list_slides",
  "List all slides in the current presentation with their index, name, dimensions, skipped status, and a text preview (first 5 text nodes). Use this to get an overview of the deck before taking action.",
  { deck: deckParam },
  async (params) => {
    try {
      return jsonResult(await run(params.deck, "list_slides", {}))
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "read_slide",
  "Read the full node tree of a single slide, including all nested children with their properties (text, fills, position, size). Use this to understand a slide's structure before editing.",
  {
    slideIndex: z.number().int().min(0).describe("0-based slide index (user's 'slide 1' = index 0)"),
    depth: z.number().int().min(1).max(10).optional().describe("Max tree depth (default 5)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const result = await run(params.deck, "read_slide", {
        slideIndex: params.slideIndex,
        depth: params.depth,
      })
      return jsonResult(result)
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "update_text",
  `PREFERRED way to change text on slides — use this instead of execute for all text edits. Fonts are loaded automatically.

Matches text nodes by: (1) node name, (2) exact text content, or (3) text starting with the match string. Supports multiple updates in one call. Use list_slides or read_slide to find the current text, then match it here.`,
  {
    slideIndex: z.number().int().min(0).describe("0-based slide index (user's 'slide 1' = index 0)"),
    updates: z
      .array(
        z.object({
          match: z.string().describe("Node name or text content to find"),
          newText: z.string().describe("New text to set"),
        })
      )
      .describe("Array of text updates to apply"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const result = await run(params.deck, "update_text", {
        slideIndex: params.slideIndex,
        updates: params.updates,
      })
      return jsonResult(result)
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "duplicate_slide",
  "Duplicate a slide and insert the copy immediately after the source. Returns the new slide's index and ID. Use this to create new slides based on existing templates.",
  {
    sourceIndex: z
      .number()
      .int()
      .min(0)
      .describe("0-based index of the slide to duplicate (user's 'slide 1' = index 0)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const result = await run(params.deck, "duplicate_slide", { sourceIndex: params.sourceIndex })
      return jsonResult(result)
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "screenshot_presentation",
  "Export all slides as PNG thumbnails in a single call. Returns an array of base64-encoded images. Use this to visually review the entire deck at once instead of screenshotting slides one by one.",
  {
    scale: z
      .number()
      .optional()
      .describe("Export scale (default 0.5 for thumbnails, use 1 for full resolution)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const results = await run<{ slideIndex: number; base64: string }[]>(
        params.deck,
        "screenshot_presentation",
        { scale: params.scale },
        120_000
      )
      return {
        content: results.map((r) => ({
          type: "image" as const,
          data: r.base64,
          mimeType: "image/png" as const,
        })),
      }
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

server.tool(
  "screenshot_slide",
  "Export a slide as a PNG screenshot from the currently open Figma Slides file. Returns base64-encoded image data. No URL needed — the plugin is already connected.",
  {
    slideIndex: z.number().int().min(0).describe("0-based slide index (user's 'slide 1' = index 0)"),
    scale: z.number().optional().describe("Export scale (default 1, use 0.5 for thumbnails)"),
    deck: deckParam,
  },
  async (params) => {
    try {
      const result = await run<{ base64: string; format: string; slideIndex: number }>(
        params.deck,
        "screenshot_slide",
        { slideIndex: params.slideIndex, scale: params.scale }
      )
      return {
        content: [
          {
            type: "image" as const,
            data: result.base64,
            mimeType: "image/png",
          },
        ],
      }
    } catch (err: any) {
      return errorResult(err.message)
    }
  }
)

// ── Start ────────────────────────────────────────────────

async function main() {
  // Connecting to (or spawning) the broker is deliberately not awaited: the MCP
  // server must come up healthy even when no broker is running yet.
  client.start()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[figma-slides-mcp] MCP server running on stdio")

  // Exit when the parent process (Claude) closes the stdio pipe. The broker
  // stays up on purpose — that is what survives the restart.
  process.stdin.on("end", () => {
    console.error("[figma-slides-mcp] stdin closed, shutting down")
    client.close()
    process.exit(0)
  })
  process.stdin.on("error", () => process.exit(0))
}

main().catch((err) => {
  console.error("[figma-slides-mcp] Fatal:", err)
  process.exit(1)
})
