import { expect, test } from "bun:test"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Connector } from "../src/connector"
import { discover } from "../src/catalog"
import { plan, target } from "../src/plan"
import { launch } from "../src/process"
import { host, model, options, provider, temporary } from "./fixture"

function request(connector: Connector, extra: Record<string, unknown> = {}) {
  return fetch(`${connector.url}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${connector.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "bitrouter/auto", messages: [{ role: "user", content: "fixture" }], ...extra }),
  })
}
test("managed process validates, starts, authenticates ingress and removes its files", async () => {
  await using tmp = await temporary()
  const input = host()
  let notifications = 0
  const connector = new Connector(input.api, options(tmp.directory), async () => { notifications++ })
  try {
    await connector.sync()
    expect(connector.status().state).toBe("ready")
    const path = connector.status().configPath!
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, "utf8")).toContain("inherit_defaults: false")
    expect((await fetch(`${connector.url}/v1/chat/completions`, { method: "POST" })).status).toBe(401)
    expect((await request(connector)).status).toBe(200)
    expect((await request(connector, { model: "openai/unimported" })).status).toBe(400)
    const response = await fetch(`${connector.url}/v1/models`, { headers: { authorization: `Bearer ${connector.token}` } })
    expect((await response.json() as any).data[0].id).toBe("bitrouter/auto")
    expect(notifications).toBe(1)
  } finally { await connector.close() }
  expect(await readdir(tmp.directory)).toEqual([])
})

test("credential rotation and logout are reconciled before dispatch without copying refresh tokens", async () => {
  await using tmp = await temporary()
  const input = host({
    providers: [{ ...provider("subscription"), canonical: "openai" as any, integrationID: "subscription" as any }],
    models: [model("subscription")],
    credentials: { subscription: { type: "oauth", access: "first", refresh: "never-export", expires: Date.now() + 3_600_000 } },
  })
  const connector = new Connector(input.api, options(tmp.directory), async () => {})
  try {
    await connector.sync()
    const first = await request(connector)
    expect((await first.json() as any).fixture.credentials["openai-codex"].default.data.access_token).toBe("first")
    input.state.credentials.subscription = { type: "oauth", access: "rotated", refresh: "new-refresh", expires: Date.now() + 3_600_000 }
    const second = await request(connector)
    const json = await second.json() as any
    expect(json.fixture.credentials["openai-codex"].default.data.access_token).toBe("rotated")
    expect(JSON.stringify(json)).not.toContain("refresh")
    delete input.state.credentials.subscription
    expect((await request(connector)).status).toBe(503)
    expect(connector.status().state).toBe("unavailable")
  } finally { await connector.close() }
})

test("failed candidate startup preserves the previous generation but blocks stale dispatch", async () => {
  await using tmp = await temporary()
  const input = host()
  let fail = false
  const connector = new Connector(input.api, options(tmp.directory), async () => {}, async (...args) => {
    if (fail) throw new Error("fixture-secret-must-not-leak")
    return launch(...args)
  })
  try {
    await connector.sync()
    const first = connector.status().configPath!
    input.state.models[0] = { ...model("local"), limit: { context: 65536, output: 4096 } }
    fail = true
    await connector.sync()
    expect(await Bun.file(first).exists()).toBe(true)
    expect((await request(connector)).status).toBe(503)
    expect(JSON.stringify(connector.status())).not.toContain("fixture-secret")
    fail = false
    expect((await request(connector)).status).toBe(200)
  } finally { await connector.close() }
})

test("parallel syncs coalesce and a retired generation drains existing responses", async () => {
  await using tmp = await temporary()
  const input = host()
  let starts = 0
  const connector = new Connector(input.api, options(tmp.directory), async () => {}, async (...args) => {
    starts++
    return launch(...args)
  })
  try {
    await Promise.all([connector.sync(), connector.sync(), connector.sync()])
    expect(starts).toBe(1)
    const pending = request(connector, { fixtureHold: true })
    await Bun.sleep(40)
    input.state.models.push(model("local", "second"))
    await connector.sync()
    const response = await pending
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(starts).toBe(2)
  } finally { await connector.close() }
})

test("published policy cannot escape the imported pool or grant context pruning", async () => {
  await using tmp = await temporary()
  const input = host()
  const catalog = await discover(input.api)
  const generated = await plan(catalog)
  const file = join(tmp.directory, "user-policy.yaml")
  await writeFile(file, Bun.YAML.stringify(generated.policy))
  expect((await plan(catalog, file)).routing).toBe("published-policy")
  const policy = structuredClone(generated.policy) as any
  const action = Object.values(policy.policies.auto.tiers)[0] as any
  expect(action.model).toBe(target(catalog.sources[0]))
  action.context = "evidence"
  await writeFile(file, Bun.YAML.stringify(policy))
  await expect(plan(catalog, file)).rejects.toThrow()
  action.context = "preserve"
  action.model = "unimported:paid"
  await writeFile(file, Bun.YAML.stringify(policy))
  await expect(plan(catalog, file)).rejects.toThrow()
})

test("quoted header/key values survive BitRouter pre-parse substitution safely", async () => {
  await using tmp = await temporary()
  const input = host({
    providers: [{ ...provider("key"), settings: { baseURL: "https://example.test/v1", apiKey: 'key:"\\\nfixture' }, headers: { "X-Fixture": 'header:"fixture' } } as any],
    models: [model("key")],
  })
  const connector = new Connector(input.api, options(tmp.directory), async () => {})
  try {
    await connector.sync()
    expect(connector.status().state).toBe("ready")
    const result = await request(connector)
    expect((await result.json() as any).fixture.headers[0]["x-fixture"]).toBe('header:"fixture')
  } finally { await connector.close() }
})

test("client cancellation leaves the current router usable and unload cleans all generations", async () => {
  await using tmp = await temporary()
  const input = host()
  const connector = new Connector(input.api, options(tmp.directory), async () => {})
  try {
    await connector.sync()
    const controller = new AbortController()
    const pending = fetch(`${connector.url}/v1/chat/completions`, {
      method: "POST", signal: controller.signal,
      headers: { authorization: `Bearer ${connector.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "bitrouter/auto", fixtureHold: true, messages: [] }),
    })
    const settled = pending.then((response) => ({ response, error: undefined }), (error: unknown) => ({ response: undefined, error }))
    await Bun.sleep(30)
    controller.abort()
    expect((await settled).error).toBeDefined()
    const healthy = await request(connector)
    expect(healthy.status).toBe(200)
    await healthy.body?.cancel()
  } finally { await connector.close() }
  expect(await readdir(tmp.directory)).toEqual([])
})

test("credentials are resolved after a slow request upload, not before it", async () => {
  await using tmp = await temporary()
  const input = host({
    providers: [{ ...provider("subscription"), canonical: "openai" as any, integrationID: "subscription" as any }],
    models: [model("subscription")],
    credentials: { subscription: { type: "oauth", access: "before-upload", expires: Date.now() + 3_600_000 } },
  })
  const connector = new Connector(input.api, options(tmp.directory), async () => {})
  try {
    await connector.sync()
    let upload!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upload = controller
        controller.enqueue(new TextEncoder().encode('{"model":"bitrouter/auto",'))
      },
    })
    const pending = fetch(`${connector.url}/v1/chat/completions`, {
      method: "POST", body,
      headers: { authorization: `Bearer ${connector.token}`, "content-type": "application/json" },
    })
    await Bun.sleep(30)
    input.state.credentials.subscription = { type: "oauth", access: "after-upload", expires: Date.now() + 3_600_000 }
    upload.enqueue(new TextEncoder().encode('"messages":[]}'))
    upload.close()
    const response = await pending
    expect(response.status).toBe(200)
    expect((await response.json() as any).fixture.credentials["openai-codex"].default.data.access_token).toBe("after-upload")
  } finally { await connector.close() }
})
