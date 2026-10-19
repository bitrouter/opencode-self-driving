import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { decodePlan } from "../script/qualification/plan"
import type { Plan } from "../script/qualification/plan"
import { egress } from "../script/qualification/egress"
import { metrics } from "../script/qualification/metrics"
import type { Sample } from "../script/qualification/metrics"
import { run } from "../script/qualification/run"
import { install } from "./fixture"
import { chat, endpoint, profile } from "./routing-fixture"

const installed = await install()
afterAll(() => installed[Symbol.asyncDispose]())

function plan(url: string): Plan {
  const configured = profile(url)
  const pair = { backend: "coding", model: "openai/gpt-4o-mini" }
  return {
    schemaVersion: 1,
    profile: {
      ...configured,
      backends: { coding: { ...configured.backends.coding, service: "openrouter", providerID: "openrouter" } },
      tiers: { low: pair, medium: pair, high: pair, xhigh: pair, max: pair },
      auxiliary: { title: pair, compaction: pair, generate: pair },
    },
    endpoints: { decision: url, backends: { coding: url } },
    credentials: {},
    limits: {
      maxRequests: 12,
      maxOutputTokens: 1_024,
      maxDurationMs: 30_000,
      maxInputBytes: 1_000_000,
      maxResponseBytes: 1_000_000,
      maxStepsPerCase: 3,
    },
    cases: [
      {
        id: "text",
        split: "holdout",
        prompt: "Reply exactly QUALIFIED",
        expectedText: "QUALIFIED",
        acceptableTiers: [],
        contextSelection: "inherit",
        approval: "off",
        resources: [],
      },
    ],
  }
}

test("qualification plans require all explicit bounds, isolated credential references and reviewed endpoints", () => {
  const configured = plan("https://example.com/v1")
  expect(decodePlan(configured)).toEqual(configured)
  expect(() => decodePlan({ ...configured, limits: { ...configured.limits, maxRequests: 0 } })).toThrow()
  expect(() => decodePlan({ ...configured, limits: { ...configured.limits, maxOutputTokens: 1 } })).toThrow()
  expect(() =>
    decodePlan({ ...configured, endpoints: { ...configured.endpoints, decision: "https://key@example.com" } }),
  ).toThrow()
  expect(() =>
    decodePlan({ ...configured, endpoints: { ...configured.endpoints, decision: "http://example.com" } }),
  ).toThrow()
  expect(() => decodePlan({ ...configured, cases: [configured.cases[0], configured.cases[0]] })).toThrow()
  expect(() =>
    decodePlan({
      ...configured,
      cases: [configured.cases[0], { ...configured.cases[0], id: "leaked", split: "tuning" }],
    }),
  ).toThrow()
  expect(() =>
    decodePlan({
      ...configured,
      profile: {
        ...configured.profile,
        decision: { ...configured.profile.decision, auth: { type: "env", name: "HOME" } },
      },
    }),
  ).toThrow()
  expect(() =>
    decodePlan({
      ...configured,
      profile: {
        ...configured.profile,
        decision: { ...configured.profile.decision, auth: { type: "integration", integrationID: "typesafe-ai" } },
      },
    }),
  ).toThrow()
})

test("preflight relay forwards zero requests and never records credentials or bodies", async () => {
  await using wire = endpoint()
  const configured = plan(wire.url)
  await using relay = egress(
    configured.limits,
    [{ kind: "decision", url: wire.url, models: new Set(["fixture"]) }],
    new AbortController(),
    false,
  )
  await fetch(`${relay.url(0)}/systemone`, {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture", state: "private-body" }),
  })
  expect(wire.calls).toHaveLength(0)
  expect(relay.requests).toHaveLength(0)
  expect(JSON.stringify(relay.state)).not.toContain("secret")
  expect(JSON.stringify(relay.state)).not.toContain("private-body")
})

test("concurrent requests cannot exceed the actual forwarding budget", async () => {
  await using wire = endpoint()
  const configured = plan(wire.url)
  await using relay = egress(
    { ...configured.limits, maxRequests: 1 },
    [{ kind: "generation", url: wire.url, models: new Set(["physical"]) }],
    new AbortController(),
    true,
  )
  await Promise.allSettled(
    [1, 2].map(() =>
      fetch(`${relay.url(0)}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "physical", max_tokens: 128 }),
      }).then((response) => response.text()),
    ),
  )
  expect(wire.calls.length).toBeLessThanOrEqual(1)
  expect(relay.requests).toHaveLength(1)
  expect(relay.state.reason).toBe("request-count")
})

test.each(["output-budget", "model-identity", "input-bytes"])("relay rejects %s before forwarding", async (kind) => {
  await using wire = endpoint()
  const configured = plan(wire.url)
  await using relay = egress(
    { ...configured.limits, ...(kind === "input-bytes" ? { maxInputBytes: 1 } : {}) },
    [{ kind: "generation", url: wire.url, models: new Set(["physical"]) }],
    new AbortController(),
    true,
  )
  await fetch(`${relay.url(0)}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: kind === "model-identity" ? "wrong" : "physical",
      max_tokens: kind === "output-budget" ? 10_000 : 128,
    }),
  })
  expect(wire.calls).toHaveLength(0)
  expect(relay.state.reason).toBe(kind)
})

