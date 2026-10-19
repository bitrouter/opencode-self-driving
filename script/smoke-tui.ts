import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { OpenCode } from "@opencode/client"
import { Schema } from "effect"
import { version } from "../package.json"
import { Status } from "../src/rpc"
import { install } from "../test/fixture"
import { chat, endpoint, profile } from "../test/routing-fixture"
import { mcp } from "../test/policy-fixture"

// A real CLI + terminal acceptance run. All model and MCP traffic stays on loopback.
if (Bun.version !== "1.4.2") throw new Error("Use the qualified Bun 1.4.2")
if (!process.argv[2]) throw new Error("Usage: bun run smoke:tui <qualified OpenCode workspace>")
const workspace = resolve(process.argv[2])
const output = resolve(`artifacts/${version}/tui-${Date.now()}`)
await mkdir(output, { recursive: true })
process.env.SELF_DRIVING_TARBALL = resolve(`artifacts/${version}/opencode-self-driving-${version}.tgz`)
await using installed = await install()
await using tool = mcp()
await using wire = endpoint({
  generation(body) {
    const messages = Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(body.messages)
    if (messages.some((message) => message.role === "tool"))
      return chat(body.model, { content: "SELF_DRIVING_LIVE_OK" })
    const tools = Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(body.tools ?? [])
    if (!tools.length) return chat(body.model, { content: "Self-driving acceptance" })
    return chat(
      body.model,
      {
        tool_calls: [
          {
            index: 0,
            id: "smoke-call",
            type: "function",
            function: { name: "fixture_echo", arguments: JSON.stringify({ text: "LIVE_FIXTURE_ECHO" }) },
          },
        ],
      },
      "tool_calls",
    )
  },
})
const directory = await realpath(await mkdtemp(join(tmpdir(), "self-driving-tui-")))
const socket = `self-driving-${crypto.randomUUID()}`
const environment = {
  PATH: `${join(directory, "bin")}:${process.env.PATH}`,
  HOME: directory,
  USERPROFILE: directory,
  TMPDIR: directory,
  TMP: directory,
  TEMP: directory,
  XDG_CONFIG_HOME: join(directory, "config"),
  XDG_CACHE_HOME: join(directory, "cache"),
  XDG_DATA_HOME: join(directory, "data"),
  XDG_STATE_HOME: join(directory, "state"),
  OPENCODE_CONFIG_DIR: join(directory, "config/opencode"),
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_DB: join(directory, "sessions.sqlite"),
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_FFF: "true",
  SELF_DRIVING_TEST_KEY: "fixture-key-not-a-live-credential",
  TERM: "xterm-256color",
}
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const cli = [process.execPath, "run", "--cwd", join(workspace, "packages/cli"), "src/index.ts"]
async function execute(command: string[]) {
  const child = Bun.spawn(command, { cwd: workspace, env: environment, stdout: "pipe", stderr: "pipe" })
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (result[0] !== 0) throw new Error(`Acceptance command failed: ${command[0]} ${command[1]}`)
  return result[1]
}
const tmux = (...args: string[]) => execute(["tmux", "-L", socket, ...args])
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const value = await read()
    if (ready(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Acceptance deadline: ${description}`)
}
const frame = () => tmux("capture-pane", "-p", "-t", "ui", "-S", "0")
const screen = (text: string) => until(frame, (value) => value.includes(text), text)
const keys = (...input: string[]) => tmux("send-keys", "-t", "ui", ...input)
const text = (input: string) => tmux("send-keys", "-t", "ui", "-l", input)
async function command(input: string) {
  await text(`/self-driving ${input}`)
  await keys("Enter")
}
const report = {
  schemaVersion: 1,
  version,
  state: "failed",
  evidence: "installed-tarball + native V2 CLI/TUI + loopback HTTP/MCP",
  realProviderRequests: 0,
  stages: [] as string[],
  output,
}
const progress = (stage: string) => {
  report.stages.push(stage)
  console.log(stage)
}
await Bun.write(join(directory, "fixture/server.ts"), await Bun.file("script/smoke-fixture.ts").text())
await Bun.write(
  join(environment.OPENCODE_CONFIG_DIR, "opencode.json"),
  JSON.stringify({
    plugins: [
      { package: join(directory, "fixture"), options: { wireURL: wire.url, mcpURL: tool.url } },
      { package: installed.package },
    ],
  }),
)
await Bun.write(join(directory, "bin/opencode"), `#!/bin/sh\nexec ${cli.map(shell).join(" ")} "$@"\n`)
await execute(["chmod", "+x", join(directory, "bin/opencode")])
const server = Bun.spawn([...cli, "--print-logs", "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: workspace,
  env: environment,
  stdout: "pipe",
  stderr: "pipe",
})
const logs = { out: "", error: "" }
const collect = async (stream: ReadableStream<Uint8Array>, name: keyof typeof logs) => {
  for await (const chunk of stream) logs[name] += new TextDecoder().decode(chunk)
}
const logging = Promise.all([collect(server.stdout, "out"), collect(server.stderr, "error")])
try {
  await until(
    async () => logs.out,
    (value) => /server listening on http:\/\//.test(value),
    "server startup",
  )
  const baseUrl = logs.out.match(/server listening on (http:\/\/[^\s]+)/)?.[1]
  if (!baseUrl) throw new Error("No isolated service URL")
  const password = (await execute([...cli, "service", "get", "password"])).trim()
  const client = OpenCode.make({
    baseUrl,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })
  const location = { directory }
  const rpc = async (method: string, input = {}) =>
    (await client.rpc.call({ rpcID: "opencode-self-driving", method, input, location })).output
  await client.credential.create({
    integrationID: "openai",
    value: { type: "key", key: environment.SELF_DRIVING_TEST_KEY },
    activate: true,
  })
  await until(
    () => client.model.list({ location }),
    (value) => value.data.some((model) => model.providerID === "fixture-openai"),
    "configured fixture catalog activation",
  )
  await Bun.write(join(output, "host-config.json"), JSON.stringify(await client.config.get({ location }), null, 2))
  await Bun.write(join(output, "plugins.json"), JSON.stringify(await client.plugin.list({ location }), null, 2))
  await Bun.write(join(output, "models.json"), JSON.stringify(await client.model.list({ location }), null, 2))
  await client.rpc.call(
    { rpcID: "self-driving-smoke", method: "ready", input: {}, location },
    { signal: AbortSignal.timeout(30_000) },
  )
  const session = await client.session.create({
    title: "Self-driving terminal acceptance",
    location,
    model: { providerID: "fixture-openai", id: "low", variant: "high" },
  })
  const status = async () => Schema.decodeUnknownSync(Status)(await rpc("status", { sessionID: session.id }))
  progress("isolated service + installed server plugin ready")
  await Bun.write(
    join(directory, "launch.sh"),
    `#!/bin/sh\ncd ${shell(workspace)}\nexec ${shell(process.execPath)} run dev:live ${shell(directory)} --session ${shell(session.id)} --print-logs 2>${shell(join(output, "client.log"))}\n`,
  )
  const terminal = Bun.spawn(
    [
      "tmux",
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "ui",
      "-x",
      "110",
      "-y",
      "42",
      "sh",
      join(directory, "launch.sh"),
    ],
    { cwd: workspace, env: environment, stdout: "ignore", stderr: "ignore" },
  )
  if ((await terminal.exited) !== 0) throw new Error("Could not create isolated terminal")
  await screen("Self-driving: configure")
  await command("config")
  await screen("Self-driving profile")
  const configuration = {
    ...profile(wire.url),
    resources: { tauOmit: 0.1 },
    approval: { tauAllow: 0.05, timeoutMs: 5000, maxBytes: 500000, maxTokens: 500000, mcpServers: ["fixture"] },
  }
  await Bun.write(join(directory, "profile.json"), JSON.stringify(configuration))
  await tmux("load-buffer", join(directory, "profile.json"))
  await tmux("paste-buffer", "-p", "-t", "ui")
  await keys("Enter")
  await screen("Publish reviewed profile")
  await text("Publish reviewed profile")
  await keys("Enter")
  await screen("Publish self-driving profile")
  await Bun.write(join(output, "publish-confirm.txt"), await frame())
  await keys("Enter")
  await until(status, (value) => value.state === "configured", "profile publication")
  progress("TUI profile import + explicit publication")
  await command("on")
  await until(status, (value) => value.enabled, "enable")
  await command("policies")
  await screen("Context selection")
  await text("Select")
  await keys("Enter")
  await screen("Tool approval")
  await text("Auto")
  await keys("Enter")
  await until(
    status,
    (value) => value.contextSelection === "select" && value.approval === "auto",
    "independent policies",
  )
  progress("TUI enable + explicit context select / MCP auto approval")
  await text("Call fixture_echo exactly once with text LIVE_FIXTURE_ECHO and return SELF_DRIVING_LIVE_OK.")
  await keys("Enter")
  await until(
    async () => ({ status: await status(), session: await client.session.get({ sessionID: session.id }) }),
    (value) =>
      value.session.outcome === "succeeded" &&
      value.status.lastApproval?.outcome === "allowed" &&
      tool.calls.length === 1,
    "native MCP continuation",
  )
  const completed = await status()
  if (!completed.lastRoute?.resources?.omitted.includes("smoke-optional"))
    throw new Error("Resource selection was not applied")
  if (completed.lastRoute.tier !== "medium") throw new Error("Unexpected primary route")
  await Bun.write(join(output, "status.json"), JSON.stringify(completed, null, 2) + "\n")
  await Bun.write(
    join(output, "session-log.json"),
    JSON.stringify(await Array.fromAsync(client.session.log({ sessionID: session.id })), null, 2) + "\n",
  )
  await command("status")
  await screen("Physical target:")
  await until(frame, (value) => !value.includes("Session policies updated"), "status toast dismissed")
  await Bun.write(join(output, "status-wide.txt"), await frame())
  await tmux("resize-window", "-t", "ui", "-x", "60", "-y", "42")
  await screen("Physical target:")
  await Bun.write(join(output, "status-narrow.txt"), await frame())
  progress("native tool continuation + routing/resource/approval status at wide and narrow widths")
  await screen("esc close")
  await keys("Escape")
  await screen("SD:medium")
  await Bun.write(join(output, "footer-narrow.txt"), await frame())
  await command("off")
  await until(
    status,
    (value) => !value.enabled && value.approval === "off" && value.contextSelection === "inherit",
    "disable",
  )
  const restored = await client.session.get({ sessionID: session.id })
  if (
    restored.model?.providerID !== "fixture-openai" ||
    restored.model.id !== "low" ||
    restored.model.variant !== "high"
  )
    throw new Error("Original model and variant were not restored")
  progress("TUI disable restores original model + variant and resets Session policies")
  const config = await rpc("config")
  await client.location.reload()
  await client.model.list({ location })
  if (JSON.stringify(config) !== JSON.stringify(await rpc("config")))
    throw new Error("Published configuration changed on reload")
  progress("public Location reload retains published configuration")
  report.state = "passed"
} catch (error) {
  await Bun.write(join(output, "failure-screen.txt"), await frame().catch(() => "TUI not running"))
  console.error(error instanceof Error ? error.message : "Acceptance failed")
  process.exitCode = 1
} finally {
  await tmux("kill-server").catch(() => undefined)
  server.kill("SIGTERM")
  await server.exited
  await logging
  await Bun.write(join(output, "server.log"), logs.out + logs.error)
  const hostLog = Bun.file(join(directory, "data/opencode/log/opencode-local.log"))
  if (await hostLog.exists()) await Bun.write(join(output, "host.log"), hostLog)
  await Bun.write(
    join(output, "report.json"),
    JSON.stringify(
      {
        ...report,
        loopbackRequests: wire.calls.map((call) => ({ path: call.path, model: call.body.model })),
        toolCalls: tool.calls,
      },
      null,
      2,
    ) + "\n",
  )
  await rm(directory, { recursive: true, force: true })
  console.log(`Acceptance report: ${output}`)
}
