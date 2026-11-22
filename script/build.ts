import { rm } from "node:fs/promises"
import { isBuiltin } from "node:module"

await rm("dist", { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: ["src/server.ts", "src/rpc.ts"],
  outdir: "dist",
  target: "bun",
  external: ["@opencode/plugin", "@opencode/plugin/*"],
  metafile: true,
})
if (!result.success) throw new AggregateError(result.logs, "Connector build failed")
const inputs = Object.keys(result.metafile?.inputs ?? {})
if (inputs.some((path) => /\/archive\//.test(path) || (path.includes("node_modules") && !path.includes("jsonc-parser"))))
  throw new Error("Host/runtime or historical code was bundled")
for (const output of result.outputs) {
  const imports = new Bun.Transpiler({ loader: "js" }).scan(await output.text()).imports
  if (imports.some(({ path }) => !isBuiltin(path) && !path.startsWith("@opencode/plugin")))
    throw new Error("Unexpected runtime dependency")
}
console.log(`Built BitRouter server/RPC connector (${inputs.length} local inputs, host plugin API external)`)
