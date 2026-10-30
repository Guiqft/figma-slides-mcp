import * as esbuild from "esbuild";
import { createHash } from "crypto";
import { builtinModules } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));

// A fingerprint of the plugin sources, compiled into both the plugin and the
// server. The server compares it with what each plugin reports, so it only asks
// users to update the plugin when the plugin actually changed — not on every
// release. code.ts imports nothing, so these three files are the whole plugin.
const PLUGIN_BUILD = createHash("sha256")
  .update(
    ["figma-plugin/code.ts", "figma-plugin/ui.html", "figma-plugin/manifest.json"]
      .map((file) => fs.readFileSync(path.join(__dirname, file)))
      .join("\0"),
  )
  .digest("hex")
  .slice(0, 12);

const define = {
  __PKG_VERSION__: JSON.stringify(pkg.version),
  __PLUGIN_BUILD__: JSON.stringify(PLUGIN_BUILD),
};

// Every Node-side module is bundled on its own so the broker can be spawned
// standalone and the tests can import the pure modules without booting a server.
function nodeBuild(entry, outfile) {
  return {
    entryPoints: [path.join(__dirname, entry)],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: path.join(__dirname, outfile),
    external: builtinModules.flatMap((m) => [m, `node:${m}`]),
    define,
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire } from "module";',
        "const require = createRequire(import.meta.url);",
      ].join("\n"),
    },
    sourcemap: true,
  };
}

const nodeBuilds = [
  nodeBuild("src/mcp-server.ts", "dist/mcp-server.mjs"),
  nodeBuild("src/broker.ts", "dist/broker.mjs"),
  nodeBuild("src/broker-client.ts", "dist/broker-client.mjs"),
  nodeBuild("src/target-resolver.ts", "dist/target-resolver.mjs"),
  nodeBuild("src/protocol.ts", "dist/protocol-constants.mjs"),
];

// Bundle the Figma plugin sandbox code
const pluginBuild = {
  entryPoints: [path.join(__dirname, "figma-plugin/code.ts")],
  bundle: true,
  platform: "browser",
  target: "es2017",
  format: "iife",
  outfile: path.join(__dirname, "dist/figma-plugin/code.js"),
  define,
  sourcemap: false,
};

// Copy static plugin files
function copyPluginFiles() {
  const pluginDist = path.join(__dirname, "dist/figma-plugin");
  fs.mkdirSync(pluginDist, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "figma-plugin/manifest.json"),
    path.join(pluginDist, "manifest.json"),
  );
  fs.copyFileSync(path.join(__dirname, "figma-plugin/ui.html"), path.join(pluginDist, "ui.html"));
  console.log("Copied plugin static files");
}

async function build() {
  if (watch) {
    for (const config of [...nodeBuilds, pluginBuild]) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    copyPluginFiles();
    console.log("Watching for changes...");
  } else {
    for (const config of [...nodeBuilds, pluginBuild]) {
      await esbuild.build(config);
    }
    copyPluginFiles();
    // Make server executable
    fs.chmodSync(path.join(__dirname, "dist/mcp-server.mjs"), 0o755);
    console.log("Build complete");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
