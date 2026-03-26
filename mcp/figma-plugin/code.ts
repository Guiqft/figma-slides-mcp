// Figma Slides MCP Bridge — Plugin Sandbox (code.ts)
// Runs in Figma's plugin sandbox. Receives commands from ui.html via postMessage,
// executes them against the Figma API, and sends results back.

figma.showUI(__html__, { visible: false, width: 0, height: 0 });

// ── Helpers (available to execute'd code) ────────────────

function serializeNode(node: SceneNode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
  };
  if ("opacity" in node) base.opacity = (node as MinimalBlendMixin).opacity;
  if ("characters" in node) base.characters = (node as TextNode).characters;
  if ("fills" in node) {
    try {
      base.fills = JSON.parse(JSON.stringify((node as GeometryMixin).fills));
    } catch (_) {}
  }
  if ("children" in node) {
    base.childCount = (node as ChildrenMixin).children.length;
  }
  return base;
}

function findSlides(): SceneNode[] {
  const slides: SceneNode[] = [];
  for (const child of figma.currentPage.children) {
    if (child.type === "SLIDE_GRID" && "children" in child) {
      for (const row of (child as ChildrenMixin).children) {
        if (row.type === "SLIDE_ROW" && "children" in row) {
          for (const slide of (row as ChildrenMixin).children) slides.push(slide as SceneNode);
        }
      }
    }
  }
  // Fallback: if no SLIDE_GRID found, treat top-level frames as slides
  if (slides.length === 0) {
    for (const child of figma.currentPage.children) {
      if (child.type === "FRAME" || child.type === "SLIDE") slides.push(child);
    }
  }
  return slides;
}

function getSlide(index: number): SceneNode | null {
  return findSlides()[index] ?? null;
}

function loadFont(family: string, style: string = "Regular"): Promise<void> {
  return figma.loadFontAsync({ family, style });
}

// ── Command Handlers ────────────────────────────────────

type CommandResult = { success: true; data?: unknown } | { success: false; error: string };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function handleCommand(cmd: string, params: Record<string, unknown>): Promise<CommandResult> {
  try {
    switch (cmd) {
      case "ping": {
        const slides = findSlides();
        return { success: true, data: { pong: true, slideCount: slides.length, timestamp: Date.now() } };
      }

      case "execute": {
        const code = params.code as string;
        if (!code) return { success: false, error: "No code provided" };
        const fn = new AsyncFunction("figma", "getSlide", "findSlides", "serialize", "loadFont", code);
        const result = await fn(figma, getSlide, findSlides, serializeNode, loadFont);
        return { success: true, data: result };
      }

      case "list_slides": {
        const slides = findSlides();
        const result = slides.map((slide, index) => {
          const info: Record<string, unknown> = {
            index,
            id: slide.id,
            name: slide.name,
            type: slide.type,
            width: slide.width,
            height: slide.height,
          };
          if ("isSkippedSlide" in slide) info.isSkipped = (slide as any).isSkippedSlide;
          if ("children" in slide) {
            const children = (slide as ChildrenMixin).children;
            info.childCount = children.length;
            // Collect text preview from first few text nodes
            const texts: string[] = [];
            const walkForText = (node: SceneNode) => {
              if (texts.length >= 5) return;
              if (node.type === "TEXT") {
                const chars = (node as TextNode).characters.trim();
                if (chars) texts.push(chars.length > 80 ? chars.slice(0, 80) + "…" : chars);
              }
              if ("children" in node) {
                for (const child of (node as ChildrenMixin).children) walkForText(child as SceneNode);
              }
            };
            for (const child of children) walkForText(child as SceneNode);
            if (texts.length > 0) info.textPreview = texts;
          }
          return info;
        });
        return { success: true, data: result };
      }

      case "read_slide": {
        const slideIndex = params.slideIndex as number;
        const maxDepth = (params.depth as number) ?? 5;
        const slide = getSlide(slideIndex);
        if (!slide) return { success: false, error: `Slide at index ${slideIndex} not found` };

        const serializeDeep = (node: SceneNode, depth: number): Record<string, unknown> => {
          const info = serializeNode(node);
          if ("children" in node && depth < maxDepth) {
            info.children = (node as ChildrenMixin).children.map(
              (child) => serializeDeep(child as SceneNode, depth + 1)
            );
          }
          return info;
        };

        return { success: true, data: serializeDeep(slide, 0) };
      }

      case "screenshot_presentation": {
        const slides = findSlides();
        const scale = (params.scale as number) ?? 0.5;
        const settings: ExportSettings = {
          format: "PNG",
          constraint: { type: "SCALE", value: scale },
        };

        const promises = slides.map((slide, i) => {
          let exportable: SceneNode = slide;
          if (!("exportAsync" in exportable) && "children" in exportable) {
            const child = (exportable as ChildrenMixin).children.find((c) => "exportAsync" in c);
            if (child) exportable = child as SceneNode;
          }
          if (!("exportAsync" in exportable)) return null;
          return (exportable as ExportMixin).exportAsync(settings).then((bytes) => ({
            slideIndex: i,
            base64: figma.base64Encode(bytes),
          }));
        });

        const results = (await Promise.all(promises)).filter(Boolean);
        return { success: true, data: results };
      }

      case "screenshot_slide": {
        const slide = getSlide(params.slideIndex as number);
        if (!slide) return { success: false, error: `Slide at index ${params.slideIndex} not found` };
        let exportable: SceneNode = slide;
        if (!("exportAsync" in exportable) && "children" in exportable) {
          const child = (exportable as ChildrenMixin).children.find((c) => "exportAsync" in c);
          if (child) exportable = child as SceneNode;
        }
        if (!("exportAsync" in exportable)) {
          return { success: false, error: `Slide node type "${slide.type}" does not support export` };
        }
        const settings: ExportSettings = {
          format: "PNG",
          constraint: { type: "SCALE", value: (params.scale as number) ?? 1 },
        };
        const bytes = await (exportable as ExportMixin).exportAsync(settings);
        const base64 = figma.base64Encode(bytes);
        return { success: true, data: { base64, format: "png", slideIndex: params.slideIndex } };
      }

      default:
        return { success: false, error: `Unknown command: ${cmd}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// ── Message relay ────────────────────────────────────────

figma.ui.onmessage = async (msg: { id: string; command: string; params: Record<string, unknown> }) => {
  if (!msg.id || !msg.command) return;
  const result = await handleCommand(msg.command, msg.params || {});
  figma.ui.postMessage({ id: msg.id, ...result });
};
