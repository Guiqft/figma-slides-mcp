// Figma Slides MCP Server
// Bridges Claude Code (via stdio MCP) ↔ Figma Plugin (via WebSocket on :3055)
// Supports multiple instances: first gets the port (server mode),
// subsequent ones connect as proxy clients through the first.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebSocketServer, WebSocket } from "ws"
import { z } from "zod"

const WS_PORT = 3055
const COMMAND_TIMEOUT_MS = 30_000
const PROXY_PATH = "/mcp-proxy"

// ── Shared state ──────────────────────────────────────────

let figmaSocket: WebSocket | null = null
let proxySocket: WebSocket | null = null // set only in proxy mode

const pendingRequests = new Map<
  string,
  { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>()
let requestIdCounter = 0

// ── Server mode: proxy request tracking ──────────────────

const proxyPendingRequests = new Map<
  string,
  { ws: WebSocket; originalId: string; timer: ReturnType<typeof setTimeout> }
>()

// ── Server mode ──────────────────────────────────────────

function setupServerMode(wss: WebSocketServer): void {
  wss.on("connection", (ws, req) => {
    // Proxy MCP client — differentiated by URL path
    if (req.url === PROXY_PATH) {
      console.error("[figma-slides-mcp] Proxy MCP client connected")

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.command) forwardProxyRequest(msg, ws)
        } catch (e) {
          console.error("[figma-slides-mcp] Failed to parse proxy message:", e)
        }
      })

      ws.on("close", () => {
        console.error("[figma-slides-mcp] Proxy MCP client disconnected")
        for (const [id, entry] of proxyPendingRequests) {
          if (entry.ws === ws) {
            clearTimeout(entry.timer)
            proxyPendingRequests.delete(id)
          }
        }
      })
      return
    }

    // Figma plugin connection
    console.error("[figma-slides-mcp] Figma plugin connected")
    figmaSocket = ws

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())

        // Response to a proxied request?
        const proxyEntry = proxyPendingRequests.get(msg.id)
        if (proxyEntry) {
          clearTimeout(proxyEntry.timer)
          proxyPendingRequests.delete(msg.id)
          if (proxyEntry.ws.readyState === WebSocket.OPEN) {
            proxyEntry.ws.send(JSON.stringify({
              id: proxyEntry.originalId,
              success: msg.success,
              data: msg.data,
              error: msg.error,
            }))
          }
          return
        }

        // Local request response
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(msg.id)
          if (msg.success) {
            pending.resolve(msg.data)
          } else {
            pending.reject(new Error(msg.error || "Unknown plugin error"))
          }
        }
      } catch (e) {
        console.error("[figma-slides-mcp] Failed to parse plugin message:", e)
      }
    })

    ws.on("close", () => {
      console.error("[figma-slides-mcp] Figma plugin disconnected")
      if (figmaSocket === ws) figmaSocket = null

      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error("Figma plugin disconnected"))
        pendingRequests.delete(id)
      }

      for (const [id, entry] of proxyPendingRequests) {
        clearTimeout(entry.timer)
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({
            id: entry.originalId,
            success: false,
            error: "Figma plugin disconnected",
          }))
        }
        proxyPendingRequests.delete(id)
      }
    })
  })

  console.error(`[figma-slides-mcp] WebSocket server listening on ws://localhost:${WS_PORT}`)
}

