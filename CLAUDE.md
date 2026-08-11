# figma-slides-mcp

MCP server + Figma plugin for controlling Figma Slides from any MCP-compatible AI assistant.

## Architecture

- **`mcp/`** — MCP server and Figma plugin source. A broker daemon (`mcp/dist/broker.mjs`) owns WebSocket `:3055` and forwards addressed envelopes between MCP servers and Figma plugin instances. The MCP server is a client of that broker and starts it on demand, so it survives MCP client restarts and can address several decks at once.
- **`assets/`** — Logos, fonts, and images available for use in slides.

## Important: Figma Slides API Gotchas

Before doing ANY work with Figma slides (editing, reviewing, creating, debugging), read the `/figma-slides-api` skill (`.claude/skills/figma-slides-api/SKILL.md`). It documents critical API pitfalls — e.g. using `visible` instead of `isSkippedSlide` to hide slides will silently break presentations.

## MCP Server

The `figma-slides` MCP server requires the "Claude Code Slides" plugin running in Figma.

**Tools:** `get_styleguide`, `ping`, `execute`, `list_slides`, `read_slide`,
`update_text`, `duplicate_slide`, `screenshot_slide`, `screenshot_presentation`
— all take an optional `deck`. Plus:

- `list_decks` — List connected Figma decks (`connId`, `docName`, `editorType`, `isPinned`)
- `use_deck` — Pin one deck as the session target (accepts a connId or a file-name fragment)

With one deck connected, `deck` is unnecessary. With two or more and no pinned
deck, the tools error out listing the candidates instead of guessing — editing
the wrong deck is silent damage.

**Config** (`.mcp.json`):
```json
{
  "mcpServers": {
    "figma-slides-dev": {
      "command": "node",
      "args": ["mcp/dist/mcp-server.mjs"]
    }
  }
}
```

## Local Dev

```bash
npm install            # Install dependencies
npm run build:mcp      # Build MCP server + Figma plugin
npm run dev:mcp        # Watch mode for MCP builds
npm test               # Build, then run the node --test suite (Node 22+)
```

The checked-in `.mcp.json` registers the server as `figma-slides-dev`, running
the local build directly, so run `npm run build:mcp` before starting an MCP
client inside this repo.
