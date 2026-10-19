import { mkdir, rm } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { version } from "../package.json"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

if (Bun.version !== "1.4.2") throw new Error("Build with Bun 1.4.2, matching the qualified OpenCode checkout")
await rm("dist", { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: ["./src/server.ts", "./src/rpc.ts", "./src/provider.ts"],
  outdir: "./dist",
  naming: "[name].js",
  target: "bun",
  minify: { whitespace: true, syntax: true, identifiers: false },
  external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"],
  metafile: true,
})
if (!result.success) throw new AggregateError(result.logs, "Plugin build failed")
const tui = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  naming: "[name].js",
  target: "bun",
  plugins: [createSolidTransformPlugin()],
  // The host OpenTUI loader scans `from "..."` to share its runtime modules.
  // Keep import whitespace so an installed package does not load private peers.
  minify: { whitespace: false, syntax: true, identifiers: false },
  external: [
    "@opencode/plugin",
    "@opencode/plugin/*",
    "effect",
    "effect/*",
    "solid-js",
    "solid-js/*",
    "@opentui/solid",
    "@opentui/solid/*",
  ],
  metafile: true,
})
if (!tui.success) throw new AggregateError(tui.logs, "TUI plugin build failed")
const inputs = [...new Set([...Object.keys(result.metafile?.inputs ?? {}), ...Object.keys(tui.metafile?.inputs ?? {})])]
if (!inputs.length) throw new Error("Missing bundle metadata")
const forbidden = inputs.filter((file) => /(?:packages\/|@opencode\/)(?:core|server|sdk)(?:\/|$)/.test(file))
const runtime = await Promise.all([...result.outputs, ...tui.outputs].map((output) => output.text()))
const imports = runtime.flatMap((source) => new Bun.Transpiler({ loader: "js" }).scan(source).imports)
const external = [...new Set(imports.map((item) => item.path))].sort()
if (
  forbidden.length ||
  inputs.some((file) =>
    /(?:node_modules\/(?:effect|solid-js|@opentui)\/|\/(?:effect|solid-js|@opentui\+[^/]+)@[^/]+\/)/.test(file),
  )
)
  throw new Error("The plugin must not bundle host implementations or peer runtimes")
if (
  external.some(
    (name) =>
      !isBuiltin(name) &&
      ![
        "@opencode/plugin",
        "@opencode/plugin/rpc",
        "@opencode/plugin/tui",
        "@opentui/solid",
        "solid-js",
        "effect",
      ].includes(name) &&
      !name.startsWith("effect/"),
  )
)
  throw new Error("Unexpected runtime dependency")
if (!["@opencode/plugin", "@opencode/plugin/rpc", "effect"].every((name) => external.includes(name)))
  throw new Error("Missing external peer imports")
if (runtime.some((source) => /(?:\/Users\/|\/home\/|\.codex\/worktrees|file:\/\/\/(?:Users|home)\/)/.test(source)))
  throw new Error("Plugin output contains an absolute development path")
await mkdir(`artifacts/${version}`, { recursive: true })
await Bun.write(
  `artifacts/${version}/import-boundary.json`,
  JSON.stringify({ inputCount: inputs.length, forbidden, external }, null, 2) + "\n",
)
console.log(`Built server, RPC and TUI entrypoints; ${inputs.length} source inputs, peers external.`)
