import { existsSync } from "node:fs"
import { mkdir, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const workspace = resolve(process.argv[2] ?? "..")
const sdk = join(workspace, "packages/sdk")
const dependencies = {
  "@ai-sdk/provider": dirname(Bun.resolveSync("@ai-sdk/provider/package.json", join(workspace, "packages/plugin"))),
  "@opencode/ai": join(workspace, "packages/ai"),
  "@opencode/plugin": join(workspace, "packages/plugin"),
  "@opencode/sdk": sdk,
  "@opencode/client": join(workspace, "packages/client"),
  "@opentui/core": dirname(Bun.resolveSync("@opentui/core/package.json", join(workspace, "packages/tui"))),
  "@opentui/solid": dirname(Bun.resolveSync("@opentui/solid/package.json", join(workspace, "packages/tui"))),
  "solid-js": dirname(Bun.resolveSync("solid-js/package.json", join(workspace, "packages/tui"))),
  effect: dirname(Bun.resolveSync("effect/package.json", sdk)),
  "@types/bun": dirname(Bun.resolveSync("@types/bun/package.json", sdk)),
  "@typescript/native": dirname(Bun.resolveSync("@typescript/native/package.json", sdk)),
}
for (const [name, source] of Object.entries(dependencies)) {
  const target = join("node_modules", name)
  await mkdir(dirname(target), { recursive: true })
  if (!existsSync(target)) await symlink(source, target, "dir")
}
await mkdir("node_modules/.bin", { recursive: true })
if (!existsSync("node_modules/.bin/tsc"))
  await symlink(join(dependencies["@typescript/native"], "bin/tsc"), "node_modules/.bin/tsc", "file")
console.log("Linked development dependencies from the OpenCode checkout; published files use peer imports only.")
