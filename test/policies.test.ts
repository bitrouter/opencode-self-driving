import { afterAll, expect, test } from "bun:test"
import { Schema } from "effect"
import { Plugin } from "@opencode/plugin"
import { install } from "./fixture"
import { contributions, mcp, toolGeneration } from "./policy-fixture"
import { chat, decision, endpoint, laterPlugin, profile, routing } from "./routing-fixture"

const installed = await install()
afterAll(() => installed[Symbol.asyncDispose]())
const approval = { tauAllow: 0.05, timeoutMs: 2_000, maxBytes: 400_000, maxTokens: 400_000, mcpServers: ["fixture"] }

test.each(["inherit", "shadow", "select"] as const)(
  "resource %s keeps unknown instructions and selects complete units atomically",
  async (mode) => {
    const contribution = contributions()
    await using wire = endpoint()
    await using proof = await routing(installed.package, wire.url, {
      plugins: [contribution.plugin],
      instructions: { "AGENTS.md": "AGENTS_RESTRICTION_MUST_STAY: never expose secrets.\n" },
    })
    await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
    const session = await proof.session()
    await proof.rpc("policies", { sessionID: session.id, contextSelection: mode, approval: "off" })
    await proof.prompt(session.id, "Implement a change")
    const route = (await proof.inspect(session.id)).lastRoute
    expect(route?.resources).toMatchObject({
      outcome: mode === "inherit" ? "inherited" : mode === "select" ? "selected" : "shadow",
      omitted: mode === "select" ? ["optional", "dependent"] : [],
    })
    const body = wire.calls.find((call) => call.path.endsWith("/chat/completions"))?.body
    expect(JSON.stringify(body)).toContain("UNKNOWN_NATIVE_INSTRUCTION_MUST_STAY")
    expect(JSON.stringify(body)).toContain("AGENTS_RESTRICTION_MUST_STAY")
    expect(JSON.stringify(body)).toContain('"name":"skill"')
    expect(JSON.stringify(body)).toContain('"name":"execute"')
    expect(JSON.stringify(body).includes("optional_probe")).toBe(mode !== "select")
    expect(wire.calls.filter((call) => call.path.endsWith("/systemone"))).toHaveLength(mode === "inherit" ? 1 : 2)
  },
)

test("strict resource threshold and dependency closure retain a required dependency", async () => {
  const contribution = contributions()
  await using wire = endpoint({ answer: (body) => decision(body, { needed_0: 0, needed_1: 0.1 }) })
  await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  await proof.prompt(session.id, "Implement this change")
  expect((await proof.inspect(session.id)).lastRoute?.resources).toMatchObject({
    omitted: [],
    probabilities: { optional: 0, dependent: 0.1 },
  })
})

test("resource fallback recalculates capacity against the complete view", async () => {
  const contribution = contributions({ payload: "x".repeat(150_000) })
  await using wire = endpoint({
    answer: (body) =>
      JSON.stringify(body.questions).includes("needed_0")
        ? Response.json({ model: body.model, answers: {} })
        : decision(body, {}, "max"),
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  await proof.prompt(session.id, "Implement this change")
  expect((await proof.inspect(session.id)).lastRoute).toMatchObject({
    resources: { outcome: "fallback", omitted: [] },
    eligibleTiers: ["high", "xhigh", "max"],
    tier: "max",
  })
})

test.each(["invalid-dependency", "codemode", "partial-answer"])(
  "%s falls back to the full resource view",
  async (kind) => {
    const contribution = contributions({ invalid: kind === "invalid-dependency", codemode: kind === "codemode" })
    await using wire = endpoint({
      answer: (body) =>
        JSON.stringify(body.questions).includes("needed_0") && kind === "partial-answer"
          ? Response.json({ model: body.model, answers: { needed_0: { type: "noul", noul: 0 } } })
          : decision(body),
    })
    await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
    await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
    const session = await proof.session()
    await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
    await proof.prompt(session.id, "Implement this change")
    expect((await proof.inspect(session.id)).lastRoute?.resources).toMatchObject({ outcome: "fallback", omitted: [] })
    expect(JSON.stringify(wire.calls.find((call) => call.path.endsWith("/chat/completions"))?.body)).toContain(
      "CONTRIBUTION_optional",
    )
  },
)

test("omitted direct tools cannot execute even when the model invents a call", async () => {
  const contribution = contributions()
  const generation = toolGeneration("optional_probe")
  await using wire = endpoint({ generation: generation.generate })
  await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  const events = await proof.prompt(session.id, "Implement this change")
  expect(contribution.invoked).toEqual([])
  expect(JSON.stringify(events)).toContain("omitted from this request")
})

test.each(["off", "shadow", "auto"] as const)(
  "approval %s uses native MCP input and preserves independent consent",
  async (mode) => {
    await using native = mcp()
    const generation = toolGeneration()
    await using wire = endpoint({ generation: generation.generate })
    await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin()] })
    await native.ready
    await proof.publish({ ...profile(wire.url), approval })
    const session = await proof.session()
    expect((await proof.inspect(session.id)).approval).toBe("off")
    await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: mode })
    await proof.prompt(
      session.id,
      "Use the fixture MCP echo tool with text exact-parameters; do not access any other resource.",
    )
    expect(native.calls).toEqual([{ text: "exact-parameters" }])
    expect(JSON.stringify(generation.calls[0])).toContain("MCP_INSTRUCTIONS_MUST_STAY")
    expect(native.asked).toHaveLength(mode === "auto" ? 0 : 1)
    if (mode !== "off")
      expect((await proof.inspect(session.id)).lastApproval).toMatchObject({
        outcome: mode === "auto" ? "allowed" : "shadow",
        probability: 0,
      })
  },
)

