import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/sdk"
import type { Plugin } from "@opencode/plugin"

export async function install() {
  const directory = await mkdtemp(join(tmpdir(), "self-driving-install-"))
  const tarball = process.env.SELF_DRIVING_TARBALL
  if (!tarball) throw new Error("Run tests through bun run test after building")
  await Bun.write(join(directory, "package.json"), JSON.stringify({ name: "isolated-consumer", private: true }))
  const child = Bun.spawn(
    ["npm", "install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (result[0] !== 0) throw new Error(`Offline tarball installation failed: ${result[2]}`)
  return {
    directory,
    package: await realpath(join(directory, "node_modules/opencode-self-driving")),
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export async function host(
  target: string,
  options?: Record<string, unknown>,
  fixture: {
    plugins?: readonly Plugin.Plugin[]
    config?: Record<string, unknown>
    trailing?: string[]
    instructions?: Record<string, string>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "self-driving-host-"))
  const config = join(directory, "config/opencode.json")
  await mkdir(join(directory, "config"))
  await Promise.all(
    Object.entries(fixture.instructions ?? {}).map(([name, content]) => Bun.write(join(directory, name), content)),
  )
  const write = (enabled: boolean) =>
    Bun.write(
      config,
      JSON.stringify({
        ...fixture.config,
        ...(fixture.instructions
          ? { instructions: Object.keys(fixture.instructions).map((name) => join(directory, name)) }
          : {}),
        plugins: enabled
          ? [
              { package: target, ...(options ? { options } : {}) },
              ...(fixture.trailing ?? []).map((target) => ({ package: target })),
            ]
          : [],
      }),
    )
  await write(true)
  const client = await OpenCode.create({
    plugins: fixture.plugins,
    database: { path: join(directory, "sessions.sqlite") },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: { directory: join(directory, "config"), project: false, claude: false, content: "{}" },
  })
  await client.model.list({ location: { directory } })
  return {
    client,
    directory,
    status() {
      return client.rpc.call({ rpcID: "opencode-self-driving", method: "status", input: {}, location: { directory } })
    },
    plugins() {
      return client.plugin.list({ location: { directory } })
    },
    async enable(enabled: boolean) {
      await write(enabled)
      await client.location.reload()
      await client.model.list({ location: { directory } })
    },
    async [Symbol.asyncDispose]() {
      await client.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export async function poison(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "self-driving-effect-"))
  const target = join(directory, "plugin")
  await cp(source, target, { recursive: true })
  const fake = async (root: string) => {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "effect", type: "module", version: "4.0.1", exports: "./index.js" }),
    )
    await Bun.write(join(root, "index.js"), 'throw new Error("PRIVATE_EFFECT_MUST_NOT_LOAD")\n')
  }
  await fake(join(target, "node_modules/effect"))
  await fake(join(target, "node_modules/runtime-probe/node_modules/effect"))
  await Bun.write(
    join(target, "node_modules/runtime-probe/package.json"),
    JSON.stringify({ name: "runtime-probe", type: "module", exports: "./index.js" }),
  )
  await Bun.write(
    join(target, "node_modules/runtime-probe/index.js"),
    'export { Schema as runtimeSchema } from "effect"\n',
  )
  await Bun.write(
    join(target, "server.js"),
    `import plugin from "./dist/server.js"
import { Schema } from "effect"
import { String } from "effect/Schema"
import { runtimeSchema } from "runtime-probe"
if (Schema !== runtimeSchema || Schema.String !== String) throw new Error("Effect runtime identity differs across dependencies or subpaths")
export default plugin
`,
  )
  return {
    package: target,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
