import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { version } from "../package.json"

if (Bun.version !== "1.4.2") throw new Error("Run with Bun 1.4.2 on PATH")
if (!(await Bun.file("dist/server.js").exists())) throw new Error("Run bun run build before package tests")
const artifacts = `artifacts/${version}`
await mkdir(artifacts, { recursive: true })
const pack = Bun.spawn(["npm", "pack", "--ignore-scripts", "--pack-destination", artifacts], {
  stdout: "pipe",
  stderr: "pipe",
})
const packed = await Promise.all([pack.exited, new Response(pack.stdout).text(), new Response(pack.stderr).text()])
if (packed[0] !== 0) throw new Error(`Package pack failed: ${packed[2]}`)
const directory = await mkdtemp(join(tmpdir(), "self-driving-test-env-"))
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--preload",
    "./test/preload.ts",
    "./test",
    ...process.argv.slice(2),
    "--timeout",
    "10000",
    "--reporter=junit",
    `--reporter-outfile=${resolve(artifacts, "results.xml")}`,
  ],
  {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      USERPROFILE: directory,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      OPENCODE_TEST_HOME: directory,
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_FILEWATCHER: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      SELF_DRIVING_TARBALL: resolve(artifacts, `opencode-self-driving-${version}.tgz`),
      SELF_DRIVING_TEST_KEY: "fixture-key-not-a-live-credential",
      CI: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
)
const collect = async (source: ReadableStream<Uint8Array>, output: Pick<typeof process.stdout, "write">) => {
  const chunks: string[] = []
  for await (const chunk of source) {
    const value = new TextDecoder().decode(chunk)
    chunks.push(value)
    output.write(value)
  }
  return chunks.join("")
}
const result = await Promise.all([
  child.exited,
  collect(child.stdout, process.stdout),
  collect(child.stderr, process.stderr),
])
await Bun.write(`${artifacts}/results.log`, result[1] + result[2])
await rm(directory, { recursive: true, force: true })
process.exit(result[0])