function forwardProxyRequest(
  msg: { id: string; command: string; params: Record<string, unknown> },
  proxyWs: WebSocket,
): void {
  if (!figmaSocket || figmaSocket.readyState !== WebSocket.OPEN) {
    proxyWs.send(JSON.stringify({
      id: msg.id,
      success: false,
      error: "Figma plugin is not connected. Open the 'Slides MCP Bridge' plugin in Figma Slides.",
    }))
    return
  }

  const serverId = `proxy_${++requestIdCounter}`
  const timer = setTimeout(() => {
    proxyPendingRequests.delete(serverId)
    if (proxyWs.readyState === WebSocket.OPEN) {
      proxyWs.send(JSON.stringify({
        id: msg.id,
        success: false,
        error: `Command '${msg.command}' timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
      }))
    }
  }, COMMAND_TIMEOUT_MS)

  proxyPendingRequests.set(serverId, { ws: proxyWs, originalId: msg.id, timer })
  figmaSocket.send(JSON.stringify({ id: serverId, command: msg.command, params: msg.params }))
}

// ── Proxy mode ───────────────────────────────────────────

function connectAsProxy(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}${PROXY_PATH}`)

    ws.on("open", () => {
      console.error("[figma-slides-mcp] Connected as proxy client to existing server")
      proxySocket = ws
      resolve()
    })

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(msg.id)
          if (msg.success) {
            pending.resolve(msg.data)
          } else {
            pending.reject(new Error(msg.error || "Unknown plugin error"))
          }
        }
      } catch (e) {
        console.error("[figma-slides-mcp] Failed to parse proxy response:", e)
      }
    })

    ws.on("close", () => {
      console.error("[figma-slides-mcp] Proxy connection closed")
      proxySocket = null
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error("Connection to primary server closed"))
        pendingRequests.delete(id)
      }
    })

    ws.on("error", (err) => reject(err))
  })
}

// ── sendToPlugin (works in both modes) ───────────────────

function sendToPlugin(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = proxySocket || figmaSocket

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Figma plugin is not connected. Open the 'Slides MCP Bridge' plugin in Figma Slides."))
      return
    }

    const timeout = timeoutMs ?? COMMAND_TIMEOUT_MS
    const id = `req_${++requestIdCounter}`
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Command '${command}' timed out after ${timeout / 1000}s`))
    }, timeout)

    pendingRequests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, command, params }))
  })
}

// ── Startup: try server mode, fall back to proxy ─────────

function startBridge(): Promise<"server" | "proxy"> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: WS_PORT })

    wss.on("listening", () => {
      setupServerMode(wss)
      resolve("server")
    })

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[figma-slides-mcp] Port ${WS_PORT} in use, connecting as proxy client`)
        wss.close()
        connectAsProxy()
          .then(() => resolve("proxy"))
          .catch((proxyErr) => {
            console.error("[figma-slides-mcp] Failed to connect as proxy:", proxyErr.message)
            process.exit(1)
          })
      } else {
        console.error("[figma-slides-mcp] WebSocket server error:", err.message)
        process.exit(1)
      }
    })
  })
}

// ── MCP Server ───────────────────────────────────────────

const server = new McpServer({
  name: "figma-slides",
  version: "0.1.0",
  description: `Control the currently open Figma Slides presentation. No file URL needed — the plugin auto-connects via WebSocket.

IMPORTANT — slide indexing is 0-based:
Slide indices start at 0. When a user refers to "slide 1", that is index 0. "Slide 7" is index 6. Always subtract 1 from the user's slide number.

IMPORTANT — preferred workflow:
1. Before creating or editing slides, study the existing deck: use list_slides, get_styleguide, and read_slide.
2. To change text, ALWAYS use update_text — it auto-loads fonts and supports batch updates. Do NOT use execute for text changes.
3. To duplicate slides, use duplicate_slide then update_text on the copy.
4. Only use execute for operations that no dedicated tool covers (creating shapes, changing fills, etc.).
5. Match the existing style — treat the deck as a template with established patterns.`,
})

