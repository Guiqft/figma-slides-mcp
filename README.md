# figma-slides-mcp

[![npm version](https://img.shields.io/npm/v/@guiqft/figma-slides-mcp.svg)](https://www.npmjs.com/package/@guiqft/figma-slides-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io)

[MCP server](https://modelcontextprotocol.io/) for controlling [Figma Slides](https://www.figma.com/slides/) — create, edit, and screenshot slides from any AI assistant that supports MCP.

## How It Works

```
AI Assistant  <-MCP->  MCP Server  <-WebSocket :3055->  Figma Plugin  <-Plugin API->  Figma Slides
```

The MCP server communicates with a Figma plugin running inside your Figma Slides file. The plugin executes JavaScript in the Figma plugin sandbox and returns results.

## Prerequisites

- Node.js 18+
- A Figma account with access to Figma Slides

## Quick Start

### 1. Connect to your MCP client

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add figma-slides -- npx @guiqft/figma-slides-mcp
```

Or add to your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "figma-slides": {
      "command": "npx",
      "args": ["@guiqft/figma-slides-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code</strong></summary>

```bash
code --add-mcp '{"name":"figma-slides","command":"npx","args":["@guiqft/figma-slides-mcp"]}'
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "figma-slides": {
      "command": "npx",
      "args": ["@guiqft/figma-slides-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop / Other MCP Clients</strong></summary>

Any MCP-compatible client can use figma-slides-mcp:
```json
{
  "mcpServers": {
    "figma-slides": {
      "command": "npx",
      "args": ["@guiqft/figma-slides-mcp"]
    }
  }
}
```

</details>

### 2. Load the Figma plugin

1. Download the [latest plugin release](https://github.com/guiqft/figma-slides-mcp/releases/latest/download/figma-plugin.zip) and unzip it
2. In Figma, open a Slides file
3. Go to **Plugins > Development > Import plugin from manifest...**
4. Select the `manifest.json` from the unzipped folder
5. Run the plugin — it connects to the MCP server via WebSocket on port 3055

## MCP Tools

### `get_styleguide`

Extract the design system from the current deck — colors (sorted by frequency with usage context), fonts, slide dimensions, and layout regions for every slide. Use this before creating or editing slides to match the existing style.

### `ping`

Check if the Figma plugin is connected and responding. Returns slide count and timestamp.

### `execute`

Run JavaScript in the Figma plugin sandbox. Has access to the full [`figma` Plugin API](https://www.figma.com/plugin-docs/api/api-reference/) plus these helpers:

| Helper | Description |
|--------|-------------|
| `getSlide(index?)` | Get a slide by 0-based index (defaults to current slide) |
| `findSlides()` | Get all slides in the presentation |
| `serialize(node?)` | Serialize a node (or the whole page) to a JSON summary |
| `loadFont(family, style?)` | Load a font before setting text (style defaults to `"Regular"`) |

### `list_slides`

List all slides in the current presentation with their index, name, dimensions, skipped status, and a text preview.

### `read_slide`

Read the full node tree of a single slide, including all nested children with their properties (text, fills, position, size).

| Parameter | Description |
|-----------|-------------|
| `slideIndex` | Slide index to read (0-based) |
| `depth` | Max tree depth (default 5, max 10) |

### `update_text`

Update text on a slide by matching node name or text content. Fonts are loaded automatically. Supports batch updates in one call.

| Parameter | Description |
|-----------|-------------|
| `slideIndex` | Slide index to update (0-based) |
| `updates` | Array of `{ match, newText }` — matches by node name, exact text, or text prefix |

### `duplicate_slide`

Duplicate a slide and insert the copy immediately after the source. Returns the new slide's index and ID.

| Parameter | Description |
|-----------|-------------|
| `sourceIndex` | Index of the slide to duplicate (0-based) |

### `screenshot_slide`

Export a slide as PNG and return it as a base64 image.

| Parameter | Description |
|-----------|-------------|
| `slideIndex` | Slide index to screenshot (0-based) |
| `scale` | Export scale (default 1, use 0.5 for thumbnails) |

### `screenshot_presentation`

Export all slides as PNG thumbnails in a single call. Returns an array of images.

| Parameter | Description |
|-----------|-------------|
| `scale` | Export scale (default 0.5 for thumbnails, use 1 for full resolution) |

## Development

For contributors who want to work on the project:

```bash
git clone https://github.com/guiqft/figma-slides-mcp.git
cd figma-slides-mcp
npm install
npm run build:mcp    # Build MCP server + Figma plugin
npm run dev:mcp      # Watch mode for MCP builds
```

## License

MIT — see [LICENSE](LICENSE).
