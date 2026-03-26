---
name: figma-slides-api
description: Reference for Figma Slides plugin API gotchas and quirks. ALWAYS load this skill when working with Figma slides in any capacity — editing, reviewing, creating, or debugging. Contains critical API pitfalls that cause silent bugs if ignored.
---

# Figma Slides Plugin API — Gotchas & Reference

Consult this before making changes to slides via the `figma-slides` MCP server.

## Skipping Slides

To hide a slide from a presentation, use `isSkippedSlide` — NOT `visible`.

```js
// CORRECT — slide is skipped in presentation, visible in editor (crossed out)
slide.isSkippedSlide = true;

// WRONG — makes the entire frame invisible in the editor too
slide.visible = false;
```

## Node Lookup

Use `figma.getNodeByIdAsync()`, not `figma.getNodeById()`. The plugin uses `documentAccess: "dynamic-page"` which requires async access.

```js
// CORRECT
const node = await figma.getNodeByIdAsync(id);

// WRONG — throws "Cannot call with documentAccess: dynamic-page"
const node = figma.getNodeById(id);
```

## Text Editing

**ALWAYS use the `update_text` MCP tool to change text on slides.** It auto-loads fonts and supports batch updates. Do NOT use `execute` for text changes.

```
update_text(slideIndex: 0, updates: [
  { match: "Old Title", newText: "New Title" },
  { match: "Old subtitle", newText: "New subtitle" }
])
```

If you must use `execute` for non-text operations that touch text (rare), you need to call `figma.loadFontAsync()` before modifying `characters`:

```js
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
```

The `loadFont(family, style)` helper in the plugin sandbox wraps `figma.loadFontAsync`.

## Slide Discovery

Use the dedicated MCP tools instead of writing custom JS:

- `list_slides` — overview of all slides with text previews
- `read_slide(slideIndex, depth?)` — full node tree of a single slide
- `get_styleguide` — extract colors, fonts, and layout patterns

For the `execute` tool, these helpers are in scope:

```js
const slides = findSlides();       // all slides in order
const slide = getSlide(0);         // slide by index
const info = serialize(slide);     // JSON-friendly summary
```

## Slide Duplication

Use the `duplicate_slide` MCP tool, then `update_text` on the copy:

```
duplicate_slide(sourceIndex: 0)  → { newIndex: 1 }
update_text(slideIndex: 1, updates: [{ match: "Old Title", newText: "New Title" }])
```

## REST API vs Plugin API

- **REST API** (`https://api.figma.com/v1/...`): Team/project/file listing, thumbnails. Uses `X-Figma-Token` header with PAT.
- **Plugin API** (`figma.*`): Manipulate the currently open file. Accessed via dedicated MCP tools (`update_text`, `duplicate_slide`, etc.) or the `execute` tool for advanced operations.

The `/projects/:id/files` endpoint does NOT return `editorType`, so you can't filter for Slides-only files at the API level.
