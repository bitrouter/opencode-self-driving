import { expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DefaultModel } from "../src/default"
import type { Plugin } from "@opencode/plugin"
import { temporary } from "./fixture"

function storage() {
  const data = new Map<string, unknown>()
  return {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => { data.set(key, value) },
    remove: async (key: string) => { data.delete(key) },
  } as Plugin.Context["storage"]
}
test("changes only model in JSONC, preserves comments and restores the previous value", async () => {
  await using tmp = await temporary()
  await mkdir(join(tmp.directory, ".opencode"))
  const path = join(tmp.directory, ".opencode/opencode.jsonc")
  const original = '{\n  // user-owned provider remains untouched\n  "model": "local/coder",\n  "providers": { "custom": { "name": "Keep me" } },\n}\n'
  await writeFile(path, original)
  const state = storage()
  const defaults = new DefaultModel(tmp.directory, state)
  await defaults.install("local/coder")
  const changed = await readFile(path, "utf8")
  expect(changed).toBe(original.replace("local/coder", "bitrouter/auto"))
  const reloaded = new DefaultModel(tmp.directory, state)
  await reloaded.install("different/fallback")
  expect((await reloaded.saved())?.source).toBe("local/coder")
  await reloaded.restore()
  expect(await readFile(path, "utf8")).toBe(original)
  await reloaded.install()
  expect(reloaded.enabled).toBe(false)
})
test("restore never overwrites a later user model selection", async () => {
  await using tmp = await temporary()
  const defaults = new DefaultModel(tmp.directory, storage())
  await defaults.install()
  const path = join(tmp.directory, ".opencode/opencode.jsonc")
  await writeFile(path, '{ "model": "user/chosen", "instructions": ["keep.md"] }\n')
  await defaults.restore()
  expect(await readFile(path, "utf8")).toContain("user/chosen")
})
test("removes only its own otherwise-empty file and leaves invalid JSONC unchanged", async () => {
  await using tmp = await temporary()
  const defaults = new DefaultModel(tmp.directory, storage())
  await defaults.install()
  const path = join(tmp.directory, ".opencode/opencode.jsonc")
  expect(await Bun.file(path).exists()).toBe(true)
  await defaults.restore()
  expect(await Bun.file(path).exists()).toBe(false)
  await writeFile(path, "{ invalid")
  const invalid = new DefaultModel(tmp.directory, storage())
  await expect(invalid.install()).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("{ invalid")
})

test("shared plugin storage never restores another project's default", async () => {
  await using first = await temporary()
  await using second = await temporary()
  const state = storage()
  const a = new DefaultModel(first.directory, state)
  const b = new DefaultModel(second.directory, state)
  await a.install("first/original")
  await b.install("second/original")
  expect((await a.saved())?.source).toBe("first/original")
  expect((await b.saved())?.source).toBe("second/original")
  await b.restore()
  expect(await Bun.file(join(second.directory, ".opencode/opencode.jsonc")).exists()).toBe(false)
  expect(await readFile(join(first.directory, ".opencode/opencode.jsonc"), "utf8")).toContain("bitrouter/auto")
})

test("restore preserves unrelated edits and comments when model was originally absent", async () => {
  await using tmp = await temporary()
  await mkdir(join(tmp.directory, ".opencode"))
  const path = join(tmp.directory, ".opencode/opencode.jsonc")
  await writeFile(path, '{\n  // keep this comment\n  "instructions": ["original.md"],\n}\n')
  const defaults = new DefaultModel(tmp.directory, storage())
  await defaults.install()
  await writeFile(path, (await readFile(path, "utf8")).replace("original.md", "later.md"))
  await defaults.restore()
  const restored = await readFile(path, "utf8")
  expect(restored).toContain("// keep this comment")
  expect(restored).toContain("later.md")
  expect(restored).not.toContain('"model"')
})

test("a symlinked configuration directory cannot redirect the project edit elsewhere", async () => {
  await using project = await temporary()
  await using outside = await temporary()
  const path = join(outside.directory, "opencode.jsonc")
  await writeFile(path, '{ "model": "outside/owned" }\n')
  await symlink(outside.directory, join(project.directory, ".opencode"))
  await expect(new DefaultModel(project.directory, storage()).install()).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe('{ "model": "outside/owned" }\n')
})
