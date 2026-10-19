import { afterAll, expect, test } from "bun:test"
import { install } from "./fixture"
import { chat, decision, endpoint, laterPlugin, profile, routing } from "./routing-fixture"
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { TIERS } from "../src/config"
import { join } from "node:path"

const installed = await install()
afterAll(() => installed[Symbol.asyncDispose]())

test("published profile routes a real Session through native Evaluation and native HTTP streaming", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const published = await proof.publish()
  expect(published.limit.input).toBe(997_952)
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement the requested change")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect(JSON.stringify(events)).toContain("physical:medium")
  expect((await proof.inspect(session.id)).lastRoute).toMatchObject({
    tier: "medium",
    selection: "decision",
    eligibleTiers: ["low", "medium", "high", "xhigh", "max"],
    decision: { inputTokens: 11, outputTokens: 1 },
    generationUsage: { inputTokens: 23, outputTokens: 7 },
  })
  expect(wire.calls.some((call) => call.path.endsWith("/systemone"))).toBe(true)
  expect(wire.calls.find((call) => call.body.model === "medium")?.body.reasoning_effort).toBe("low")
  expect(JSON.stringify(await proof.rpc("config"))).not.toContain("fixture-key-not-a-live-credential")
  await proof.rpc("disable", { sessionID: session.id })
  expect((await proof.client.sessions.get({ sessionID: session.id })).model).toEqual({
    providerID: "fixture-openai",
    id: "low",
    variant: "high",
  })
})

test.each(["opencode", "openrouter", "vercel-ai-gateway"] as const)(
  "uses the native %s Evaluation selector",
  async (service) => {
    await using wire = endpoint({ choice: "high" })
    await using proof = await routing(installed.package, wire.url)
    const configuration = profile(wire.url)
    await proof.publish({ ...configuration, decision: { ...configuration.decision, service } })
    const session = await proof.session()
    const events = await proof.prompt(session.id, "Implement this change")
    expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
    expect((await proof.inspect(session.id)).lastRoute).toMatchObject({ tier: "high", decision: { service } })
    expect(
      wire.calls.some((call) => call.path.endsWith(service === "vercel-ai-gateway" ? "/evaluate" : "/systemone")),
    ).toBe(true)
  },
)

test("OpenRouter generation maps the configured native reasoning variant", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, { service: "openrouter" })
  const configuration = profile(wire.url)
  await proof.publish({
    ...configuration,
    backends: { coding: { ...configuration.backends.coding, service: "openrouter" } },
  })
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect(wire.calls.find((call) => call.path.endsWith("/chat/completions"))?.body.reasoning).toMatchObject({
    effort: "low",
  })
})

test("draft validation and failed publication leave the last usable profile intact", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const published = await proof.publish()
  await expect(
    proof.rpc("draft", {
      profile: { ...Schema.decodeUnknownSync(Schema.JsonObject)(profile(wire.url)), apiKey: "SHOULD_NEVER_BE_STORED" },
    }),
  ).rejects.toThrow()
  const configuration = profile(wire.url)
  await proof.rpc("draft", {
    profile: Schema.decodeUnknownSync(Schema.Json)({
      ...configuration,
      tiers: { ...configuration.tiers, high: { ...configuration.tiers.high, effort: "unsupported" } },
    }),
  })
  await expect(proof.rpc("publish")).rejects.toThrow()
  expect((await proof.inspect()).revision).toBe(published.revision)
  expect(JSON.stringify(await proof.rpc("config"))).not.toContain("SHOULD_NEVER_BE_STORED")
  expect(wire.calls).toHaveLength(0)
})

test("configuration and the prior Session model survive plugin unload and reload", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const published = await proof.publish()
  const session = await proof.session()
  await proof.enable(false)
  await proof.enable(true)
  expect(await proof.inspect(session.id)).toMatchObject({
    state: "configured",
    enabled: true,
    revision: published.revision,
    previousModel: { id: "low", variant: "high" },
  })
  await proof.rpc("disable", { sessionID: session.id })
  expect((await proof.client.sessions.get({ sessionID: session.id })).model).toEqual({
    providerID: "fixture-openai",
    id: "low",
    variant: "high",
  })
})

test("disable preserves a later manual selection instead of overwriting it", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  await proof.client.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "fixture-openai", id: "high", variant: "medium" },
  })
  await proof.rpc("disable", { sessionID: session.id })
  expect((await proof.client.sessions.get({ sessionID: session.id })).model).toEqual({
    providerID: "fixture-openai",
    id: "high",
    variant: "medium",
  })
})

