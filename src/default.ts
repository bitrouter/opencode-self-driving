import { applyEdits, modify, parse } from "jsonc-parser"
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"

interface Record {
  path: string
  created: boolean
  present: boolean
  previous?: unknown
  source?: string
  phase: "applied" | "restored"
}
const automatic = "bitrouter/auto"
const read = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined
  throw new Error("Cannot read default model configuration")
})
function document(text: string) {
  const errors: import("jsonc-parser").ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Default model configuration must be a valid JSONC object")
  return value as { model?: unknown }
}
async function regularDirectory(path: string) {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error("Cannot inspect project configuration directory")
  })
  if (metadata?.isSymbolicLink()) throw new Error("Refusing a symlinked project configuration directory")
}

/** One reversible field edit. Reload/unload never rewrites the file or fights a user's later edit. */
export class DefaultModel {
  enabled = false
  private get key() { return `connector-default-v1/${createHash("sha256").update(this.directory).digest("hex")}` }
  constructor(readonly directory: string, readonly storage: Plugin.Context["storage"]) {}
  async saved(): Promise<Record | undefined> { return await this.storage.get(this.key) as Record | undefined }
  async install(source?: string) {
    const saved = await this.saved()
    if (saved) {
      const text = await read(saved.path)
      this.enabled = saved.phase === "applied" && text !== undefined && document(text).model === automatic
      return
    }
    const directory = join(this.directory, ".opencode")
    await regularDirectory(directory)
    const jsonc = join(directory, "opencode.jsonc")
    const json = join(directory, "opencode.json")
    const path = (await read(jsonc)) !== undefined ? jsonc : (await read(json)) !== undefined ? json : jsonc
    const original = await read(path)
    const parsed = document(original ?? "{}")
    const record: Record = {
      path, created: original === undefined, present: Object.hasOwn(parsed, "model"),
      ...(parsed.model !== undefined ? { previous: parsed.model } : {}), ...(source ? { source } : {}),
      phase: "applied",
    }
    // If the user already owns this default, do not manufacture ownership of it.
    if (parsed.model === automatic) { this.enabled = true; return }
    const next = applyEdits(original ?? "{}\n", modify(original ?? "{}\n", ["model"], automatic, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }))
    await this.storage.set(this.key, record as any)
    await this.replace(path, original, next)
    this.enabled = true
  }
  async restore() {
    const saved = await this.saved()
    this.enabled = false
    if (!saved || saved.phase === "restored") return
    await regularDirectory(dirname(saved.path))
    const original = await read(saved.path)
    if (original !== undefined && document(original).model === automatic) {
      const next = applyEdits(original, modify(original, ["model"], saved.present ? saved.previous : undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }))
      // Remove a connector-created file only if no unrelated content has since been added.
      if (saved.created && !Object.keys(document(next)).length && next.replace(/\s|[{}]/g, "") === "") {
        if (await read(saved.path) !== original) throw new Error("Default model configuration changed concurrently")
        await rm(saved.path)
      } else await this.replace(saved.path, original, next)
    }
    await this.storage.set(this.key, { ...saved, phase: "restored" } as any)
  }
  private async replace(path: string, previous: string | undefined, next: string) {
    await regularDirectory(dirname(path))
    await mkdir(dirname(path), { recursive: true })
    const metadata = await lstat(path).catch(() => undefined)
    if (metadata?.isSymbolicLink()) throw new Error("Refusing to replace a symlinked configuration")
    const temporary = `${path}.bitrouter-${crypto.randomUUID()}`
    try {
      const mode = metadata ? (await stat(path)).mode & 0o777 : 0o600
      await writeFile(temporary, next, { mode, flag: "wx" })
      if (await read(path) !== previous) throw new Error("Default model configuration changed concurrently")
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
}
