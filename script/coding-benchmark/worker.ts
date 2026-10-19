import { cp, mkdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Schema } from "effect"
import { decodePlan } from "../qualification/plan"
import { egress } from "../qualification/egress"
import { Status } from "../../src/rpc"
import type { Route } from "../../src/rpc"
import { capacity, resolvePair } from "../../src/native"

const arm = process.argv[2]
if (arm !== "baseline" && arm !== "self-driving") throw new Error("Unknown benchmark arm")
const output = resolve(process.argv[3])
const plan = decodePlan(await Bun.file(process.argv[4]).json())
const execute = process.argv.includes("--execute")
const temporary = process.env.OPENCODE_BENCH_HOME
if (!temporary) throw new Error("Isolated benchmark environment is required")
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), plan.limits.maxDurationMs)
process.once("SIGTERM", () => controller.abort())
const directory = join(temporary, "project")
await mkdir(directory, { recursive: true })
await cp(join(import.meta.dir, "fixture"), directory, { recursive: true })
await Bun.write(join(directory, "test/csv.test.ts"), await Bun.file(join(directory, "test/csv.test.ts.txt")).text())
const { unlink } = await import("node:fs/promises")
await unlink(join(directory, "test/csv.test.ts.txt"))
const files = [
  "README.md",
  "src/csv.ts",
  "src/import.ts",
  "src/cli.ts",
  "test/csv.test.ts",
  "sample.csv",
  "invalid.csv",
]
const hash = async (file: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
const before = Object.fromEntries(
  await Promise.all(files.map(async (file) => [file, await hash(join(directory, file))])),
)
const fixedModel = "openai/gpt-4.1-mini"
const targets = [
  { kind: "decision" as const, url: plan.endpoints.decision, models: new Set([plan.profile.decision.model]) },
  { kind: "generation" as const, url: plan.endpoints.backends.coding, models: new Set<string>() },
]
await using relay = egress(plan.limits, targets, controller, execute)
const routes = new Map<string, Route>()
const tools: { id: string; tool: string; status: string; path?: string; command?: string }[] = []
const terminal = Promise.withResolvers<void>()
const report = {
  schemaVersion: 1,
  arm,
  mode: execute ? "execute" : "preflight",
  planHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(plan)).digest("hex"),
  state: "preparing",
  stage: "setup",
  failureKind: undefined as string | undefined,
  elapsedMs: 0,
  steps: 0,
  permissionRequests: 0,
  toolFailures: 0,
  availableTools: [] as string[],
  routes: [] as Route[],
  tools,
  requests: relay.requests,
  budget: relay.state,
  catalogCost: undefined as number | undefined,
  messages: [] as {
    model: string
    finish?: string
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  }[],
  finalText: undefined as { length: number; sha256: string } | undefined,
  fileHashes: { before, after: {} as Record<string, string> },
  quality: "single-task-only; not-qualified",
  billing: "not-measured; catalog cost excludes decision service and is not a physical bill",
}
const ToolInput = Schema.Struct({
  path: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
  background: Schema.optional(Schema.Boolean),
})
const control = Plugin.define({
  id: "coding-benchmark-controls",
  async setup(ctx) {
    await ctx.provider.transform((editor) => {
      editor.update("openrouter", (provider) => {
        provider.activation = "enabled"
        provider.settings = { ...provider.settings, baseURL: relay.url(1) }
      })
    })
    await ctx.model.transform((editor) => {
      editor.list("openrouter").forEach((source) =>
        editor.update("openrouter", String(source.id), (model) => {
          model.settings = { ...source.settings, baseURL: relay.url(1) }
        }),
      )
    })
    await ctx.agent.transform((editor) => {
      editor.list().forEach((agent) =>
        editor.update(String(agent.id), (agent) => {
          agent.model = Model.Ref.make({
            providerID: Provider.ID.make(arm === "baseline" ? "openrouter" : "self-driving"),
            id: Model.ID.make(arm === "baseline" ? fixedModel : "auto"),
          })
          agent.steps = plan.limits.maxStepsPerCase
          agent.permissions = [
            { action: "*", resource: "*", effect: "deny" },
            ...["read", "edit", "shell"].map((action) => ({ action, resource: "*", effect: "allow" as const })),
          ]
        }),
      )
    })
    await ctx.tool.transform((editor) => {
      editor
        .list()
        .filter((tool) => !["read", "edit", "write", "shell"].includes(tool.id))
        .forEach((tool) => editor.remove(tool.id))
      report.availableTools = editor.list().map((tool) => tool.id)
    })
    await ctx.tool.hook("execute.before", (event) => {
      const input = Schema.decodeUnknownSync(ToolInput)(event.input)
      const path = input.path === undefined ? undefined : relative(directory, resolve(directory, input.path))
      if (path !== undefined && (path.startsWith("..") || path.includes("node_modules")))
        throw new Error("Benchmark file access must stay inside the task directory")
      if (["write", "edit"].includes(event.tool) && !["src/csv.ts", "src/import.ts"].includes(path ?? ""))
        throw new Error("Only the two task implementation files may be changed")
      if (
        event.tool === "shell" &&
        (!["bun test", "bun test test"].includes(input.command ?? "") ||
          (input.workdir !== undefined && resolve(directory, input.workdir) !== directory) ||
          input.background)
      )
        throw new Error("Only foreground bun test in the task directory is authorized")
      tools.push({ id: event.id, tool: event.tool, status: "started", path, command: input.command })
    })
    await ctx.tool.hook("execute.after", (event) => {
      const item = tools.findLast((tool) => tool.id === event.id)
      if (item) item.status = event.status
      if (event.status === "error") report.toolFailures++
    })
    await ctx.session.hook("context", (event) => {
      event.options.maxTokens = plan.limits.maxOutputTokens
    })
    await ctx.session.hook("title", (event) => {
      event.result = "CSV import benchmark"
    })
    await ctx.session.hook("retry", (event) => {
      event.decision = { retry: false }
    })
  },
})
ensurePluginRuntime()
const { OpenCode } = await import("@opencode/sdk")
await mkdir(join(temporary, "plugin-config"), { recursive: true })
await Bun.write(
  join(temporary, "plugin-config/opencode.json"),
  JSON.stringify({ plugins: arm === "self-driving" ? [{ package: resolve(".") }] : [] }),
)
const client = await OpenCode.create({
  plugins: [control],
  database: { path: join(temporary, "session.sqlite") },
  models: { fetch: false },
  fs: { filewatcher: false, fff: false },
  config: { directory: join(temporary, "plugin-config"), project: false, claude: false, content: "{}" },
  log: { level: "fatal", emit() {} },
})
type Input = Exclude<Parameters<typeof client.rpc.call>[0]["input"], undefined>
const mutable = (value: Schema.Json): Input => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item: Schema.Json) => mutable(item))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutable(item)]))
}
let active: string | undefined
const capture = async () => {
  if (arm !== "self-driving" || !active) return
  const response = await client.rpc.call({
    rpcID: "opencode-self-driving",
    method: "status",
    input: { sessionID: active },
    location: { directory },
  })
  const status = Schema.decodeUnknownSync(Status)(response.output)
  if (status.lastRoute) routes.set(status.lastRoute.id, status.lastRoute)
}
try {
  report.stage = "preflight"
  await client.model.list({ location: { directory } })
  const [models, providers] = await Promise.all([
    client.model.list({ location: { directory } }),
    client.provider.list({ location: { directory } }),
  ])
  capacity(plan.profile, { models: models.data, providers: providers.data })
  Object.values(plan.profile.tiers).forEach((pair) => {
    const resolved = resolvePair(plan.profile, pair, { models: models.data, providers: providers.data })
    if (resolved.settings.baseURL !== relay.url(1)) throw new Error("Model endpoint bypasses bounded relay")
    targets[1].models.add(resolved.model.modelID)
  })
  report.state = "ready"
  if (execute) {
    report.stage = "credentials"
    if (!process.env.OPENROUTER_TEST_KEY) throw new Error("Required credential unavailable")
    await client.credential.create({
      integrationID: "openrouter",
      value: { type: "key", key: process.env.OPENROUTER_TEST_KEY },
      activate: true,
    })
    delete process.env.OPENROUTER_TEST_KEY
    if (arm === "self-driving") {
      const profile = { ...plan.profile, decision: { ...plan.profile.decision, baseURL: relay.url(0) } }
      await client.rpc.call({
        rpcID: "opencode-self-driving",
        method: "draft",
        input: mutable(Schema.decodeUnknownSync(Schema.Json)({ profile })),
        location: { directory },
      })
      await client.rpc.call({ rpcID: "opencode-self-driving", method: "publish", input: {}, location: { directory } })
    }
    report.stage = "session"
    await client.plugin(
      Plugin.define({
        id: "coding-benchmark-observer",
        async setup(ctx) {
          const events = ctx.event.subscribe()[Symbol.asyncIterator]()
          const listening = (async () => {
            for await (const event of { [Symbol.asyncIterator]: () => events }) {
              if (!("sessionID" in event.data) || event.data.sessionID !== active) continue
              if (event.type === "session.step.started") report.steps++
              if (event.type === "session.step.ended") await capture()
              if (event.type === "permission.asked") {
                report.permissionRequests++
                await ctx.permission.reply({
                  sessionID: event.data.sessionID,
                  requestID: event.data.id,
                  decision: "reject",
                })
              }
              if (
                ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(
                  event.type,
                )
              ) {
                report.state = event.type.replace("session.execution.", "")
                await capture()
                terminal.resolve()
              }
            }
          })().catch(() => {
            report.failureKind = "event-collection"
            terminal.resolve()
          })
          return async () => {
            await events.return?.()
            await listening
          }
        },
      }),
    )
    const session = await client.sessions.create({ title: "CSV import benchmark", location: { directory } })
    active = session.id
    await client.sessions.switchModel({
      sessionID: session.id,
      model: Model.Ref.make({
        providerID: Provider.ID.make(arm === "baseline" ? "openrouter" : "self-driving"),
        id: Model.ID.make(arm === "baseline" ? fixedModel : "auto"),
      }),
    })
    if (arm === "self-driving") {
      await client.rpc.call({
        rpcID: "opencode-self-driving",
        method: "enable",
        input: { sessionID: session.id },
        location: { directory },
      })
      await client.rpc.call({
        rpcID: "opencode-self-driving",
        method: "policies",
        input: { sessionID: session.id, contextSelection: "inherit", approval: "off" },
        location: { directory },
      })
    }
    const started = performance.now()
    const stopped = () => {
      report.state = "cancelled"
      terminal.resolve()
      client.sessions.interrupt({ sessionID: session.id }).catch(() => undefined)
    }
    controller.signal.addEventListener("abort", stopped, { once: true })
    controller.signal.throwIfAborted()
    await client.sessions.prompt({ sessionID: session.id, text: plan.cases[0].prompt })
    await terminal.promise
    await client.sessions.wait({ sessionID: session.id })
    controller.signal.removeEventListener("abort", stopped)
    report.elapsedMs = performance.now() - started
    const messages = (await client.sessions.context({ sessionID: session.id })).filter(
      (message) => message.type === "assistant",
    )
    report.messages = messages.map((message) => ({
      model: message.model.id,
      finish: message.finish,
      tokens: message.tokens,
    }))
    report.catalogCost = messages.reduce((sum, message) => sum + (message.cost ?? 0), 0)
    const final =
      messages
        .at(-1)
        ?.content.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("") ?? ""
    report.finalText = { length: final.length, sha256: new Bun.CryptoHasher("sha256").update(final).digest("hex") }
  }
} catch (cause) {
  report.state = controller.signal.aborted ? "cancelled" : "failed"
  report.failureKind = cause instanceof Error ? cause.name : "unknown"
} finally {
  report.routes = [...routes.values()]
  report.fileHashes.after = Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await hash(join(directory, file))])),
  )
  await client.close()
  clearTimeout(timeout)
  await Promise.all(
    files.map(async (file) => {
      await mkdir(join(output, `${arm}-workspace`, dirname(file)), { recursive: true })
      await cp(join(directory, file), join(output, `${arm}-workspace`, file))
    }),
  )
  await Bun.write(join(output, `${arm}-${execute ? "live" : "preflight"}.json`), JSON.stringify(report, null, 2) + "\n")
}