test("a sole capacity-eligible tier skips Evaluation and retains the large advertised window", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const configuration = profile(wire.url)
  await proof.publish({
    ...configuration,
    decision: { ...configuration.decision, maxInputBytes: 1, maxInputTokens: 1 },
  })
  const session = await proof.session()
  const events = await proof.prompt(session.id, "x".repeat(300_000))
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect((await proof.inspect(session.id)).lastRoute).toMatchObject({
    tier: "max",
    selection: "capacity",
    eligibleTiers: ["max"],
  })
  expect(wire.calls.some((call) => call.path.endsWith("/systemone"))).toBe(false)
})

test("empty capacity candidates fail before decision or generation without a retry", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "x".repeat(1_100_000))
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(events.some((event) => event.type === "session.retry.scheduled")).toBe(false)
  expect(wire.calls).toHaveLength(0)
})

test("an illegal native choice blocks generation without fallback", async () => {
  await using wire = endpoint({ choice: "not-a-tier" })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(false)
  expect((await proof.inspect(session.id)).lastFailure).toMatchObject({
    kind: "primary",
    message: "Native decision failed or returned an invalid answer",
  })
})

test("decision wire budget is enforced before the HTTP request", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const configuration = profile(wire.url)
  await proof.publish({ ...configuration, decision: { ...configuration.decision, maxInputBytes: 1 } })
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(wire.calls).toHaveLength(0)
})

test("a real tool call returns to Core and the following Step makes a fresh route decision", async () => {
  const executions: string[] = []
  await using wire = endpoint({
    generation(body) {
      const messages = JSON.stringify(body.messages)
      if (messages.includes("tool evidence")) return chat(body.model, { content: "Tool cycle complete" })
      return chat(
        body.model,
        {
          tool_calls: [
            {
              index: 0,
              id: "call-fixture",
              type: "function",
              function: { name: "fixture_echo", arguments: '{"value":"tool evidence"}' },
            },
          ],
        },
        "tool_calls",
      )
    },
  })
  await using proof = await routing(installed.package, wire.url, {
    plugins: [
      Plugin.define({
        id: "loopback-tool",
        async setup(ctx) {
          await ctx.tool.transform((editor) =>
            editor.add({
              name: "fixture_echo",
              description: "Return loopback tool evidence",
              input: Schema.Struct({ value: Schema.String }),
              options: { codemode: false },
              async execute(input) {
                executions.push(input.value)
                return { content: input.value }
              },
            }),
          )
        },
      }),
    ],
  })
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Call fixture_echo and finish")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect(executions).toEqual(["tool evidence"])
  expect(wire.calls.filter((call) => call.path.endsWith("/systemone"))).toHaveLength(2)
  expect(JSON.stringify(events)).toContain("Tool cycle complete")
})

test("Session generate uses its fixed pair without a route decision", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const result = await proof.client.sessions.generate({ sessionID: session.id, prompt: "Generate auxiliary text" })
  expect(result.text).toContain("physical:max")
  expect(wire.calls.some((call) => call.path.endsWith("/systemone"))).toBe(false)
})