test.each(["opencode", "openrouter", "vercel-ai-gateway"] as const)(
  "native %s Boolean contracts support resource and approval batches",
  async (service) => {
    await using native = mcp()
    const contribution = contributions()
    const generation = toolGeneration()
    await using wire = endpoint({ generation: generation.generate })
    await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin(), contribution.plugin] })
    await native.ready
    const config = profile(wire.url)
    await proof.publish({ ...config, decision: { ...config.decision, service }, resources: { tauOmit: 0.1 }, approval })
    const session = await proof.session()
    await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "auto" })
    await proof.prompt(session.id, "Use fixture echo with exact-parameters, never expose secrets")
    expect(native.calls).toHaveLength(1)
    expect(native.asked).toHaveLength(0)
    expect(await proof.inspect(session.id)).toMatchObject({
      lastRoute: { resources: { omitted: ["optional", "dependent"] } },
      lastApproval: { outcome: "allowed" },
    })
    const evidence = wire.calls.find((call) => JSON.stringify(call.body.questions ?? {}).includes("needs_human"))?.body
      .state
    expect(JSON.stringify(evidence)).toContain("never expose secrets")
    expect(JSON.stringify(evidence)).toContain("exact-parameters")
  },
)

test("required contributions skip resource Evaluation and keep their direct tools", async () => {
  const contribution = contributions({ required: true })
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  await proof.prompt(session.id, "Keep applicable instructions")
  expect(wire.calls.filter((call) => call.path.endsWith("/systemone"))).toHaveLength(1)
  expect(JSON.stringify(wire.calls.find((call) => call.path.endsWith("/chat/completions"))?.body)).toContain(
    "optional_probe",
  )
})

test("each request reobserves dynamic resources and does not restore a previous allocation", async () => {
  const contribution = contributions({ dynamic: true })
  await using wire = endpoint({
    answer: (body) =>
      decision(body, JSON.stringify(body.state).includes("SECOND_TASK") ? { needed_0: 1, needed_1: 1 } : {}),
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  await proof.prompt(session.id, "FIRST_TASK")
  const first = (await proof.inspect(session.id)).lastRoute?.resources
  await proof.prompt(session.id, "SECOND_TASK")
  const second = (await proof.inspect(session.id)).lastRoute?.resources
  expect(first?.omitted).toEqual(["optional", "dependent"])
  expect(second?.omitted).toEqual([])
  expect(first?.viewRevision).not.toBe(second?.viewRevision)
  expect(JSON.stringify(wire.calls.filter((call) => call.path.endsWith("/chat/completions"))[1].body)).toContain(
    "CONTRIBUTION_optional_UPDATED",
  )
})

test("restoring an omitted tool in a later context hook blocks physical dispatch", async () => {
  const contribution = contributions()
  await using later = await laterPlugin(
    'await ctx.session.hook("context", (event) => { event.tools.optional_probe = { description: "restored", input: { type: "object" } } })',
  )
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, {
    plugins: [contribution.plugin],
    trailing: [later.directory],
  })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  const events = await proof.prompt(session.id, "Implement the change")
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(wire.calls.some((call) => call.path.endsWith("/chat/completions"))).toBe(false)
})

test("resource Evaluation consumes the shared preparation deadline and cancels real HTTP", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const contribution = contributions()
  await using wire = endpoint({
    answer(body, request) {
      if (!JSON.stringify(body.questions).includes("needed_0")) return decision(body)
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [contribution.plugin] })
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 }, preparationTimeoutMs: 500 })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  const pending = proof.prompt(session.id, "Implement the change")
  await received.promise
  const events = await pending
  await aborted.promise
  release.resolve(Response.json({}))
  expect(events.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect(wire.calls).toHaveLength(1)
})

