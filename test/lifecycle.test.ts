import { afterAll, expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import { Lifecycle } from "../src/lifecycle"
import { install } from "./fixture"
import { chat, decision, endpoint, laterPlugin, profile, routing } from "./routing-fixture"
import { contributions, mcp, toolGeneration } from "./policy-fixture"
import { monitor } from "./lifecycle-fixture"
import { Schema } from "effect"

type Event = Parameters<Lifecycle["observe"]>[0]
const installed = await install()
afterAll(() => installed[Symbol.asyncDispose]())

function started(seq: number): Event {
  return {
    id: `evt_${seq}`,
    created: 0,
    type: "session.execution.started",
    data: { sessionID: "ses_fixture" },
    durable: { aggregateID: "ses_fixture", seq, version: 1 },
  }
}
function ended(seq: number): Event {
  return {
    id: `evt_${seq}`,
    created: 0,
    type: "session.execution.succeeded",
    data: { sessionID: "ses_fixture" },
    durable: { aggregateID: "ses_fixture", seq, version: 1 },
  }
}
function checkpoint(token: string): Event {
  return {
    id: "evt_checkpoint",
    created: 0,
    type: "rpc.opencode-self-driving.checkpoint",
    location: { directory: "/fixture" },
    data: { token },
  }
}

test("delayed and duplicate terminal events cannot cancel the next execution", async () => {
  const closed: number[] = []
  const lifecycle = new Lifecycle(
    async (token) => lifecycle.observe(checkpoint(token)),
    (execution) => closed.push(execution.sequence),
  )
  const first = lifecycle.start("ses_fixture", "preparing")
  const attaching = lifecycle.attach(first, first.controller.signal)
  lifecycle.observe(started(1))
  await attaching
  lifecycle.observe(ended(2))
  expect(first.controller.signal.aborted).toBe(true)
  lifecycle.observe(started(3))
  const next = lifecycle.start("ses_fixture", "preparing")
  await lifecycle.attach(next, next.controller.signal)
  lifecycle.observe(ended(2))
  lifecycle.observe(started(1))
  expect(next.controller.signal.aborted).toBe(false)
  lifecycle.observe(ended(4))
  expect(next.controller.signal.aborted).toBe(true)
  expect(lifecycle.work.size).toBe(0)
  expect(closed).toContain(4)
  lifecycle.close()
})

test("checkpoint cancellation and event stream loss release waiters and reject future work", async () => {
  const lifecycle = new Lifecycle(
    async () => undefined,
    () => undefined,
  )
  const controller = new AbortController()
  const waiting = lifecycle.flush(controller.signal)
  controller.abort()
  await expect(waiting).rejects.toThrow("cancelled")
  expect(lifecycle.checkpoints.size).toBe(0)
  const pending = lifecycle.flush()
  const work = lifecycle.start("ses_fixture", "preparing")
  lifecycle.close()
  await expect(pending).rejects.toThrow("unavailable")
  expect(work.controller.signal.aborted).toBe(true)
  expect(lifecycle.work.size).toBe(0)
  expect(() => lifecycle.start("ses_fixture", "preparing")).toThrow()
})

test("cancelling a drain does not cancel existing requests", async () => {
  const lifecycle = new Lifecycle(
    async () => undefined,
    () => undefined,
  )
  const work = lifecycle.start("ses_fixture", "streaming")
  const controller = new AbortController()
  const drain = lifecycle.drain(controller.signal)
  controller.abort()
  await expect(drain).rejects.toThrow("cancelled")
  expect(work.controller.signal.aborted).toBe(false)
  const done = lifecycle.drain(lifecycle.controller.signal)
  work.controller.abort()
  await done
  expect(lifecycle.drained.size).toBe(0)
  lifecycle.close()
})

const empty = {
  available: true,
  applying: false,
  preparing: 0,
  pending: 0,
  streaming: 0,
  approval: 0,
  views: 0,
  calls: 0,
  checkpoints: 0,
  deadlines: 0,
}

test.each(["route", "resources"])(
  "Session interruption cancels native %s HTTP and releases preparation",
  async (kind) => {
    const received = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Response>()
    const contribution = contributions()
    await using wire = endpoint({
      answer(body, request) {
        request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
        received.resolve()
        return release.promise
      },
    })
    await using proof = await routing(installed.package, wire.url, {
      plugins: kind === "resources" ? [contribution.plugin] : [],
    })
    await proof.publish({ ...profile(wire.url), resources: { tauOmit: 0.1 } })
    const session = await proof.session()
    if (kind === "resources")
      await proof.rpc("policies", { sessionID: session.id, contextSelection: "select", approval: "off" })
    const executing = proof.prompt(session.id, "Cancel this preparation")
    await received.promise
    await proof.client.sessions.interrupt({ sessionID: session.id })
    await executing
    await aborted.promise
    release.resolve(Response.json({}))
    expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
    expect(wire.calls).toHaveLength(1)
  },
)

test("interruption cancels an approval and never applies its late allow answer", async () => {
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
  await proof.publish({
    ...profile(wire.url),
    approval: { tauAllow: 0.05, timeoutMs: 5_000, maxBytes: 400_000, maxTokens: 400_000, mcpServers: ["fixture"] },
  })
  const session = await proof.session()
  await proof.rpc("policies", { sessionID: session.id, contextSelection: "inherit", approval: "auto" })
  const executing = proof.prompt(session.id, "Use fixture echo with exact-parameters")
  await received.promise
  await proof.client.sessions.interrupt({ sessionID: session.id })
  await executing
  await aborted.promise
  release.resolve(Response.json({ model: "fixture-jev", answers: { needs_human: { type: "noul", noul: 0 } } }))
  expect(native.calls).toHaveLength(0)
  expect(native.asked).toHaveLength(0)
  expect((await proof.inspect(session.id)).lastApproval).toBeUndefined()
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("Core cancellation closes the actual generation HTTP before response headers", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    generation(_, request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const executing = proof.prompt(session.id, "Cancel before response headers")
  await received.promise
  await proof.client.sessions.interrupt({ sessionID: session.id })
  await executing
  await aborted.promise
  release.resolve(chat("medium", { content: "LATE_RESULT" }))
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("a normal request and a preparation failure both release all request records", async () => {
  const state = { fail: false }
  await using wire = endpoint({
    answer: (body) => (state.fail ? Response.json({ model: body.model, answers: {} }) : decision(body)),
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  await proof.prompt(session.id, "Complete normally")
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
  state.fail = true
  await proof.prompt(session.id, "Fail preparation")
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("native retry rebuilds context and gets a fresh binding without plugin retries", async () => {
  const state = { calls: 0 }
  const retries = Plugin.define({
    id: "fast-native-retry",
    async setup(ctx) {
      await ctx.session.hook("retry", (event) => {
        if (event.decision.retry) event.decision.delay = 0
      })
    },
  })
  await using wire = endpoint({
    generation(body) {
      if (++state.calls === 1)
        return Response.json({ error: { message: "temporary fixture failure" } }, { status: 503 })
      return chat(body.model, { content: "RECOVERED" })
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [retries] })
  await proof.publish()
  const session = await proof.session()
  const events = await proof.prompt(session.id, "Exercise native retry")
  expect(state.calls).toBe(2)
  expect(wire.calls.filter((call) => call.path.endsWith("/systemone"))).toHaveLength(2)
  expect(events.filter((event) => event.type === "session.retry.scheduled")).toHaveLength(1)
  expect(JSON.stringify(events)).toContain("RECOVERED")
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
  expect((await proof.inspect(session.id)).lastFailure).toBeUndefined()
})

test("cancellation during streamed output closes the connection and releases the stream", async () => {
  const observation = monitor()
  const aborted = Promise.withResolvers<void>()
  await using wire = endpoint({
    generation(body, request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "streaming", model: body.model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "PARTIAL_OUTPUT" }, finish_reason: null }] })}\n\n`,
              ),
            )
          },
          cancel() {
            aborted.resolve()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [observation.plugin] })
  await proof.publish()
  const session = await proof.session()
  const partial = observation.next(
    (event) => event.type === "session.text.delta" && event.data.sessionID === session.id,
  )
  const executing = proof.prompt(session.id, "Cancel the open stream")
  await partial
  await proof.client.sessions.interrupt({ sessionID: session.id })
  await executing
  await aborted.promise
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("immediate prompt after interruption gets a new scope and ignores the cancelled decision", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const state = { decisions: 0 }
  await using wire = endpoint({
    answer(body, request) {
      if (++state.decisions > 1) return decision(body)
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const executing = proof.prompt(session.id, "OLD_TASK")
  await received.promise
  await proof.client.sessions.interrupt({ sessionID: session.id })
  await proof.client.sessions.prompt({ sessionID: session.id, text: "NEW_TASK_AFTER_INTERRUPT" })
  await proof.client.sessions.wait({ sessionID: session.id })
  await executing
  await aborted.promise
  const before = await proof.inspect(session.id)
  release.resolve(Response.json({ model: "fixture-jev", answers: {} }))
  expect((await proof.inspect(session.id)).lastRoute?.id).toBe(before.lastRoute?.id)
  expect(before.lastRoute?.generationUsage).toBeDefined()
  expect(before.lastFailure).toBeUndefined()
  expect(before.lifecycle).toEqual(empty)
  expect(state.decisions).toBe(2)
})

test("interrupting one Session leaves another Session's binding intact", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    answer(body, request) {
      if (!JSON.stringify(body.state).includes("CANCEL_ME")) return decision(body)
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const first = await proof.session()
  const second = await proof.session()
  const executing = proof.prompt(first.id, "CANCEL_ME")
  await received.promise
  await proof.prompt(second.id, "KEEP_ME_RUNNING")
  const retained = (await proof.inspect(second.id)).lastRoute?.id
  await proof.client.sessions.interrupt({ sessionID: first.id })
  await executing
  await aborted.promise
  release.resolve(Response.json({}))
  expect((await proof.inspect(second.id)).lastRoute?.id).toBe(retained)
  expect((await proof.inspect(second.id)).lastFailure).toBeUndefined()
  expect((await proof.inspect(first.id)).lifecycle).toEqual(empty)
})

test("steering input waits for the native boundary and does not abort the current request", async () => {
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const state = { decisions: 0, aborted: false }
  await using wire = endpoint({
    answer(body, request) {
      if (++state.decisions > 1) return decision(body)
      request.signal.addEventListener(
        "abort",
        () => {
          state.aborted = true
        },
        { once: true },
      )
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const executing = proof.prompt(session.id, "Start the work")
  await received.promise
  await proof.client.sessions.prompt({ sessionID: session.id, text: "Steer the next safe boundary" })
  expect(state.aborted).toBe(false)
  release.resolve(
    decision({
      model: "fixture-jev",
      questions: { route: { type: "choice", criteria: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } } },
    }),
  )
  await executing
  expect(state.decisions).toBe(2)
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("reload requested during preparation completes after native interruption without restoring bindings", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const state = { hold: true }
  await using wire = endpoint({
    answer(body, request) {
      if (!state.hold) return decision(body)
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  const published = await proof.publish({ ...profile(wire.url), preparationTimeoutMs: 30_000 })
  const session = await proof.session()
  const executing = proof.prompt(session.id, "Reload during preparation")
  await received.promise
  const reloading = proof.enable(false)
  await proof.client.sessions.interrupt({ sessionID: session.id })
  await reloading
  await aborted.promise
  release.resolve(Response.json({}))
  await executing
  state.hold = false
  await proof.enable(true)
  expect((await proof.inspect(session.id)).revision).toBe(published.revision)
  expect((await proof.inspect(session.id)).lastRoute).toBeUndefined()
  await proof.prompt(session.id, "Start after plugin reload")
  expect((await proof.inspect(session.id)).lastRoute?.generationUsage).toBeDefined()
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("host shutdown cancels owned preparation before its configured deadline", async () => {
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
  await using proof = await routing(installed.package, wire.url)
  await proof.publish({ ...profile(wire.url), preparationTimeoutMs: 30_000 })
  const session = await proof.session()
  await proof.client.sessions.prompt({ sessionID: session.id, text: "Stop with the host" })
  await received.promise
  await proof.client.close()
  await aborted.promise
  release.resolve(Response.json({}))
  expect(wire.calls).toHaveLength(1)
})

test("standalone Session generate cancellation is owned by its stream without a foreground execution", async () => {
  const received = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    generation(_, request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  const controller = new AbortController()
  const generating = proof.client.sessions.generate(
    { sessionID: session.id, prompt: "Independent auxiliary request" },
    { signal: controller.signal },
  )
  await received.promise
  expect((await proof.inspect(session.id)).lifecycle?.streaming).toBe(1)
  controller.abort()
  await expect(generating).rejects.toThrow()
  await aborted.promise
  release.resolve(chat("max", { content: "LATE_AUXILIARY" }))
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("native background title stream can finish after foreground execution becomes idle", async () => {
  const observation = monitor()
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    async generation(body) {
      if (body.model === "low") {
        received.resolve()
        return release.promise
      }
      await received.promise
      return chat(body.model, { content: "Foreground finished" })
    },
  })
  await using proof = await routing(installed.package, wire.url, {
    plugins: [observation.plugin],
    config: { agents: { title: { model: "self-driving/auto" } } },
  })
  await proof.publish()
  const session = await proof.client.sessions.create({
    location: { directory: proof.directory },
    model: { providerID: "self-driving", id: "auto" },
  })
  await proof.prompt(session.id, "Generate an accurate title for this coding task")
  expect((await proof.inspect(session.id)).lifecycle?.streaming).toBe(1)
  const renamed = observation.next((event) => event.type === "session.renamed" && event.data.sessionID === session.id)
  release.resolve(chat("low", { content: "Native background title" }))
  await renamed
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("publish drains existing generation, rejects new admission and preserves its snapshot", async () => {
  const observation = monitor()
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const state = { hold: true }
  await using wire = endpoint({
    generation(body) {
      if (!state.hold) return chat(body.model, { content: "AFTER_PUBLICATION" })
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [observation.plugin] })
  const previous = await proof.publish()
  const first = await proof.session()
  const second = await proof.session()
  const executing = proof.prompt(first.id, "OLD_PROFILE_WORK")
  await received.promise
  await proof.rpc("draft", {
    profile: Schema.decodeUnknownSync(Schema.Json)({ ...profile(wire.url), name: "new-profile", outputTokens: 512 }),
  })
  const applying = observation.next(
    (event) => event.type === "rpc.opencode-self-driving.configuration" && event.data.applying === true,
  )
  const publishing = proof.rpc("publish")
  await applying
  expect((await proof.inspect(first.id)).revision).toBe(previous.revision)
  const refused = await proof.prompt(second.id, "NEW_ADMISSION_DURING_PUBLICATION")
  expect(refused.some((event) => event.type === "session.execution.failed")).toBe(true)
  expect((await proof.inspect(second.id)).lastFailure?.message).toContain("configuration is changing")
  state.hold = false
  release.resolve(chat("medium", { content: "OLD_PROFILE_FINISHED" }))
  await executing
  const published = await publishing
  expect(published).not.toEqual(previous)
  expect(wire.calls.filter((call) => call.path.endsWith("/chat/completions"))).toHaveLength(1)
  await proof.prompt(second.id, "Continue under the new profile")
  expect((await proof.inspect(second.id)).lastRoute?.outputTokens).toBe(512)
  expect((await proof.inspect(first.id)).lifecycle).toEqual(empty)
})

test("cancelling publication while draining leaves the old profile and reopens admission", async () => {
  const observation = monitor()
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  await using wire = endpoint({
    generation(body) {
      received.resolve()
      return release.promise
    },
  })
  await using proof = await routing(installed.package, wire.url, { plugins: [observation.plugin] })
  const original = await proof.publish()
  const session = await proof.session()
  const executing = proof.prompt(session.id, "Hold the current generation")
  await received.promise
  const controller = new AbortController()
  const applying = observation.next(
    (event) => event.type === "rpc.opencode-self-driving.configuration" && event.data.applying === true,
  )
  const idle = observation.next(
    (event) => event.type === "rpc.opencode-self-driving.configuration" && event.data.applying === false,
  )
  const publishing = proof.client.rpc.call(
    { rpcID: "opencode-self-driving", method: "publish", input: {}, location: { directory: proof.directory } },
    { signal: controller.signal },
  )
  await applying
  controller.abort()
  await expect(publishing).rejects.toThrow()
  await idle
  expect((await proof.inspect(session.id)).revision).toBe(original.revision)
  expect((await proof.inspect(session.id)).lifecycle?.streaming).toBe(1)
  release.resolve(chat("medium", { content: "Not cancelled by publication" }))
  await executing
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})

test("a cancelled standalone generate behind a later hook expires its unconsumed binding", async () => {
  const observation = monitor()
  await using later = await laterPlugin(`
    const { Rpc } = await import("@opencode/plugin/rpc")
    const { Schema } = await import("effect")
    const release = Promise.withResolvers()
    const registration = await ctx.rpc.register(Rpc.define({
      id: "handoff-fixture",
      methods: { release: { input: Schema.toStandardSchemaV1(Schema.Struct({})), output: Schema.toStandardSchemaV1(Schema.Struct({})) } },
      events: { held: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) } },
    }), { release: async () => { release.resolve(); return {} } })
    await ctx.session.hook("generate", async () => { await registration.events.emit("held", {}); await release.promise })
  `)
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, {
    plugins: [observation.plugin],
    trailing: [later.directory],
  })
  await proof.publish({ ...profile(wire.url), preparationTimeoutMs: 1_000 })
  const session = await proof.session()
  const controller = new AbortController()
  const held = observation.next((event) => event.type === "rpc.handoff-fixture.held")
  const generating = proof.client.sessions.generate(
    { sessionID: session.id, prompt: "Cancelled before dispatcher consumption" },
    { signal: controller.signal },
  )
  await held
  expect((await proof.inspect(session.id)).lifecycle?.pending).toBe(1)
  controller.abort()
  await expect(generating).rejects.toThrow()
  // Publication must wait for the finite handoff budget, not leak an undeliverable binding forever.
  await proof.rpc("publish")
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
  expect((await proof.inspect(session.id)).lastFailure?.message).toContain("handoff exceeded")
  await proof.client.rpc.call({
    rpcID: "handoff-fixture",
    method: "release",
    input: {},
    location: { directory: proof.directory },
  })
  expect(wire.calls).toHaveLength(0)
})

test("rotating a native integration key is observed on the next request without caching credentials", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const add = (key: string) =>
    proof.client.credential.create({
      integrationID: "openai",
      activate: true,
      value: { type: "key", key },
    })
  await add("fixture-key-before-rotation")
  const config = profile(wire.url)
  await proof.publish({
    ...config,
    backends: { coding: { ...config.backends.coding, auth: { type: "integration", integrationID: "openai" } } },
  })
  const session = await proof.session()
  await proof.prompt(session.id, "Before key rotation")
  await add("fixture-key-after-rotation")
  await proof.prompt(session.id, "After key rotation")
  expect(
    wire.calls.filter((call) => call.path.endsWith("/chat/completions")).map((call) => call.authorization),
  ).toEqual(["Bearer fixture-key-before-rotation", "Bearer fixture-key-after-rotation"])
  expect(JSON.stringify(await proof.inspect(session.id))).not.toContain("fixture-key-after-rotation")
})

test("catalog mismatch after reload retains the previous published profile and restores its usable model", async () => {
  await using later = await laterPlugin(`
    const { Rpc } = await import("@opencode/plugin/rpc")
    const { Schema } = await import("effect")
    const state = { remove: false }
    await ctx.provider.transform((editor) => {
      if (!state.remove) return
      state.remove = false
      editor.remove("self-driving")
    })
    await ctx.rpc.register(Rpc.define({
      id: "catalog-failure-fixture", events: {},
      methods: { arm: { input: Schema.toStandardSchemaV1(Schema.Struct({})), output: Schema.toStandardSchemaV1(Schema.Struct({})) } },
    }), { arm: async () => { state.remove = true; return {} } })
  `)
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url, { trailing: [later.directory] })
  const previous = await proof.publish()
  const session = await proof.session()
  await proof.rpc("draft", {
    profile: Schema.decodeUnknownSync(Schema.Json)({ ...profile(wire.url), outputTokens: 512 }),
  })
  await proof.client.rpc.call({
    rpcID: "catalog-failure-fixture",
    method: "arm",
    input: {},
    location: { directory: proof.directory },
  })
  await expect(proof.rpc("publish")).rejects.toThrow()
  expect((await proof.inspect(session.id)).revision).toBe(previous.revision)
  await proof.prompt(session.id, "Continue after failed publication")
  expect((await proof.inspect(session.id)).lastRoute?.outputTokens).toBe(previous.profile.outputTokens)
  expect((await proof.inspect(session.id)).lifecycle).toEqual(empty)
})