test("multiple text blocks from a failed shell command survive routing to another tier", async () => {
  const decisions = { count: 0 }
  await using wire = endpoint({
    answer(body) {
      return decision(body, {}, ++decisions.count === 1 ? "low" : "high")
    },
    generation(body) {
      if (body.model === "high") return chat(body.model, { content: "Continue fixing the failed tests" })
      return chat(
        body.model,
        {
          tool_calls: [
            {
              index: 0,
              id: "call-failed-tests",
              type: "function",
              function: { name: "fixture_failed_tests", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      )
    },
  })
  await using proof = await routing(installed.package, wire.url, {
    plugins: [
      Plugin.define({
        id: "failed-shell-result",
        async setup(ctx) {
          await ctx.tool.transform((editor) =>
            editor.add({
              name: "fixture_failed_tests",
              description: "Return the native failed-shell shape: output and exit notice",
              input: Schema.Struct({}),
              options: { codemode: false },
              async execute() {
                return {
                  content: [
                    { type: "text", text: "4 tests failed" },
                    { type: "text", text: "Exited with code 1" },
                  ],
                }
              },
            }),
          )
        },
      }),
    ],
  })
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Run fixture_failed_tests, inspect the result, and continue")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  const generations = wire.calls.filter((call) => call.path.endsWith("/chat/completions"))
  expect(generations.map((call) => call.body.model)).toEqual(["low", "high"])
  expect(JSON.stringify(generations[1].body.messages)).toContain("4 tests failed")
  expect(JSON.stringify(generations[1].body.messages)).toContain("Exited with code 1")
  expect((await proof.inspect(session.id)).lastRoute?.tier).toBe("high")
})

test("a downstream plugin increasing final input cannot silently switch the bound pair or trigger retries", async () => {
  await using wire = endpoint()
  await using later = await laterPlugin(
    'await ctx.session.hook("context", event => { if (event.model.providerID === "self-driving") event.system.push({ type: "text", text: "x".repeat(200000) }) })',
  )
  await using proof = await routing(installed.package, wire.url, { trailing: [later.directory] })
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(events.some((event) => event.type === "session.retry.scheduled")).toBe(false)
  expect(wire.calls.filter((call) => call.path.endsWith("/systemone"))).toHaveLength(1)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(false)
})

test("native integration key resolution is used without storing the key in the profile or status", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.client.credential.create({
    integrationID: "openai",
    value: { type: "key", key: "integration-fixture-key" },
    activate: true,
  })
  const configuration = profile(wire.url)
  await proof.publish({
    ...configuration,
    backends: { coding: { ...configuration.backends.coding, auth: { type: "integration", integrationID: "openai" } } },
  })
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect(wire.calls.find((call) => call.path.endsWith("/chat/completions"))?.authorization).toBe(
    "Bearer integration-fixture-key",
  )
  expect(JSON.stringify(await proof.rpc("config"))).not.toContain("integration-fixture-key")
  expect(JSON.stringify(await proof.inspect(session.id))).not.toContain("integration-fixture-key")
})

test("missing credentials fail publication before any network call", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const configuration = profile(wire.url)
  await proof.rpc("draft", {
    profile: Schema.decodeUnknownSync(Schema.Json)({
      ...configuration,
      decision: { ...configuration.decision, auth: { type: "env", name: "SELF_DRIVING_MISSING_KEY" } },
    }),
  })
  await expect(proof.rpc("publish")).rejects.toThrow()
  expect((await proof.inspect()).state).toBe("unconfigured")
  expect(wire.calls).toHaveLength(0)
})

test("the preparation deadline cancels an actual waiting native Evaluation request", async () => {
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const aborted = Promise.withResolvers<void>()
  await using wire = endpoint({
    answer(_, request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  const configuration = profile(wire.url)
  await proof.publish({ ...configuration, preparationTimeoutMs: 500 })
  const session = await proof.session()
  const pending = proof.prompt(session.id, "Implement this change")
  await received.promise
  const events = await pending
  await aborted.promise
  release.resolve(Response.json({}))
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(false)
})

test("separate concurrent Sessions keep their decision bindings isolated", async () => {
  await using wire = endpoint({
    answer(body) {
      const tier = JSON.stringify(body.state).includes("TASK_HIGH") ? "high" : "low"
      return Response.json({
        model: body.model,
        answers: {
          route: {
            type: "choice",
            choice: tier,
            probabilities: { low: tier === "low" ? 1 : 0, medium: 0, high: tier === "high" ? 1 : 0, xhigh: 0, max: 0 },
          },
        },
      })
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const [high, low] = await Promise.all([proof.session(), proof.session()])
  await Promise.all([proof.prompt(high.id, "TASK_HIGH"), proof.prompt(low.id, "TASK_LOW")])
  expect((await proof.inspect(high.id)).lastRoute?.tier).toBe("high")
  expect((await proof.inspect(low.id)).lastRoute?.tier).toBe("low")
})

test.each([...TIERS])("the %s tier reaches its configured physical model", async (tier) => {
  await using wire = endpoint({ choice: tier })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect((await proof.inspect(session.id)).lastRoute).toMatchObject({ tier, physicalModel: tier })
})

test("rounded probabilities are preserved and zero confidence does not reject a legal choice", async () => {
  await using wire = endpoint({
    answer(body) {
      return Response.json({
        model: body.model,
        answers: {
          route: {
            type: "choice",
            choice: "max",
            probabilities: { low: 0.19, medium: 0.19, high: 0.19, xhigh: 0.19, max: 0.22 },
            confidence: 0,
          },
        },
      })
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(true)
  expect((await proof.inspect(session.id)).lastRoute?.decision).toMatchObject({
    probabilities: { low: 0.19, medium: 0.19, high: 0.19, xhigh: 0.19, max: 0.22 },
    confidence: 0,
  })
})

test("an unexpected decision response identity blocks dispatch", async () => {
  await using wire = endpoint({
    answer() {
      return Response.json({
        model: "unexpected-model",
        answers: {
          route: { type: "choice", choice: "medium", probabilities: { low: 0, medium: 1, high: 0, xhigh: 0, max: 0 } },
        },
      })
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(false)
})

test.each(["oauth", "external"] as const)(
  "a stored %s credential is not reinterpreted as a backend API key",
  async (type) => {
    await using wire = endpoint()
    await using proof = await routing(installed.package, wire.url)
    await proof.client.credential.create({
      integrationID: "openai",
      activate: true,
      value:
        type === "oauth"
          ? {
              type,
              methodID: "fixture-oauth",
              refresh: "fixture-refresh",
              access: "fixture-access",
              expires: 4_102_444_800_000,
            }
          : { type, methodID: "fixture-external" },
    })
    const configuration = profile(wire.url)
    await proof.rpc("draft", {
      profile: Schema.decodeUnknownSync(Schema.Json)({
        ...configuration,
        backends: {
          coding: { ...configuration.backends.coding, auth: { type: "integration", integrationID: "openai" } },
        },
      }),
    })
    await expect(proof.rpc("publish")).rejects.toThrow()
    expect(wire.calls).toHaveLength(0)
  },
)

test("native title and compaction use their fixed pairs and keep native checkpoint handling", async () => {
  await using wire = endpoint({
    generation(body) {
      return chat(body.model, {
        content:
          body.model === "max"
            ? "## Objective\nKeep working on the requested change.\n## Next Move\nContinue."
            : `physical:${body.model}`,
      })
    },
  })
  await using proof = await routing(installed.package, wire.url, {
    config: { compaction: { keep: { tokens: 0 } }, agents: { title: { model: "self-driving/auto" } } },
  })
  await proof.publish()
  const session = await proof.client.sessions.create({
    location: { directory: proof.directory },
    model: { providerID: "self-driving", id: "auto" },
  })
  await proof.prompt(session.id, "Implement a change with sufficient history to summarize")
  await proof.client.sessions.compact({ sessionID: session.id })
  await proof.client.sessions.wait({ sessionID: session.id })
  const events = await Array.fromAsync(proof.client.sessions.log({ sessionID: session.id }))
  expect(events.some((event) => event.type === "session.compaction.ended")).toBe(true)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions") && call.body.model === "low")).toBe(true)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions") && call.body.model === "max")).toBe(true)
  expect(wire.calls.filter((call) => call.path.endsWith("/systemone"))).toHaveLength(1)
})

test("native provider overflow survives the bundled error bridge and uses Core compaction", async () => {
  const state = { lowCalls: 0 }
  await using wire = endpoint({
    choice: "low",
    generation(body) {
      if (body.model === "max")
        return chat(body.model, { content: "## Objective\nRetain the requested task.\n## Next Move\nContinue." })
      state.lowCalls++
      if (state.lowCalls === 2)
        return Response.json(
          { error: { code: "context_length_exceeded", message: "Maximum context length exceeded" } },
          { status: 400 },
        )
      return chat(body.model, { content: "Completed physical request" })
    },
  })
  await using proof = await routing(installed.package, wire.url, { config: { compaction: { keep: { tokens: 0 } } } })
  await proof.publish()
  const session = await proof.session()
  await proof.prompt(session.id, "First task for compactable history")
  const events = await proof.prompt(session.id, "Continue the original task")
  expect(events.some((event) => event.type === "session.compaction.ended")).toBe(true)
  expect(events.filter((event) => event.type === "session.execution.succeeded")).toHaveLength(2)
  expect(state.lowCalls).toBe(3)
})

test("global generation cannot bypass the Session binding requirement", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const directory = join(proof.directory, "config")
  await proof.rpc("draft", { profile: Schema.decodeUnknownSync(Schema.Json)(profile(wire.url)) }, directory)
  await proof.rpc("publish", {}, directory)
  await expect(
    proof.client.generate.text({
      model: { providerID: "self-driving", id: "auto" },
      prompt: "Global request",
    }),
  ).rejects.toThrow()
  expect(wire.calls).toHaveLength(0)
})

test.each(["typesafe-ai", "vercel-ai-gateway"] as const)(
  "%s retains its native contract for missing probability distributions",
  async (service) => {
    await using wire = endpoint({
      answer(body) {
        return Response.json({ model: body.model, answers: { route: { type: "choice", choice: "medium" } } })
      },
    })
    await using proof = await routing(installed.package, wire.url)
    const configuration = profile(wire.url)
    await proof.publish({ ...configuration, decision: { ...configuration.decision, service } })
    const session = await proof.session()
    const events = await proof.prompt(session.id, "Implement this change")
    expect(events.some((event) => event.type === "session.execution.succeeded")).toBe(service === "vercel-ai-gateway")
    expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(service === "vercel-ai-gateway")
  },
)

test("final HTTP middleware checks body overlays added after native protocol preparation", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, {
    plugins: [
      Plugin.define({
        id: "public-body-overlay",
        async setup(ctx) {
          await ctx.provider.transform((editor) =>
            editor.update("fixture-openai", (provider) => {
              provider.body = { metadata: { payload: "x".repeat(200_000) } }
            }),
          )
        },
      }),
    ],
  })
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Implement this change")
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(events.some((event) => event.type === "session.retry.scheduled")).toBe(false)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(false)
  expect((await proof.inspect(session.id)).lastRoute?.tier).toBe("medium")
})
