import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/sdk"
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { temporary } from "./fixture"

test("installed package loads in OpenCode 2.3.2, adds the default and preserves manual selections", async () => {
  await using tmp = await temporary()
  const pack = Bun.spawn(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", tmp.directory], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  })
  const [code, output, errors] = await Promise.all([pack.exited, new Response(pack.stdout).text(), new Response(pack.stderr).text()])
  expect(code, errors).toBe(0)
  const packed = JSON.parse(output)[0]
  expect(packed.files.map((file: any) => file.path)).not.toContain("tui.js")
  expect(packed.files.some((file: any) => file.path.includes("archive"))).toBe(false)
  const consumer = join(tmp.directory, "consumer")
  await mkdir(consumer)
  await writeFile(join(consumer, "package.json"), '{"name":"offline-consumer","private":true}')
  const install = Bun.spawn([
    "npm", "install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
    join(tmp.directory, packed.filename),
  ], { cwd: consumer, stdout: "pipe", stderr: "pipe" })
  const result = await Promise.all([install.exited, new Response(install.stdout).text(), new Response(install.stderr).text()])
  expect(result[0], result[2]).toBe(0)
  // npm normally installs this declared peer. Supply the exact released peer
  // from the dev installation for this deliberately offline consumer.
  await mkdir(join(consumer, "node_modules/@opencode"), { recursive: true })
  await symlink(await realpath(join(import.meta.dir, "../node_modules/@opencode/plugin")), join(consumer, "node_modules/@opencode/plugin"))
  const directory = join(tmp.directory, "project")
  const configDirectory = join(tmp.directory, "config")
  await mkdir(directory)
  await mkdir(configDirectory)
  const configPath = join(configDirectory, "opencode.json")
  const config = {
    model: "local/coder",
    providers: {
      local: {
        name: "Fixture local", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:1234/v1", apiKey: "fixture-only" },
        models: { coder: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32768, output: 2048 } } },
      },
    },
    plugins: [{
      package: join(consumer, "node_modules/opencode-self-driving"),
      options: { command: [process.execPath, join(import.meta.dir, "router-fixture.ts")], stateDirectory: join(tmp.directory, "router") },
    }],
  }
  await writeFile(configPath, JSON.stringify(config))
  const client = await OpenCode.create({
    database: { path: join(tmp.directory, "sessions.sqlite") },
    models: { fetch: false }, fs: { filewatcher: false, fff: false },
    config: { directory: configDirectory, project: true, claude: false, content: "{}" },
  })
  try {
    const location = { directory }
    // Initial inventory registration must happen from host events, without a
    // user issuing sync/status to make the connector operational.
    const automatic = (async () => {
      for await (const event of client.event.subscribe({ types: ["model.updated"], signal: AbortSignal.timeout(10_000) })) {
        if (event.type !== "server.connected" && event.location?.directory !== directory) continue
        const models = (await client.model.list({ location })).data
        if (models.some((model) => model.providerID === "bitrouter")) return
      }
      throw new Error("Automatic BitRouter registration did not complete")
    })()
    await client.model.list({ location })
    await automatic
    // File watching is disabled in this isolated host; apply the authorized
    // project-only default edit explicitly, as the normal config watcher does.
    await client.location.reload()
    await client.model.list({ location })
    const status = await client.rpc.call({ rpcID: "opencode-bitrouter", method: "status", input: {}, location })
    const models = (await client.model.list({ location })).data
    expect(models.some((model) => model.providerID === "local" && model.id === "coder")).toBe(true)
    expect(models.find((model) => model.providerID === "bitrouter" && model.id === "auto")?.modelID, JSON.stringify(status.output)).toBe("bitrouter/auto")
    expect((await client.model.default({ location })).data?.providerID).toBe("bitrouter")
    expect((status.output as any).state).toBe("ready")
    const session = await client.session.create({ location })
    await client.session.switchModel({ sessionID: session.id, model: { providerID: "bitrouter", id: "auto" } })
    const generated = await client.session.generate({ sessionID: session.id, prompt: "local fixture only" })
    expect(generated.text).toBe("fixture")
    await client.session.switchModel({ sessionID: session.id, model: { providerID: "local", id: "coder" } })
    await client.rpc.call({ rpcID: "opencode-bitrouter", method: "sync", input: {}, location })
    expect((await client.session.get({ sessionID: session.id })).model?.providerID).toBe("local")
    expect((await readFile(configPath, "utf8"))).toBe(JSON.stringify(config))
    await client.rpc.call({ rpcID: "opencode-bitrouter", method: "restore", input: {}, location })
    await writeFile(configPath, JSON.stringify({ ...config, plugins: [] }))
    await client.location.reload()
    expect((await client.model.list({ location })).data.some((model) => model.providerID === "bitrouter")).toBe(false)
    expect((await client.model.default({ location })).data?.providerID).toBe("local")
  } finally { await client.close() }
})
