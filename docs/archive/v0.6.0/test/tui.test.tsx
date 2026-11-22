import { afterAll, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Schema } from "effect"
import { controls } from "../src/tui-controls"
import type { ControlsContext } from "../src/tui-controls"
import { Footer, StatusView } from "../src/tui-view"
import { install } from "./fixture"
import { endpoint, profile, routing } from "./routing-fixture"

const installed = await install()
afterAll(() => installed[Symbol.asyncDispose]())
const colors = {
  text: RGBA.fromInts(220, 220, 220),
  muted: RGBA.fromInts(150, 150, 150),
  error: RGBA.fromInts(240, 80, 80),
}

function interfaceFor(proof: Awaited<ReturnType<typeof routing>>, sessionID?: string) {
  const state = {
    sessionID,
    prompts: [] as string[],
    selections: [] as string[],
    confirmations: [] as boolean[],
    alerts: [] as { title: string; message: string }[],
    toasts: [] as { message: string; variant?: string }[],
    panels: [] as string[],
    synced: [] as string[],
    refreshes: 0,
  }
  const context: ControlsContext = {
    client: proof.client,
    location: { directory: proof.directory },
    data: {
      session: {
        get: () => undefined,
        async sync(id) {
          state.synced.push(id)
        },
      },
      location: { default: () => ({ directory: proof.directory }) },
    },
    ui: {
      router: { current: () => (state.sessionID ? { type: "session", sessionID: state.sessionID } : { type: "home" }) },
      panel: {
        open(name) {
          state.panels.push(name)
          return true
        },
      },
      toast: {
        show(value) {
          state.toasts.push(value)
        },
      },
      dialog: {
        show() {},
        set() {},
        clear() {},
        async alert(value) {
          state.alerts.push(value)
        },
        async prompt() {
          return state.prompts.shift()
        },
        async confirm() {
          return state.confirmations.shift()
        },
        async select(options) {
          const selected = state.selections.shift()
          return options.options.find((option) => String(option.value) === selected)?.value
        },
      },
    },
  }
  return { state, context, run: controls(context, new AbortController().signal, () => state.refreshes++) }
}

test("TUI commands enable and restore the original native model and variant through real RPC", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.client.sessions.create({
    title: "UI",
    location: { directory: proof.directory },
    model: { providerID: "fixture-openai", id: "low", variant: "high" },
  })
  const ui = interfaceFor(proof, session.id)
  await ui.run("on")
  expect((await proof.inspect(session.id)).enabled).toBe(true)
  expect((await proof.inspect(session.id)).approval).toBe("off")
  await ui.run("off")
  expect((await proof.client.sessions.get({ sessionID: session.id })).model).toEqual({
    providerID: "fixture-openai",
    id: "low",
    variant: "high",
  })
  expect(ui.state.synced).toEqual([session.id, session.id])
  expect(wire.calls).toHaveLength(0)
})

test("TUI first-run import publishes only after review and does not enable a Session from home", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const ui = interfaceFor(proof)
  ui.state.prompts.push(JSON.stringify(profile(wire.url)))
  ui.state.selections.push("publish")
  ui.state.confirmations.push(true)
  await ui.run()
  expect((await proof.inspect()).state).toBe("configured")
  expect((await proof.client.sessions.list()).data).toHaveLength(0)
  expect(ui.state.alerts.at(-1)?.message).toContain("Open a Session")
  expect(wire.calls).toHaveLength(0)
})

test("cancelling TUI publication leaves the old profile and draft unchanged", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const old = await proof.publish()
  const ui = interfaceFor(proof)
  ui.state.selections.push("edit", "publish")
  ui.state.prompts.push(JSON.stringify({ ...profile(wire.url), name: "not-committed" }))
  ui.state.confirmations.push(false)
  await ui.run("config")
  const configured = Schema.decodeUnknownSync(
    Schema.Struct({
      draft: Schema.Struct({ name: Schema.String }),
      published: Schema.Struct({ revision: Schema.String }),
    }),
  )(await proof.rpc("config"))
  expect(configured.published.revision).toBe(old.revision)
  expect(configured.draft.name).toBe(old.profile.name)
})

test("TUI rejects inline credentials before saving or displaying raw parse errors", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const ui = interfaceFor(proof)
  ui.state.prompts.push(JSON.stringify({ ...profile(wire.url), apiKey: "DO_NOT_DISPLAY_OR_SAVE" }))
  await ui.run("config")
  expect(await proof.rpc("config")).toEqual({})
  expect(ui.state.toasts.at(-1)?.variant).toBe("error")
  expect(JSON.stringify(ui.state.toasts)).not.toContain("DO_NOT_DISPLAY_OR_SAVE")
})

test("TUI native model and variant selection edits only the chosen draft pair", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  const before = await proof.publish()
  const ui = interfaceFor(proof)
  ui.state.selections.push("models", "low", "high", "medium", "draft")
  await ui.run("config")
  const configured = Schema.decodeUnknownSync(
    Schema.Struct({
      draft: Schema.Struct({
        tiers: Schema.Struct({ low: Schema.Struct({ model: Schema.String, effort: Schema.String }) }),
      }),
      published: Schema.Struct({ revision: Schema.String }),
    }),
  )(await proof.rpc("config"))
  expect(configured.draft.tiers.low).toEqual({ model: "high", effort: "medium" })
  expect(configured.published.revision).toBe(before.revision)
})

test("TUI policy selection is explicit per Session and status opens its owned panel", async () => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish({
    ...profile(wire.url),
    resources: { tauOmit: 0.1 },
    approval: { tauAllow: 0.05, timeoutMs: 5000, maxBytes: 500000, maxTokens: 500000, mcpServers: ["fixture"] },
  })
  const first = await proof.session()
  const second = await proof.session()
  const ui = interfaceFor(proof, first.id)
  ui.state.selections.push("select", "auto")
  await ui.run("policies")
  expect((await proof.inspect(first.id)).contextSelection).toBe("select")
  expect((await proof.inspect(first.id)).approval).toBe("auto")
  expect((await proof.inspect(second.id)).approval).toBe("off")
  await ui.run("status")
  expect(ui.state.panels).toEqual(["self-driving"])
})

test.each([44, 100])("production status view renders unknown usage and native routing at width %d", async (width) => {
  await using wire = endpoint()
  await using proof = await routing(installed.package, wire.url)
  await proof.publish()
  const session = await proof.session()
  await proof.prompt(session.id, "Render real routing status")
  const status = await proof.inspect(session.id)
  const app = await testRender(() => <StatusView status={status} colors={colors} />, {
    width,
    height: 44,
    kittyKeyboard: true,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Self-driving")
    expect(frame).toContain("medium")
    expect(frame).toContain("Physical target:")
    expect(frame).toContain("unknown")
    expect(frame).not.toContain("fixture-key-not-a-live-credential")
  } finally {
    app.renderer.destroy()
  }
})

test("production footer shows the compact configured disabled state", async () => {
  const app = await testRender(
    () => (
      <Footer
        status={{
          version: "0.6.0-dev.0",
          state: "configured",
          enabled: false,
          contextSelection: "inherit",
          approval: "off",
        }}
        compact
        colors={colors}
      />
    ),
    { width: 44, height: 2, kittyKeyboard: true },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("SD:off")
  } finally {
    app.renderer.destroy()
  }
})
