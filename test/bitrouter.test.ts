import { expect, test } from "bun:test"
import { launch } from "../src/process"
import { discover } from "../src/catalog"
import { plan } from "../src/plan"
import { host, model, options, provider, temporary } from "./fixture"

test.skipIf(!process.env.BITROUTER_TEST_BINARY)("real BitRouter validates generated YAML/policy and routes to loopback only", async () => {
  await using tmp = await temporary()
  const received: any[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any
      received.push({ path: new URL(request.url).pathname, body, authorization: request.headers.get("authorization") })
      return Response.json({
        id: "loopback", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "local-only" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })
    },
  })
  try {
    const input = host({
      providers: [{ ...provider("local", `${upstream.url.origin}/v1`), settings: { baseURL: `${upstream.url.origin}/v1`, apiKey: "fixture-key" } }],
      models: [{ ...model("local"), modelID: "physical-coder" as any }],
    })
    const generated = await plan(await discover(input.api))
    const generation = await launch(generated, {
      ...options(tmp.directory), command: [process.env.BITROUTER_TEST_BINARY!],
    }, new AbortController().signal)
    try {
      const unauthorized = await fetch(`${generation.url}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "bitrouter/auto", messages: [{ role: "user", content: "must-not-run" }] }),
      })
      expect(unauthorized.status).toBe(401)
      await unauthorized.body?.cancel()
      expect(received).toHaveLength(0)
      const response = await fetch(`${generation.url}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${generation.token}` },
        body: JSON.stringify({ model: "bitrouter/auto", stream: false, max_tokens: 64, messages: [{ role: "user", content: "local-only" }] }),
      })
      const result = await response.json() as any
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.choices[0].message.content).toBe("local-only")
      expect(received).toHaveLength(1)
      expect(received[0].path).toBe("/v1/chat/completions")
      expect(received[0].body.model).toBe("physical-coder")
      expect(received[0].authorization).toBe("Bearer fixture-key")
    } finally { await generation.close() }
  } finally { await upstream.stop(true) }
})

test.skipIf(!process.env.BITROUTER_TEST_BINARY)("real Claude subscription adapter consumes an access-only lease and preserves user instructions", async () => {
  await using tmp = await temporary()
  const received: any[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json()
      received.push({ headers: Object.fromEntries(request.headers), body, path: new URL(request.url).pathname })
      return Response.json({
        id: "msg_fixture", type: "message", role: "assistant", model: "claude-fixture",
        content: [{ type: "text", text: "subscription-local" }], stop_reason: "end_turn",
        stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 },
      })
    },
  })
  try {
    const input = host({
      providers: [{
        ...provider("subscription", `${upstream.url.origin}/v1`), canonical: "anthropic" as any,
        integrationID: "subscription" as any,
      }],
      models: [{ ...model("subscription"), modelID: "claude-fixture" as any }],
      credentials: { subscription: {
        type: "oauth", access: "fixture-oauth-access", refresh: "must-stay-in-opencode", expires: Date.now() + 3_600_000,
      } },
    })
    const generated = await plan(await discover(input.api))
    const generation = await launch(generated, {
      ...options(tmp.directory), command: [process.env.BITROUTER_TEST_BINARY!],
    }, new AbortController().signal)
    try {
      const response = await fetch(`${generation.url}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${generation.token}` },
        body: JSON.stringify({
          model: "bitrouter/auto", stream: false, max_tokens: 64,
          messages: [{ role: "system", content: "Preserve this user policy" }, { role: "user", content: "local fixture" }],
        }),
      })
      const body = await response.json() as any
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.choices[0].message.content).toBe("subscription-local")
      expect(received).toHaveLength(1)
      expect(received[0].headers.authorization).toBe("Bearer fixture-oauth-access")
      expect(received[0].headers["x-api-key"]).toBeUndefined()
      expect(JSON.stringify(received[0].body)).toContain("Preserve this user policy")
      expect(JSON.stringify(generated.credentials)).not.toContain("must-stay-in-opencode")
    } finally { await generation.close() }
  } finally { await upstream.stop(true) }
})