test("upstream redirects do not create uncounted requests", async () => {
  await using wire = endpoint({ generation: () => Response.redirect("https://example.com/never-followed") })
  await using relay = egress(
    plan(wire.url).limits,
    [{ kind: "generation", url: wire.url, models: new Set(["physical"]) }],
    new AbortController(),
    true,
  )
  await fetch(`${relay.url(0)}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "physical", max_tokens: 128 }),
  })
  expect(wire.calls).toHaveLength(1)
  expect(relay.state.reason).toBe("redirect")
})

test("response limit cancels the actual upstream stream", async () => {
  const cancelled = Promise.withResolvers<void>()
  await using wire = endpoint({
    generation: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("response-beyond-budget"))
          },
          cancel() {
            cancelled.resolve()
          },
        }),
      ),
  })
  const controller = new AbortController()
  await using relay = egress(
    { ...plan(wire.url).limits, maxResponseBytes: 1 },
    [{ kind: "generation", url: wire.url, models: new Set(["physical"]) }],
    controller,
    true,
  )
  await fetch(`${relay.url(0)}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "physical", max_tokens: 128 }),
  })
    .then((response) => response.text())
    .catch(() => undefined)
  await cancelled.promise
  expect(controller.signal.aborted).toBe(true)
  expect(relay.state.reason).toBe("response-bytes")
})

test("metrics keep holdout separate, count harmful allows and leave missing denominators unknown", () => {
  const configured = plan("https://example.com")
  const cases = ["tuning", "holdout"].map((split) => ({
    ...configured.cases[0],
    id: split,
    split: Schema.decodeUnknownSync(Schema.Literals(["tuning", "holdout"]))(split),
    acceptableTiers: ["low" as const],
    tool: { text: "synthetic", needsHuman: true },
  }))
  const sample: Sample = {
    id: "tuning",
    split: "tuning",
    outcome: "succeeded",
    elapsedMs: 1,
    textMatch: true,
    toolCalls: 0,
    toolMatches: 0,
    manualReplies: 0,
    steps: 1,
    routes: [],
    approvals: [
      {
        mode: "shadow",
        action: "qualification_echo",
        outcome: "shadow",
        reason: "synthetic labeled result",
        probability: 0.01,
      },
    ],
  }
  const report = metrics(
    {
      ...configured,
      profile: {
        ...configured.profile,
        approval: { tauAllow: 0.05, timeoutMs: 1000, maxBytes: 1000, maxTokens: 1000, mcpServers: ["qualification"] },
      },
      cases,
    },
    [sample],
  )
  expect(report.tuning.approval.falseNegativeRate.value).toBe(1)
  expect(report.tuning.approval.wrongAmongProposedAllow.value).toBe(1)
  expect(report.tuning.approval.actualAutoAllowCoverage.value).toBe(0)
  expect(report.holdout.samples).toBe(0)
  expect(report.holdout.completionExactMatch.value).toBeNull()
  expect(report.holdout.calibration).toBe("not-qualified")
})

test("real isolated SDK preflight uses the public native catalog and makes no HTTP call", async () => {
  await using wire = endpoint()
  const report = await run(decodePlan(plan(wire.url)), installed.package, new AbortController(), false)
  expect(report.state, `${report.failureStage}: ${report.failureReason}`).toBe("ready")
  expect(report.physicalModels[0]?.model).toBe("openai/gpt-4o-mini")
  expect(wire.calls).toHaveLength(0)
})

