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
  if ("characters" in node) {
    const textNode = node as TextNode;
    base.characters = textNode.characters;
    try {
      const fontName = textNode.fontName;
      if (fontName && typeof fontName === "object" && "family" in fontName) {
        base.fontName = { family: fontName.family, style: fontName.style };
      }
    } catch (_) {
      base.fontName = "MIXED";
    }
    if (typeof textNode.fontSize === "number") base.fontSize = textNode.fontSize;
  }
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

      case "get_styleguide": {
        const slides = findSlides();
        const colors = new Map<string, { count: number; contexts: string[] }>();
        const fonts = new Map<string, { count: number; contexts: string[] }>();
        const layouts: { slideIndex: number; name: string; textPreview: string; regions: { name: string; type: string; x: number; y: number; width: number; height: number }[] }[] = [];

        const colorKey = (r: number, g: number, b: number) =>
          `#${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;

        const walkNode = (node: SceneNode, slideIndex: number, slideName: string) => {
          // Collect colors from fills
          if ("fills" in node) {
            try {
              const fills = (node as GeometryMixin).fills;
              if (Array.isArray(fills)) {
                for (const fill of fills) {
                  if (fill.type === "SOLID" && fill.visible !== false) {
                    const key = colorKey(fill.color.r, fill.color.g, fill.color.b);
                    const entry = colors.get(key) || { count: 0, contexts: [] };
                    entry.count++;
                    if (entry.contexts.length < 3) {
                      const ctx = node.type === "TEXT" ? `text "${(node as TextNode).characters.slice(0, 30)}"` : `${node.type.toLowerCase()} "${node.name}"`;
                      entry.contexts.push(`slide ${slideIndex}: ${ctx}`);
                    }
                    colors.set(key, entry);
                  }
                }
              }
            } catch (_) {}
          }

          // Collect fonts from text nodes
          if (node.type === "TEXT") {
            const textNode = node as TextNode;
            try {
              const fontName = textNode.fontName;
              if (fontName && typeof fontName === "object" && "family" in fontName) {
                const key = `${fontName.family} ${fontName.style}`;
                const entry = fonts.get(key) || { count: 0, contexts: [] };
                entry.count++;
                if (entry.contexts.length < 3) {
                  entry.contexts.push(`slide ${slideIndex}: "${textNode.characters.slice(0, 40)}"`);
                }
                fonts.set(key, entry);
              }
            } catch (_) {
              // Mixed fonts — walk segments not available, skip
            }
          }

          if ("children" in node) {
            for (const child of (node as ChildrenMixin).children) walkNode(child as SceneNode, slideIndex, slideName);
          }
        };

        for (let i = 0; i < slides.length; i++) {
          const slide = slides[i];
          walkNode(slide, i, slide.name);

          // Extract top-level layout regions
          if ("children" in slide) {
            const regions = (slide as ChildrenMixin).children.map((child) => ({
              name: child.name,
              type: (child as SceneNode).type,
              x: (child as SceneNode).x,
              y: (child as SceneNode).y,
              width: (child as SceneNode).width,
              height: (child as SceneNode).height,
            }));

            // Text preview
            const texts: string[] = [];
            const walkText = (n: SceneNode) => {
              if (texts.length >= 2) return;
              if (n.type === "TEXT") {
                const t = (n as TextNode).characters.trim();
                if (t) texts.push(t.length > 60 ? t.slice(0, 60) + "…" : t);
              }
              if ("children" in n) for (const c of (n as ChildrenMixin).children) walkText(c as SceneNode);
            };
            for (const c of (slide as ChildrenMixin).children) walkText(c as SceneNode);

            layouts.push({ slideIndex: i, name: slide.name, textPreview: texts.join(" | "), regions });
          }
        }

        // Sort colors and fonts by frequency
        const sortedColors = [...colors.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([hex, info]) => ({ hex, ...info }));

        const sortedFonts = [...fonts.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([font, info]) => ({ font, ...info }));

        return {
          success: true,
          data: {
            slideCount: slides.length,
            slideDimensions: { width: slides[0]?.width ?? 1920, height: slides[0]?.height ?? 1080 },
            colors: sortedColors,
            fonts: sortedFonts,
            layouts,
          },
        };
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

      case "update_text": {
        const slideIndex = params.slideIndex as number;
        const slide = getSlide(slideIndex);
        if (!slide) return { success: false, error: `Slide at index ${slideIndex} not found` };

        const updates = params.updates as { match: string; newText: string }[];
        if (!updates || !Array.isArray(updates) || updates.length === 0) {
          return { success: false, error: "updates must be an array of { match, newText }" };
        }

        // Collect all text nodes
        const textNodes: TextNode[] = [];
        const walkForText = (node: SceneNode) => {
          if (node.type === "TEXT") textNodes.push(node as TextNode);
          if ("children" in node) for (const c of (node as ChildrenMixin).children) walkForText(c as SceneNode);
        };
        walkForText(slide);

        const results: { match: string; found: boolean; nodeName?: string; oldText?: string }[] = [];

        for (const { match, newText } of updates) {
          // Find by node name first, then by text content (startsWith for partial match)
          let target = textNodes.find((t) => t.name === match);
          if (!target) target = textNodes.find((t) => t.characters === match);
          if (!target) target = textNodes.find((t) => t.characters.startsWith(match));

          if (!target) {
            results.push({ match, found: false });
            continue;
          }

          // Auto-load fonts
          const len = target.characters.length;
          const fontsToLoad = new Set<string>();
          for (let i = 0; i < len; i++) {
            try {
              const font = target.getRangeFontName(i, i + 1) as FontName;
              fontsToLoad.add(`${font.family}::${font.style}`);
            } catch (_) { break; }
          }
          for (const key of fontsToLoad) {
            const [family, style] = key.split("::");
            await figma.loadFontAsync({ family, style });
          }

          const oldText = target.characters;
          target.characters = newText;
          results.push({ match, found: true, nodeName: target.name, oldText });
        }

        return { success: true, data: results };
      }

      case "duplicate_slide": {
        const sourceIndex = params.sourceIndex as number;
        const slide = getSlide(sourceIndex);
        if (!slide) return { success: false, error: `Slide at index ${sourceIndex} not found` };

        const parent = slide.parent;
        if (!parent || !("children" in parent)) {
          return { success: false, error: "Cannot find parent container for slide" };
        }

        const clone = slide.clone();
        const siblings = (parent as ChildrenMixin).children;
        const currentPos = siblings.indexOf(slide as SceneNode);

        // Insert after the source slide
        if (currentPos < siblings.length - 1) {
          (parent as ChildrenMixin & BaseNodeMixin).insertChild(currentPos + 1, clone);
        }

        const slides = findSlides();
        const newIndex = slides.indexOf(clone);

        return {
          success: true,
          data: {
            sourceIndex,
            newIndex,
            newId: clone.id,
            name: clone.name,
          },
        };
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
