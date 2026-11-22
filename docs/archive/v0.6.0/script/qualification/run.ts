import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Effect, Schema } from "effect"
import { APICallError } from "@ai-sdk/provider"
import { capacity, resolvePair } from "../../src/native"
import { Status } from "../../src/rpc"
import type { ApprovalResult, Route } from "../../src/rpc"
import { version } from "../../package.json"
import { egress } from "./egress"
import { environmentNames } from "./plan"
import type { Plan } from "./plan"
import { metrics } from "./metrics"
import type { Sample } from "./metrics"

export async function run(plan: Plan, target: string, controller: AbortController, execute: boolean) {
  ensurePluginRuntime()
  const { OpenCode } = await import("@opencode/sdk")
  const directory = await mkdtemp(join(tmpdir(), "self-driving-qualification-"))
  const samples: Sample[] = []
  const state = {
    stage: "setup",
    active: undefined as
      | undefined
      | {
          item: Plan["cases"][number]
          sessionID: string
          result: Sample
          routes: Map<string, Route>
          approvals: Map<string, ApprovalResult>
          done: ReturnType<typeof Promise.withResolvers<void>>
        },
  }
  const missing = environmentNames(plan).filter((name) => !process.env[name])
  const targets = [
    { kind: "decision" as const, url: plan.endpoints.decision, models: new Set([plan.profile.decision.model]) },
    ...Object.keys(plan.profile.backends).map((backend) => ({
      kind: "generation" as const,
      url: plan.endpoints.backends[backend],
      models: new Set<string>(),
    })),
  ]
  await using relay = egress(plan.limits, targets, controller, execute && !missing.length)
  const ready = Promise.withResolvers<void>()
  await using mcp = echo(() => state.active)
  const control = Plugin.define({
    id: "self-driving-qualification-controls",
    async setup(ctx) {
      await ctx.provider.transform((editor) => {
        Object.entries(plan.profile.backends).forEach(([name, backend]) => {
          const index = Object.keys(plan.profile.backends).indexOf(name) + 1
          const provider = editor.get(backend.providerID)
          if (!provider) return
          editor.update(backend.providerID, (provider) => {
            provider.activation = "enabled"
            provider.settings = { ...provider.settings, baseURL: relay.url(index) }
          })
        })
      })
      await ctx.model.transform((editor) => {
        Object.entries(plan.profile.backends).forEach(([name, backend]) => {
          const index = Object.keys(plan.profile.backends).indexOf(name) + 1
          editor.list(backend.providerID).forEach((source) =>
            editor.update(backend.providerID, String(source.id), (model) => {
              model.settings = { ...source.settings, baseURL: relay.url(index) }
            }),
          )
        })
      })
      await ctx.agent.transform((editor) =>
        editor.list().forEach((agent) =>
          editor.update(String(agent.id), (agent) => {
            agent.model = Model.Ref.make({ providerID: Provider.ID.make("self-driving"), id: Model.ID.make("auto") })
            agent.steps = plan.limits.maxStepsPerCase
            agent.permissions = [
              { action: "*", resource: "*", effect: "deny" },
              { action: "qualification_echo", resource: "*", effect: "ask" },
            ]
          }),
        ),
      )
      await ctx.mcp.transform((editor) => {
        editor.set("qualification", { type: "remote", url: mcp.url, oauth: false, codemode: false })
      })
      await ctx.tool.transform((editor) => {
        editor
          .list()
          .filter((tool) => tool.id !== "qualification_echo")
          .forEach((tool) => editor.remove(tool.id))
        if (editor.get("qualification_echo")) ready.resolve()
      })
      await ctx.session.hook("context", (event) => {
        const active = state.active
        if (!active || active.sessionID !== event.sessionID) return
        active.item.resources.forEach((resource) =>
          event.system.push({
            type: "text",
            text: resource.text,
            metadata: {
              "self-driving/resource": {
                id: resource.id,
                source: "qualification",
                kind: "instruction",
                required: resource.required,
                dependencies: [],
                tools: [],
              },
            },
          }),
        )
        if (!active.item.tool) event.tools = {}
      })
      await ctx.session.hook("retry", (event) => {
        event.decision = { retry: false }
      })
    },
  })
  const report = {
    schemaVersion: 1,
    version,
    mode: execute ? "execute" : "preflight",
    planHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(plan)).digest("hex"),
    endpoints: targets.map((target) => ({ kind: target.kind, url: target.url })),
    limits: plan.limits,
    missingEnvironment: missing,
    state: "blocked",
    failureStage: undefined as string | undefined,
    failureReason: undefined as string | undefined,
    capacity: undefined as ReturnType<typeof capacity> | undefined,
    catalog: [] as { backend: string; providerFound: boolean; model: string; enabled?: boolean; package?: string }[],
    physicalModels: [] as {
      backend: string
      model: string
      physicalModel: string
      limit: { context: number; input?: number; output: number }
    }[],
    requests: relay.requests,
    network: { loopbackRequests: 0, providerRequests: 0 },
    budget: relay.state,
    samples,
    metrics: {},
    quality: "not-qualified",
    billing: "unknown; catalog estimates and reported tokens are not physical invoices",
  }
  await mkdir(join(directory, "config"))
  await Bun.write(join(directory, "config/opencode.json"), JSON.stringify({ plugins: [{ package: target }] }))
  const client = await OpenCode.create({
    plugins: [control],
    database: { path: join(directory, "session.sqlite") },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: { directory: join(directory, "config"), project: false, claude: false, content: "{}" },
    log: { level: "fatal", emit() {} },
  })
  type Input = Exclude<Parameters<typeof client.rpc.call>[0]["input"], undefined>
  const mutable = (value: Schema.Json): Input => {
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map((item: Schema.Json) => mutable(item))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutable(item)]))
  }
  const rpc = async (method: string, input: Schema.Json = {}) =>
    (
      await client.rpc.call(
        { rpcID: "opencode-self-driving", method, input: mutable(input), location: { directory } },
        { signal: controller.signal },
      )
    ).output
  const capture = async () => {
    const active = state.active
    if (!active) return
    const status = Schema.decodeUnknownSync(Status)(await rpc("status", { sessionID: active.sessionID }))
    if (status.lastRoute) active.routes.set(status.lastRoute.id, status.lastRoute)
    if (status.lastApproval)
      active.approvals.set(JSON.stringify(status.lastApproval.source ?? status.lastApproval), status.lastApproval)
  }
  const interrupted = () => {
    if (state.active) state.active.result.outcome = "cancelled"
    state.active?.done.reject(new Error("Qualification cancelled"))
    if (state.active) client.sessions.interrupt({ sessionID: state.active.sessionID }).catch(() => undefined)
  }
  controller.signal.addEventListener("abort", interrupted, { once: true })
  try {
    state.stage = "catalog"
    // Finish ordinary plugin initialization before reading catalogs concurrently.
    await client.model.list({ location: { directory } })
    const [models, providers] = await Promise.all([
      client.model.list({ location: { directory } }),
      client.provider.list({ location: { directory } }),
    ])
    Object.entries(plan.profile.backends).forEach(([backend, configured]) => {
      const provider = providers.data.find((provider) => provider.id === configured.providerID)
      const pairs = [...Object.values(plan.profile.tiers), ...Object.values(plan.profile.auxiliary)].filter(
        (pair) => pair.backend === backend,
      )
      Array.from(new Set(pairs.map((pair) => pair.model))).forEach((id) => {
        const model = models.data.find((model) => model.providerID === configured.providerID && model.id === id)
        report.catalog.push({
          backend,
          providerFound: !!provider,
          model: id,
          enabled: model?.enabled,
          package: model?.package ?? provider?.package,
        })
      })
    })
    report.capacity = capacity(plan.profile, { models: models.data, providers: providers.data })
    Object.keys(plan.profile.backends).forEach((backend, index) => {
      const pairs = [...Object.values(plan.profile.tiers), ...Object.values(plan.profile.auxiliary)].filter(
        (pair) => pair.backend === backend,
      )
      pairs.forEach((pair) => {
        if (
          resolvePair(plan.profile, pair, { models: models.data, providers: providers.data }).settings.baseURL !==
          relay.url(index + 1)
        )
          throw new Error("Effective native endpoint bypasses the qualification relay")
        const model = models.data.find(
          (model) => model.providerID === plan.profile.backends[backend].providerID && model.id === pair.model,
        )
        if (!model) throw new Error("Physical model unavailable")
        targets[index + 1].models.add(model.modelID)
        if (!report.physicalModels.some((item) => item.backend === backend && item.model === model.id))
          report.physicalModels.push({ backend, model: model.id, physicalModel: model.modelID, limit: model.limit })
      })
    })
    report.state = missing.length ? "blocked" : "ready"
    if (!execute || missing.length) return report
    state.stage = "credentials"
    await Promise.all(
      Object.entries(plan.credentials).map(([integrationID, name]) =>
        client.credential.create({
          integrationID,
          value: { type: "key", key: process.env[name] ?? "" },
          activate: true,
        }),
      ),
    )
    const configured = { ...plan.profile, decision: { ...plan.profile.decision, baseURL: relay.url(0) } }
    state.stage = "publish"
    await rpc("draft", { profile: Schema.decodeUnknownSync(Schema.Json)(configured) })
    await rpc("publish")
    await client.plugin(
      Plugin.define({
        id: "self-driving-qualification-observer",
        async setup(ctx) {
          await ctx.session.hook("context", () => capture())
          await ctx.tool.hook("execute.after", () => capture())
          await ctx.permission.hook("evaluate", () => capture())
          const events = ctx.event.subscribe()[Symbol.asyncIterator]()
          const listening = (async () => {
            for await (const event of { [Symbol.asyncIterator]: () => events }) {
              const active = state.active
              if (!active || !("sessionID" in event.data) || event.data.sessionID !== active.sessionID) continue
              if (event.type === "permission.asked") {
                const expected = active.item.tool
                const allowed =
                  !!expected &&
                  !expected.needsHuman &&
                  event.data.action === "qualification_echo" &&
                  JSON.stringify(event.data.metadata?.input) === JSON.stringify({ text: expected.text })
                active.result.manualReplies++
                await ctx.permission.reply({
                  sessionID: active.sessionID,
                  requestID: event.data.id,
                  decision: allowed ? "once" : "reject",
                })
              }
              if (event.type === "session.step.started") active.result.steps++
              if (
                event.type === "session.execution.succeeded" ||
                event.type === "session.execution.failed" ||
                event.type === "session.execution.interrupted"
              ) {
                active.result.outcome =
                  event.type === "session.execution.succeeded"
                    ? "succeeded"
                    : event.type === "session.execution.interrupted"
                      ? "cancelled"
                      : "failed"
                await capture()
                active.done.resolve()
              }
            }
          })().catch(() => state.active?.done.reject(new Error("Qualification event collection failed")))
          return async () => {
            await events.return?.()
            await listening
          }
        },
      }),
    )
    state.stage = "cases"
    await Effect.runPromise(
      Effect.tryPromise({ try: () => ready.promise, catch: () => new Error("MCP unavailable") }),
      { signal: controller.signal },
    )
    for (const item of plan.cases) {
      controller.signal.throwIfAborted()
      const session = await client.sessions.create({ title: "Self-driving qualification", location: { directory } })
      await rpc("enable", { sessionID: session.id })
      await rpc("policies", { sessionID: session.id, contextSelection: item.contextSelection, approval: item.approval })
      const result: Sample = {
        id: item.id,
        split: item.split,
        outcome: "failed",
        elapsedMs: 0,
        ...(item.expectedText ? { textMatch: false } : {}),
        toolCalls: 0,
        toolMatches: 0,
        manualReplies: 0,
        steps: 0,
        routes: [],
        approvals: [],
      }
      const active = {
        item,
        sessionID: session.id,
        result,
        routes: new Map<string, Route>(),
        approvals: new Map<string, ApprovalResult>(),
        done: Promise.withResolvers<void>(),
      }
      state.active = active
      // Observe rejection immediately, including a budget abort before native prompt admission.
      const finished = active.done.promise.catch(() => undefined)
      const started = performance.now()
      samples.push(result)
      await client.sessions.prompt({ sessionID: session.id, text: item.prompt })
      await finished
      await client.sessions.wait({ sessionID: session.id })
      result.elapsedMs = performance.now() - started
      result.routes = [...active.routes.values()]
      result.approvals = [...active.approvals.values()]
      if (item.tool)
        result.toolExpectationMet = item.tool.needsHuman ? result.toolCalls === 0 : result.toolMatches === 1
      if (item.expectedText) {
        const messages = await client.sessions.context({ sessionID: session.id })
        const assistant = messages.filter((message) => message.type === "assistant").at(-1)
        const parts = assistant?.type === "assistant" ? assistant.content.filter((part) => part.type === "text") : []
        const actual = parts
          .map((part) => part.text)
          .join("")
          .trim()
        const difference = Array.from({ length: Math.max(actual.length, item.expectedText.length) }).findIndex(
          (_, index) => actual[index] !== item.expectedText?.[index],
        )
        result.textMatch = assistant?.type === "assistant" && actual === item.expectedText
        // Diagnose formatting or missing text without retaining generated content.
        // These fields do not relax the exact-match acceptance rule.
        result.textComparison = {
          assistantPresent: assistant?.type === "assistant",
          textParts: parts.length,
          actualLength: actual.length,
          expectedLength: item.expectedText.length,
          actualSha256: new Bun.CryptoHasher("sha256").update(actual).digest("hex"),
          expectedSha256: new Bun.CryptoHasher("sha256").update(item.expectedText).digest("hex"),
          ...(difference < 0
            ? {}
            : {
                firstDifference: {
                  utf16Offset: difference,
                  actualCodePoint: actual.codePointAt(difference) ?? null,
                  expectedCodePoint: item.expectedText.codePointAt(difference) ?? null,
                },
              }),
        }
      }
      state.active = undefined
      if (result.outcome !== "succeeded" || result.textMatch === false || result.toolExpectationMet === false) break
    }
    report.state =
      !controller.signal.aborted &&
      samples.length === plan.cases.length &&
      samples.every(
        (sample) => sample.outcome === "succeeded" && sample.textMatch !== false && sample.toolExpectationMet !== false,
      )
        ? "completed"
        : "incomplete"
    return report
  } catch (cause) {
    report.failureStage = state.stage
    if (state.stage === "catalog" && APICallError.isInstance(cause) && cause.url === "self-driving://request")
      report.failureReason = cause.message
    report.state = controller.signal.aborted ? "cancelled" : "failed"
    return report
  } finally {
    if (state.active) {
      state.active.result.routes = [...state.active.routes.values()]
      state.active.result.approvals = [...state.active.approvals.values()]
    }
    report.metrics = metrics(plan, samples)
    relay.requests.forEach((request) => {
      if (["127.0.0.1", "localhost", "[::1]"].includes(new URL(targets[request.target].url).hostname))
        report.network.loopbackRequests++
      else report.network.providerRequests++
    })
    controller.signal.removeEventListener("abort", interrupted)
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function echo(active: () => { item: Plan["cases"][number]; result: Sample } | undefined) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message = Schema.decodeUnknownSync(
        Schema.Struct({
          id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
          method: Schema.String,
          params: Schema.optional(Schema.JsonObject),
        }),
      )(await request.json())
      if (message.id === undefined) return new Response(null, { status: 202 })
      const current = active()
      const matched =
        !!current?.item.tool &&
        JSON.stringify(message.params?.arguments) === JSON.stringify({ text: current.item.tool.text })
      if (message.method === "tools/call" && current) {
        current.result.toolCalls++
        if (matched) current.result.toolMatches++
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "qualification", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Return the exact supplied text without side effects",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                      required: ["text"],
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? {
                  content: [
                    {
                      type: "text",
                      text: matched ? (current?.item.tool?.text ?? "") : "Qualification tool input mismatch",
                    },
                  ],
                  isError: !matched,
                }
              : {}
      return Response.json({ jsonrpc: "2.0", id: message.id, result })
    },
  })
  return {
    url: server.url.href,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}