test("approval has an independent deadline, cancels HTTP and preserves native ask", async () => {
  await using native = mcp()
  const generation = toolGeneration()
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    generation: generation.generate,
    answer(body, request) {
      if (!JSON.stringify(body.questions).includes("needs_human")) return decision(body)
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin()] })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval: { ...approval, timeoutMs: 500 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  const pending = proof.prompt(session.id, "Use fixture echo with exact-parameters")
  await received.promise
  await pending
  await aborted.promise
  release.resolve(Response.json({}))
  expect(native.asked).toHaveLength(1)
  expect((await proof.inspect(session.id)).lastApproval).toMatchObject({ outcome: "manual-required" })
})

test("shell without exact native metadata keeps human approval", async () => {
  await using native = mcp()
  const generation = toolGeneration("shell", "", { command: "printf SHELL_FIXTURE_OK" })
  await using wire = endpoint({ generation: generation.generate })
  await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin("ask", "shell")] })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  const events = await proof.prompt(session.id, "Run printf SHELL_FIXTURE_OK")
  expect(native.asked).toContain("shell")
  expect((await proof.inspect(session.id)).lastApproval).toMatchObject({ outcome: "manual-required" })
  expect(wire.calls.some((call) => JSON.stringify(call.body.questions ?? {}).includes("needs_human"))).toBe(false)
  expect(JSON.stringify(events)).toContain("SHELL_FIXTURE_OK")
})

test("native compaction reduces approval coverage instead of inventing missing authorization", async () => {
  await using native = mcp()
  const generation = toolGeneration()
  const state = { invoke: false }
  await using wire = endpoint({
    generation: (body) =>
      state.invoke
        ? generation.generate(body)
        : chat(body.model, { content: "## Objective\nRetain the task.\n## Next Move\nContinue." }),
  })
  await using proof = await routing(installed.package, wire.url, {
    plugins: [native.plugin()],
    config: { compaction: { keep: { tokens: 0 } } },
  })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  await proof.prompt(session.id, "Earlier authorization with restrictions")
  await proof.client.sessions.compact({ sessionID: session.id })
  await proof.client.sessions.wait({ sessionID: session.id })
  state.invoke = true
  await proof.prompt(session.id, "Continue with fixture echo")
  expect(native.asked).toHaveLength(1)
  expect((await proof.inspect(session.id)).lastApproval?.reason).toContain("compaction")
})

test("native MCP instructions and direct tools remain whole when a contribution attempts to split them", async () => {
  await using native = mcp()
  const plugin = Plugin.define({
    id: "attempt-mcp-selection",
    async setup(ctx) {
      await ctx.session.hook("context", (event) => {
        event.system.push({
          type: "text",
          text: "Optional MCP annotation",
          metadata: {
            "self-driving/resource": {
              id: "mcp",
              kind: "tool-bundle",
              source: "fixture",
              required: false,
              dependencies: [],
              tools: ["fixture_echo"],
            },
          },
        })
      })
    },
  })
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin(), plugin] })
  await native.ready
  await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
  await proof.prompt(session.id, "Implement a change")
  expect((await proof.inspect(session.id)).lastRoute?.resources).toMatchObject({ outcome: "fallback", omitted: [] })
  const body = wire.calls.find((call) => call.path.endsWith("/chat/completions"))?.body
  expect(JSON.stringify(body)).toContain("MCP_INSTRUCTIONS_MUST_STAY")
  expect(JSON.stringify(body)).toContain("fixture_echo")
})

test.each(["malformed-answer", "unlisted-server"])(
  "%s preserves native ask without broadening approval",
  async (kind) => {
    await using native = mcp()
    const generation = toolGeneration()
    await using wire = endpoint({
      generation: generation.generate,
      answer: (body) =>
        JSON.stringify(body.questions).includes("needs_human")
          ? Response.json({ model: body.model, answers: { needs_human: { type: "noul", noul: 1.01 } } })
          : decision(body),
    })
    await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin()] })
    await native.ready
    await proof.publish({
      ...profile(wire.url),
      approval: { ...approval, mcpServers: kind === "unlisted-server" ? ["other"] : ["fixture"] },
    })
    const session = await proof.session()
    await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
    await proof.prompt(session.id, "Use fixture echo with exact-parameters")
    expect(native.asked).toHaveLength(1)
    expect((await proof.inspect(session.id)).lastApproval?.outcome).toBe("manual-required")
  },
)