test("qualification exercises native routing, generation and usage without qualifying fixture quality", async () => {
  await using wire = endpoint({
    generation(body) {
      const data = new TextEncoder().encode(
        [
          ...["", "QUA", "LI", "FIED"].map((content, index) => ({
            id: "fragmented-completion",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta: index ? { content } : { role: "assistant", content }, finish_reason: null }],
          })),
          {
            id: "fragmented-completion",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            id: "fragmented-completion",
            object: "chat.completion.chunk",
            model: body.model,
            choices: [],
            usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("") + "data: [DONE]\n\n",
      )
      const position = { offset: 0 }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (position.offset === data.length) return controller.close()
            controller.enqueue(data.slice(position.offset, position.offset + 37))
            position.offset = Math.min(position.offset + 37, data.length)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const report = await run(decodePlan(plan(wire.url)), installed.package, new AbortController(), true)
  expect(report.state, `${report.failureStage}: ${report.failureReason}`).toBe("completed")
  expect(report.samples[0]?.routes[0]?.decision?.responseModel).toBe("fixture-jev")
  expect(report.samples[0]?.routes[0]?.generationUsage?.inputTokens).toBe(23)
  expect(report.samples[0]?.textComparison).toEqual({
    assistantPresent: true,
    textParts: 1,
    actualLength: 9,
    expectedLength: 9,
    actualSha256: new Bun.CryptoHasher("sha256").update("QUALIFIED").digest("hex"),
    expectedSha256: new Bun.CryptoHasher("sha256").update("QUALIFIED").digest("hex"),
  })
  expect(report.requests.length).toBeGreaterThanOrEqual(2)
  expect(report.network.providerRequests).toBe(0)
  expect(report.quality).toBe("not-qualified")
  expect(JSON.stringify(report)).not.toContain("fixture-key-not-a-live-credential")
  expect(JSON.stringify(report)).not.toContain("Reply exactly QUALIFIED")
})

test("qualification keeps quoted output as a failure and records only comparison diagnostics", async () => {
  await using wire = endpoint({ generation: (body) => chat(body.model, { content: '"QUALIFIED"' }) })
  const report = await run(decodePlan(plan(wire.url)), installed.package, new AbortController(), true)
  expect(report.state).toBe("incomplete")
  expect(report.samples[0]?.outcome).toBe("succeeded")
  expect(report.samples[0]?.textMatch).toBe(false)
  expect(report.samples[0]?.textComparison).toMatchObject({
    assistantPresent: true,
    textParts: 1,
    actualLength: 11,
    expectedLength: 9,
    firstDifference: { utf16Offset: 0, actualCodePoint: 34, expectedCodePoint: 81 },
    actualSha256: new Bun.CryptoHasher("sha256").update('"QUALIFIED"').digest("hex"),
  })
  expect(JSON.stringify(report.samples[0]?.textComparison)).not.toContain("QUALIFIED")
})

test("live-path provider failure stops without a paid retry or later case", async () => {
  await using wire = endpoint({
    answer: () => Response.json({ error: { message: "sensitive-upstream-body" } }, { status: 401 }),
  })
  const configured = plan(wire.url)
  const report = await run(
    decodePlan({ ...configured, cases: [configured.cases[0], { ...configured.cases[0], id: "never" }] }),
    installed.package,
    new AbortController(),
    true,
  )
  expect(report.state, `${report.failureStage}: ${report.failureReason}`).toBe("incomplete")
  expect(wire.calls).toHaveLength(1)
  expect(report.samples).toHaveLength(1)
  expect(report.requests[0]?.status).toBe(401)
  expect(JSON.stringify(report)).not.toContain("sensitive-upstream-body")
})

test.each(["shadow", "auto"])(
  "qualification observes native resources, MCP approval %s and the next Step",
  async (approval) => {
    await using wire = endpoint({
      generation(body) {
        if (JSON.stringify(body.messages).includes('"role":"tool"')) return chat(body.model, { content: "QUALIFIED" })
        return chat(
          body.model,
          {
            tool_calls: [
              {
                index: 0,
                id: "qualification-call",
                type: "function",
                function: { name: "qualification_echo", arguments: JSON.stringify({ text: "SYNTHETIC" }) },
              },
            ],
          },
          "tool_calls",
        )
      },
    })
    const configured = plan(wire.url)
    const report = await run(
      decodePlan({
        ...configured,
        profile: {
          ...configured.profile,
          resources: { tauOmit: 0.1 },
          approval: {
            tauAllow: 0.05,
            timeoutMs: 5000,
            maxBytes: 500_000,
            maxTokens: 500_000,
            mcpServers: ["qualification"],
          },
        },
        cases: [
          {
            ...configured.cases[0],
            approval,
            contextSelection: "select",
            tool: { text: "SYNTHETIC", needsHuman: false },
            resources: [
              { id: "required", text: "Answer after tool completion exactly QUALIFIED", required: true, needed: true },
              { id: "irrelevant", text: "A completely unrelated documentation note", required: false, needed: false },
            ],
          },
        ],
      }),
      installed.package,
      new AbortController(),
      true,
    )
    expect(report.state, `${report.failureStage}: ${report.failureReason}`).toBe("completed")
    expect(report.samples[0]?.toolMatches).toBe(1)
    expect(report.samples[0]?.steps).toBe(2)
    expect(report.samples[0]?.routes.filter((route) => route.kind === "primary")).toHaveLength(2)
    expect(report.samples[0]?.routes[0]?.resources?.omitted).toEqual(["irrelevant"])
    expect(report.samples[0]?.approvals[0]?.outcome).toBe(approval === "auto" ? "allowed" : "shadow")
    expect(report.samples[0]?.manualReplies).toBe(approval === "auto" ? 0 : 1)
  },
)

test("qualification imports a referenced key through the native integration API in its isolated host", async () => {
  await using wire = endpoint({ generation: (body) => chat(body.model, { content: "QUALIFIED" }) })
  const configured = plan(wire.url)
  const report = await run(
    decodePlan({
      ...configured,
      credentials: { openrouter: "SELF_DRIVING_TEST_KEY" },
      profile: {
        ...configured.profile,
        backends: {
          coding: { ...configured.profile.backends.coding, auth: { type: "integration", integrationID: "openrouter" } },
        },
      },
    }),
    installed.package,
    new AbortController(),
    true,
  )
  expect(report.state, `${report.failureStage}: ${report.failureReason}`).toBe("completed")
  expect(wire.calls.every((call) => call.authorization === "Bearer fixture-key-not-a-live-credential")).toBe(true)
  expect(JSON.stringify(report)).not.toContain("fixture-key-not-a-live-credential")
})

test("missing live credentials block execution before any provider request", async () => {
  await using wire = endpoint()
  const configured = plan(wire.url)
  const report = await run(
    decodePlan({
      ...configured,
      profile: {
        ...configured.profile,
        decision: { ...configured.profile.decision, auth: { type: "env", name: "QUALIFICATION_MISSING_KEY" } },
      },
    }),
    installed.package,
    new AbortController(),
    true,
  )
  expect(report.state).toBe("blocked")
  expect(report.missingEnvironment).toEqual(["QUALIFICATION_MISSING_KEY"])
  expect(wire.calls).toHaveLength(0)
})

test("run cancellation aborts the actual upstream preparation and records a cancelled sample", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    answer(_, request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  const controller = new AbortController()
  const running = run(decodePlan(plan(wire.url)), installed.package, controller, true)
  await received.promise
  controller.abort()
  await aborted.promise
  const report = await running
  release.resolve(Response.json({}))
  expect(["cancelled", "incomplete"]).toContain(report.state)
  expect(report.samples[0]?.outcome).toBe("cancelled")
  expect(report.requests).toHaveLength(1)
})

test("preflight refuses native transport and compaction outside the declared backend binding", async () => {
  await using wire = endpoint()
  const configured = plan(wire.url)
  const pair = { backend: "coding", model: "gpt-4o-mini" }
  const report = await run(
    decodePlan({
      ...configured,
      profile: {
        ...configured.profile,
        backends: { coding: { ...configured.profile.backends.coding, service: "openai-chat", providerID: "openai" } },
        tiers: { low: pair, medium: pair, high: pair, xhigh: pair, max: pair },
        auxiliary: { title: pair, compaction: pair, generate: pair },
      },
    }),
    installed.package,
    new AbortController(),
    false,
  )
  expect(report.state).toBe("failed")
  expect(report.failureReason).toBe("This binding supports HTTP generation and native summary compaction only")
  expect(wire.calls).toHaveLength(0)
})

test.each([false, true])(
  "qualification CLI execute=%s isolates its child and preserves existing evidence",
  async (execute) => {
    await using wire = endpoint({ generation: (body) => chat(body.model, { content: "QUALIFIED" }) })
    const directory = await mkdtemp(join(tmpdir(), "qualification-cli-"))
    try {
      const source = join(directory, "plan.json")
      const output = join(directory, "report.json")
      await Bun.write(source, JSON.stringify(plan(wire.url)))
      const args = [
        process.execPath,
        "script/qualify.ts",
        "--plan",
        source,
        "--out",
        output,
        ...(execute ? ["--execute"] : []),
      ]
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
      const result = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(result[0], result[2]).toBe(0)
      const report = Schema.decodeUnknownSync(
        Schema.Struct({ state: Schema.String, network: Schema.Struct({ providerRequests: Schema.Number }) }),
      )(await Bun.file(output).json())
      expect(report.state).toBe(execute ? "completed" : "ready")
      expect(report.network.providerRequests).toBe(0)
      if (!execute) expect(wire.calls).toHaveLength(0)
      const original = await Bun.file(output).text()
      const repeated = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
      await Promise.all([new Response(repeated.stdout).text(), new Response(repeated.stderr).text()])
      expect(await repeated.exited).toBe(1)
      expect(await Bun.file(output).text()).toBe(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