server.tool(
  "get_styleguide",
  "Extract the design system from the current deck: colors (sorted by frequency with usage context), fonts, slide dimensions, and layout regions for every slide. Use this before creating or editing slides to match the existing style.",
  {},
  async () => {
    try {
      const result = await sendToPlugin("get_styleguide", {}, 30_000)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "ping",
  "Check if the Figma plugin is connected and responding. Returns slide count and timestamp. Use this to diagnose connection issues.",
  {},
  async () => {
    try {
      const result = await sendToPlugin("ping", {}, 5_000)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
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
  { code: z.string().describe("JavaScript code to execute (body of an async function)") },
  async (params) => {
    try {
      const result = await sendToPlugin("execute", { code: params.code })
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) ?? "OK" }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "list_slides",
  "List all slides in the current presentation with their index, name, dimensions, skipped status, and a text preview (first 5 text nodes). Use this to get an overview of the deck before taking action.",
  {},
  async () => {
    try {
      const result = await sendToPlugin("list_slides", {})
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "read_slide",
  "Read the full node tree of a single slide, including all nested children with their properties (text, fills, position, size). Use this to understand a slide's structure before editing.",
  {
    slideIndex: z.number().int().min(0).describe("0-based slide index (user's 'slide 1' = index 0)"),
    depth: z.number().int().min(1).max(10).optional().describe("Max tree depth (default 5)"),
  },
  async (params) => {
    try {
      const result = await sendToPlugin("read_slide", params as Record<string, unknown>)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "update_text",
  `PREFERRED way to change text on slides — use this instead of execute for all text edits. Fonts are loaded automatically.

Matches text nodes by: (1) node name, (2) exact text content, or (3) text starting with the match string. Supports multiple updates in one call. Use list_slides or read_slide to find the current text, then match it here.`,
  {
    slideIndex: z.number().int().min(0).describe("0-based slide index (user's 'slide 1' = index 0)"),
    updates: z.array(z.object({
      match: z.string().describe("Node name or text content to find"),
      newText: z.string().describe("New text to set"),
    })).describe("Array of text updates to apply"),
  },
  async (params) => {
    try {
      const result = await sendToPlugin("update_text", params as Record<string, unknown>)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "duplicate_slide",
  "Duplicate a slide and insert the copy immediately after the source. Returns the new slide's index and ID. Use this to create new slides based on existing templates.",
  {
    sourceIndex: z.number().int().min(0).describe("0-based index of the slide to duplicate (user's 'slide 1' = index 0)"),
  },
  async (params) => {
    try {
      const result = await sendToPlugin("duplicate_slide", params as Record<string, unknown>)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "screenshot_presentation",
  "Export all slides as PNG thumbnails in a single call. Returns an array of base64-encoded images. Use this to visually review the entire deck at once instead of screenshotting slides one by one.",
  {
    scale: z.number().optional().describe("Export scale (default 0.5 for thumbnails, use 1 for full resolution)"),
  },
  async (params) => {
    try {
      const results = (await sendToPlugin("screenshot_presentation", params as Record<string, unknown>, 120_000)) as {
        slideIndex: number
        base64: string
      }[]
      return {
        content: results.map((r) => ({
          type: "image" as const,
          data: r.base64,
          mimeType: "image/png" as const,
        })),
      }
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "screenshot_slide",
  "Export a slide as a PNG screenshot from the currently open Figma Slides file. Returns base64-encoded image data. No URL needed — the plugin is already connected.",
  {
    slideIndex: z.number().int().min(0).describe("0-based slide index (user's 'slide 1' = index 0)"),
    scale: z.number().optional().describe("Export scale (default 1, use 0.5 for thumbnails)"),
  },
  async (params) => {
    try {
      const result = (await sendToPlugin("screenshot_slide", params as Record<string, unknown>)) as {
        base64: string
        format: string
        slideIndex: number
      }
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
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  }
)

// ── Start ────────────────────────────────────────────────

async function main() {
  const mode = await startBridge()
  console.error(`[figma-slides-mcp] Running in ${mode} mode`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[figma-slides-mcp] MCP server running on stdio")

  // Exit when the parent process (Claude) closes the stdio pipe
  process.stdin.on("end", () => {
    console.error("[figma-slides-mcp] stdin closed, shutting down")
    process.exit(0)
  })
  process.stdin.on("error", () => process.exit(0))
}

main().catch((err) => {
  console.error("[figma-slides-mcp] Fatal:", err)
  process.exit(1)
})