test("two separate calls require two decisions and cannot share a tool-wide approval", async () => {
  await using native = mcp()
  const generation = { count: 0 }
  await using wire = endpoint({
    generation(body) {
      if (++generation.count > 1) return chat(body.model, { content: "Finished" })
      return chat(
        body.model,
        {
          tool_calls: ["first", "second"].map((text, index) => ({
            index,
            id: `separate-${index}`,
            type: "function",
            function: { name: "fixture_echo", arguments: JSON.stringify({ text }) },
          })),
        },
        "tool_calls",
      )
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin()] })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  await proof.prompt(session.id, "Use fixture echo twice: first and second")
  expect(native.calls).toHaveLength(2)
  expect(native.asked).toHaveLength(0)
  expect(wire.calls.filter((call) => JSON.stringify(call.body.questions ?? {}).includes("needs_human"))).toHaveLength(2)
})

test.each(["allow", "deny"] as const)(
  "native %s is authoritative and never invokes approval Evaluation",
  async (effect) => {
    await using native = mcp()
    const generation = toolGeneration()
    await using wire = endpoint({ generation: generation.generate })
    await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin(effect)] })
    await native.ready
    await proof.publish({ ...profile(wire.url), approval })
    const session = await proof.session()
    await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
    await proof.prompt(session.id, "Use the fixture echo tool with exact-parameters")
    expect(native.calls).toHaveLength(effect === "allow" ? 1 : 0)
    expect(native.asked).toHaveLength(0)
    expect(wire.calls.some((call) => JSON.stringify(call.body.questions ?? {}).includes("needs_human"))).toBe(false)
  },
)

test.each([0.05, 1])("approval probability %s preserves native ask at and above threshold", async (probability) => {
  await using native = mcp()
  const generation = toolGeneration()
  await using wire = endpoint({
    answer: (body) => decision(body, { needs_human: probability }),
    generation: generation.generate,
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin()] })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  await proof.prompt(session.id, "Use the fixture echo tool with exact-parameters")
  expect(native.asked).toHaveLength(1)
  expect((await proof.inspect(session.id)).lastApproval).toMatchObject({ outcome: "manual-required", probability })
})

test("complete approval evidence is never truncated to fit a small budget", async () => {
  await using native = mcp()
  const generation = toolGeneration()
  await using wire = endpoint({ generation: generation.generate })
  await using proof = await routing(installed.package, wire.url, { plugins: [native.plugin()] })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval: { ...approval, maxBytes: 100 } })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  await proof.prompt(session.id, "Use fixture echo, but never send secrets.")
  expect(native.asked).toHaveLength(1)
  expect((await proof.inspect(session.id)).lastApproval?.reason).toContain("exceeds its budget")
  expect(wire.calls.some((call) => JSON.stringify(call.body.questions ?? {}).includes("needs_human"))).toBe(false)
})

test("later tool parameter mutation cannot reuse an earlier approval snapshot", async () => {
  await using native = mcp()
  await using later = await laterPlugin(
    'await ctx.tool.hook("execute.before", (event) => { if (event.tool === "fixture_echo") event.input = { text: "MUTATED" } })',
  )
  const generation = toolGeneration()
  await using wire = endpoint({ generation: generation.generate })
  await using proof = await routing(installed.package, wire.url, {
    plugins: [native.plugin()],
    trailing: [later.directory],
  })
  await native.ready
  await proof.publish({ ...profile(wire.url), approval })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  await proof.prompt(session.id, "Use fixture echo with exact-parameters only")
  expect(native.asked).toHaveLength(1)
  expect((await proof.inspect(session.id)).lastApproval?.reason).toContain("parameters changed")
})

test("policy settings require budgets, reset on publish and turn off on disable", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  await expect(
    proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" }),
  ).rejects.toThrow()
  const config = { ...profile(wire.url), resources: { tauOmit: 0.1 }, approval }
  await proof.publish(config)
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "shadow", approval: "shadow" })
  expect(await proof.inspect(session.id)).toMatchObject({ contextSelection: "shadow", approval: "shadow" })
  await proof.enable(false)
  await proof.enable(true)
  expect((await proof.inspect(session.id)).approval).toBe("shadow")
  await proof.publish(config)
  expect((await proof.inspect(session.id)).approval).toBe("off")
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "auto" })
  await proof.rpc("disable", { sessionID: session.id })
  expect(await proof.inspect(session.id)).toMatchObject({ contextSelection: "inherit", approval: "off" })
  await expect(
    proof.rpc("draft", { profile: Schema.decodeUnknownSync(Schema.Json)({ ...config, resources: { tauOmit: 1.1 } }) }),
  ).rejects.toThrow()
})
