import { expect, test } from "bun:test"
import { discover } from "../src/catalog"
import { plan } from "../src/plan"
import { host, model, provider } from "./fixture"
import { options } from "../src/options"

test("discovers BYOK, subscription and local models from the effective catalogs", async () => {
  const key = { ...provider("key"), integrationID: "key" as any }
  const oauth = { ...provider("subscription"), canonical: "openai" as any, integrationID: "oauth" as any }
  const input = host({
    providers: [key, oauth, provider("local", "http://127.0.0.1:1234/v1")],
    models: [model("key"), model("subscription"), model("subscription", "other"), model("local")],
    credentials: {
      key: { type: "key", key: "fixture-api-key" },
      oauth: { type: "oauth", access: "fixture-access", refresh: "NEVER_COPY_REFRESH", expires: Date.now() + 3_600_000 },
    },
  })
  const catalog = await discover(input.api)
  expect(catalog.sources.map((source) => source.kind).sort()).toEqual(["byok", "local", "subscription", "subscription"])
  expect(input.state.resolutions).toBe(2)
  expect(catalog.sources.find((source) => source.kind === "subscription")?.provider).toBe("openai-codex")
  const result = await plan(catalog)
  expect(JSON.stringify(result)).not.toContain("NEVER_COPY_REFRESH")
  expect(JSON.stringify(result.config)).not.toContain("fixture-api-key")
  expect(result.config.inherit_defaults).toBe(false)
  expect(result.routing).toBe("bootstrap")
  expect(Object.keys((result.policy as any).policies.auto.tiers)).toHaveLength(4)
  expect((result.policy as any).policies.auto.routes).toEqual({})
})

test("preserves upstream model IDs, endpoint paths and case-insensitive header precedence", async () => {
  const definition = { ...model("local", "friendly"), modelID: "real/upstream" as any, headers: { "x-tenant": "model" } }
  const input = host({ models: [definition], providers: [{ ...provider("local", "http://127.0.0.1:1234/prefix/v1"), headers: { "X-Tenant": "provider" } } as any] })
  const result = await plan(await discover(input.api))
  const exported = Object.values(result.config.providers as any)[0] as any
  expect(exported.api_base).toEndWith("/prefix/v1")
  expect(exported.models[0].provider_model_id).toBe("real/upstream")
  expect(Object.values(result.env)).toContain('"model"')
  expect(result.limits.context).toBe(32768)
})

test("disabled models, recursion, unsupported packages and unfaithful request overrides are not exported", async () => {
  const input = host({
    providers: [
      provider("bitrouter"), provider("recursive", "http://127.0.0.1:3456/v1"),
      provider("disabled"), { ...provider("unknown"), package: "private-runtime" }, provider("body"),
    ],
    models: [
      model("bitrouter", "auto"), model("recursive"), { ...model("disabled"), enabled: false },
      model("unknown"), { ...model("body"), body: { reasoning: "high" } },
    ],
  })
  const result = await discover(input.api, "http://127.0.0.1:3456")
  expect(result.sources).toEqual([])
  expect(result.issues).toHaveLength(3)
})

test("expired, external and ambiguous subscription credentials stay unavailable", async () => {
  const input = host({
    providers: ["expired", "external", "ambiguous"].map((id) => ({
      ...provider(id), canonical: "openai" as any, integrationID: id as any,
      ...(id === "ambiguous" ? { settings: { baseURL: "https://example.test/v1", apiKey: "other-key" } } : {}),
    })),
    models: ["expired", "external", "ambiguous"].map((id) => model(id)),
    credentials: {
      expired: { type: "oauth", access: "expired", expires: Date.now() - 1 },
      external: { type: "external" },
      ambiguous: { type: "oauth", access: "token", expires: Date.now() + 60_000 },
    },
  })
  expect((await discover(input.api)).sources).toEqual([])
})

test("provider failures are redacted and leave the remaining source available", async () => {
  const input = host()
  const selected = { ...provider("broken"), integrationID: "broken" as any }
  input.state.providers.push(selected)
  input.state.models.push(model("broken"))
  input.state.failConnections = true
  const result = await discover(input.api)
  expect(result.sources).toHaveLength(1)
  expect(JSON.stringify(result.issues)).not.toContain("secret-token-example")
})

test("rejects unknown options rather than treating old profile options as valid", () => {
  expect(() => options({ tiers: {} })).toThrow()
  expect(() => options({ command: "bro" })).toThrow()
  expect(() => options({ startupTimeoutMs: 0 })).toThrow()
  expect(options({}).command).toEqual(["bro"])
})

test("untrusted model metadata cannot interpolate a different provider's child environment", async () => {
  const input = host({ models: [{ ...model("local"), modelID: "${OPENCODE_BITROUTER_PRIVATE_KEY}" as any }] })
  expect((await discover(input.api)).sources).toHaveLength(0)
  expect(options({ policyFile: "./policy.yaml", stateDirectory: "./state" }, "/workspace").policyFile).toBe("/workspace/policy.yaml")
})

test("key-based OpenCode Go stays a subscription and known compatibility flags are mapped", async () => {
  const input = host({
    providers: [{
      ...provider("opencode-go"),
      settings: { apiKey: "fixture-go-key", baseURL: "https://opencode.ai/zen/go/v1" },
    }],
    models: [{ ...model("opencode-go"), compatibility: { maxTokensField: "max_tokens", streamUsage: false } }],
  })
  const result = await plan(await discover(input.api))
  expect(result.catalog.sources[0].kind).toBe("subscription")
  const exported = Object.values(result.config.providers as any)[0] as any
  expect(exported.models[0].compatibility.chat_completions).toEqual({ token_limit_field: "max_tokens", supports_stream_options: false })
  expect(exported.models[0].pricing).toBeUndefined()
})
