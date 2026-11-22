import { readFile } from "node:fs/promises"
import type { Catalog, Source } from "./catalog.js"
import { digest } from "./catalog.js"
import type { Options } from "./options.js"

export interface Plan {
  revision: string
  config: Record<string, unknown>
  policy: Record<string, unknown>
  env: Record<string, string>
  credentials: Record<string, Record<string, unknown>>
  catalog: Catalog
  limits: { context: number; input: number; output: number }
  routing: "bootstrap" | "published-policy"
}
export const target = (source: Source) => `${source.provider}:${source.model.id}`
export const tier = (source: Source) => `model_${digest(source.id).slice(0, 16)}`

export async function plan(catalog: Catalog, policyFile?: string, decision?: Options["decision"]): Promise<Plan> {
  if (!catalog.sources.length) throw new Error("No exportable models; original OpenCode providers remain unchanged")
  const providers: Record<string, any> = {}
  const env: Record<string, string> = {}
  const credentials: Plan["credentials"] = {}
  const subscriptionHeaders = new Map<string, string>()
  const secret = (name: string, value: string) => {
    // BitRouter substitutes before YAML parsing: inject a complete JSON/YAML scalar,
    // not unescaped characters into a quoted placeholder.
    env[name] = JSON.stringify(value)
    return `\${${name}}`
  }
  for (const source of catalog.sources) {
    if (source.oauth) {
      const identity = digest({ baseURL: source.baseURL, headers: source.headers })
      if (subscriptionHeaders.has(source.provider) && subscriptionHeaders.get(source.provider) !== identity)
        throw new Error("Subscription aliases have incompatible endpoint or headers")
      subscriptionHeaders.set(source.provider, identity)
    }
    const variable = `OPENCODE_BITROUTER_${digest(source.kind === "subscription" ? source.provider : source.id).slice(0, 16).toUpperCase()}`
    const headers = Object.fromEntries(Object.entries(source.headers).map(([name, value], index) => [
      name, secret(`${variable}_HEADER_${index}`, value),
    ]))
    if (providers[source.provider] && (
      providers[source.provider].api_base !== source.baseURL ||
      JSON.stringify(providers[source.provider].headers) !== JSON.stringify(headers)
    )) throw new Error("Subscription aliases have incompatible endpoint or headers")
    const entry = providers[source.provider] ??= {
      api_base: source.baseURL, active: true, auto_discover: false, headers,
      api_protocol: [{ "*": source.protocol }], models: [],
      tags: ["opencode", source.kind],
      ...(source.key ? { api_key: secret(`${variable}_KEY`, source.key) } : {}),
    }
    if (source.oauth) {
      const existing = credentials[source.provider]?.default
      if (existing && JSON.stringify(existing) !== JSON.stringify({ type: "oauth", data: source.oauth }))
        throw new Error("Subscription aliases have incompatible active accounts")
      credentials[source.provider] = { default: { type: "oauth", data: source.oauth } }
    }
    const costs = source.model.cost
    const flatCost = costs.length === 1 && !costs[0].tier ? costs[0] : undefined
    entry.models.push({
      id: source.model.id, provider_model_id: source.model.modelID, api_protocol: source.protocol,
      ...(source.compatibility ? { compatibility: source.compatibility } : {}),
      capabilities: ["tools", ...(source.model.capabilities.input.includes("image") ? ["image_input"] : [])],
      token_limits: {
        context_window: source.model.limit.context,
        max_input_tokens: source.model.limit.input ?? source.model.limit.context,
        max_output_tokens: source.model.limit.output,
      },
      ...(flatCost && source.kind === "byok" ? { pricing: {
        input_micro_usd_per_token: flatCost.input,
        output_micro_usd_per_token: flatCost.output,
        cache_read_micro_usd_per_token: flatCost.cache?.read,
        cache_write_micro_usd_per_token: flatCost.cache?.write,
      } } : {}),
    })
  }
  const preferred = catalog.sources.find((source) => source.id === catalog.defaultSource) ?? catalog.sources[0]
  let policy: Record<string, any> = {
    lockfileVersion: 4,
    artifact: {
      evidence_root: `sha256:${digest("")}`, source_snapshot_time_unix_ms: 0,
      compiler: { id: "opencode-bitrouter-bootstrap", version: 1, config_digest: `sha256:${digest(catalog.sources.map((source) => source.id))}` },
    },
    policies: {
      auto: {
        key_strategy: "agent_trace",
        tiers: Object.fromEntries(catalog.sources.map((source) => [tier(source), { model: target(source), context: "preserve" }])),
        routes: {}, default_tier: tier(preferred), tool_use_tier: tier(preferred),
        tool_safe_tiers: catalog.sources.map(tier),
      },
    },
  }
  if (policyFile) {
    const text = await readFile(policyFile, "utf8")
    if (text.includes("${")) throw new Error("Policy must not interpolate the private child environment")
    const supplied = Bun.YAML.parse(text) as typeof policy
    if (supplied?.lockfileVersion !== 4 || !supplied.policies?.auto?.tiers)
      throw new Error("policyFile must contain a version 4 auto policy")
    const allowed = new Set(catalog.sources.map(target))
    for (const entry of Object.values(supplied.policies) as any[])
      for (const action of Object.values(entry.tiers ?? {}) as any[])
        if (!allowed.has(action.model) || action.context !== "preserve")
          throw new Error("Policy targets must remain inside the imported pool and preserve context")
    policy = supplied
  }
  const limits = {
    context: Math.min(...catalog.sources.map((source) => source.model.limit.context)),
    input: Math.min(...catalog.sources.map((source) => Math.min(source.model.limit.context, source.model.limit.input ?? source.model.limit.context))),
    output: Math.min(...catalog.sources.map((source) => source.model.limit.output)),
  }
  const config = {
    inherit_defaults: false, registry: { enabled: false, auto_refresh: false },
    providers, policy: { path: "./policy-lock.yaml", mode: "frozen" },
    routers: { auto: { selection: { kind: "policy", policy: "auto", base_model: target(preferred) } } },
    ...(decision ? { decision_model: {
      model: decision.model, base_url: decision.baseURL, api_key_env: "OPENCODE_BITROUTER_DECISION",
    } } : {}),
  }
  if (decision) {
    const key = process.env[decision.apiKeyEnv]
    if (!key) throw new Error("Decision credential environment variable is unavailable")
    env.OPENCODE_BITROUTER_DECISION = key
  }
  return {
    revision: digest({ config, policy, env, credentials, limits }),
    config, policy, env, credentials, catalog, limits,
    routing: policyFile ? "published-policy" : "bootstrap",
  }
}
