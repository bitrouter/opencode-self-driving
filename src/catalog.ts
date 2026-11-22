import type { Credential, Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"

export type Kind = "byok" | "subscription" | "local"
export type Protocol = "chat_completions" | "responses" | "messages"
export interface Source {
  id: string
  provider: string
  model: Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
  kind: Kind
  baseURL: string
  protocol: Protocol
  headers: Record<string, string>
  compatibility?: { chat_completions: { token_limit_field?: string; supports_stream_options?: boolean } }
  key?: string
  oauth?: { access_token: string; expires_at: number }
}
export interface Issue { source: string; reason: string }
export interface Catalog {
  sources: Source[]
  issues: Issue[]
  defaultSource?: string
}
export type Host = Pick<Plugin.Context, "provider" | "model" | "integration"> & { location?: Plugin.Context["location"] }
export const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex")
export const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)

const endpoints: Record<string, [string, Protocol]> = {
  openai: ["https://api.openai.com/v1", "responses"],
  anthropic: ["https://api.anthropic.com/v1", "messages"],
  openrouter: ["https://openrouter.ai/api/v1", "chat_completions"],
  google: ["https://generativelanguage.googleapis.com/v1beta/openai", "chat_completions"],
  ollama: ["http://127.0.0.1:11434/v1", "chat_completions"],
  lmstudio: ["http://127.0.0.1:1234/v1", "chat_completions"],
  vllm: ["http://127.0.0.1:8000/v1", "chat_completions"],
  opencode: ["https://opencode.ai/zen/v1", "chat_completions"],
  "opencode-go": ["https://opencode.ai/zen/go/v1", "chat_completions"],
}
const subscriptions: Record<string, [string, string, Protocol]> = {
  openai: ["openai-codex", "https://chatgpt.com/backend-api/codex", "responses"],
  anthropic: ["claude-code", "https://api.anthropic.com/v1", "messages"],
  "github-copilot": ["github-copilot", "https://api.githubcopilot.com", "chat_completions"],
}
const packages = new Set([
  "@opencode/ai/providers/openai", "@opencode/ai/providers/openai/chat",
  "@opencode/ai/providers/openai/responses", "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses", "@opencode/ai/providers/anthropic",
  "@opencode/ai/providers/anthropic-compatible", "@opencode/ai/providers/openrouter",
  "@opencode/ai/providers/google",
])
const localProviders = new Set(["ollama", "lmstudio", "vllm"])

function endpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing endpoint")
  if (value.includes("${")) throw new Error("unresolved endpoint interpolation")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("unsupported endpoint")
  return url.href.replace(/\/$/, "")
}

async function connection(host: Host, provider: Awaited<ReturnType<Host["provider"]["list"]>>["data"][number]): Promise<Credential.Value | undefined> {
  if (!provider.integrationID) return undefined
  const selected = await host.integration.connection.active(provider.integrationID)
  return selected ? host.integration.connection.resolve(selected) : undefined
}

export async function discover(host: Host, frontend?: string): Promise<Catalog> {
  const [models, providers, preferred] = await Promise.all([
    host.model.list({ location: host.location }),
    host.provider.list({ location: host.location }),
    host.model.default({ location: host.location }),
  ])
  const sources: Source[] = []
  const issues: Issue[] = []
  const credentials = new Map<string, Promise<Credential.Value | undefined>>()
  const subscriptionOwners = new Map<string, string>()
  for (const model of [...models.data].sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`))) {
    if (model.providerID === "bitrouter" || model.providerID === "self-driving" || !model.enabled) continue
    const id = `${model.providerID}/${model.id}`
    const provider = providers.data.find((item) => item.id === model.providerID)
    if (!provider || provider.activation === "disabled") continue
    const reject = (reason: string) => issues.push({ source: id, reason })
    if (model.id.includes("${") || model.modelID.includes("${")) {
      reject("model identifiers must not contain BitRouter interpolation")
      continue
    }
    if ((model.type ?? "chat") !== "chat" || !model.capabilities.tools ||
      !model.capabilities.input.includes("text") || !model.capabilities.output.includes("text")) {
      reject("not a tool-capable chat model")
      continue
    }
    const settings = { ...provider.settings, ...model.settings }
    const packageName = model.package ?? provider.package
    const canonical = provider.canonical ?? provider.id
    if (!packages.has(packageName) && !localProviders.has(canonical) && canonical !== "github-copilot") {
      reject("provider package needs a BitRouter adapter")
      continue
    }
    if (
      Object.keys(provider.body ?? {}).length || Object.keys(model.body ?? {}).length ||
      Object.keys(settings).some((key) => ![
        "baseURL", "apiKey", "transport", "encoding", "compaction",
      ].includes(key)) || settings.tls
    ) {
      reject("request settings/body cannot be faithfully exported")
      continue
    }
    const quirks = { ...provider.compatibility, ...model.compatibility }
    if (Object.keys(quirks).some((key) => !["maxTokensField", "streamUsage"].includes(key))) {
      reject("provider compatibility needs an explicit BitRouter mapping")
      continue
    }
    const compatibility = Object.keys(quirks).length ? { chat_completions: {
      ...(quirks.maxTokensField ? { token_limit_field: quirks.maxTokensField } : {}),
      ...(quirks.streamUsage !== undefined ? { supports_stream_options: quirks.streamUsage } : {}),
    } } : undefined
    if (!(model.limit.context > model.limit.output && model.limit.output > 0 && (model.limit.input ?? model.limit.context) > 0)) {
      reject("unknown model capacity")
      continue
    }
    try {
      // Resolve one active connection per provider, through the host. Never read its database/auth files.
      if (!credentials.has(provider.id)) credentials.set(provider.id, connection(host, provider))
      const value = await credentials.get(provider.id)
      const headers = Object.fromEntries([
        ...Object.entries(provider.headers ?? {}), ...Object.entries(model.headers ?? {}),
      ].map(([name, value]) => [name.toLowerCase(), value]))
      if (Object.keys(headers).some((name) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))) {
        reject("invalid HTTP header name")
        continue
      }
      // Ambiguous account overrides must not turn subscription traffic into API-key billing.
      if (value?.type === "external") {
        reject("external credential requires an explicit adapter")
        continue
      }
      if (value?.type === "oauth") {
        const binding = subscriptions[canonical]
        if (!binding || settings.apiKey || headers.authorization || headers["x-api-key"]) {
          reject("unsupported or ambiguous subscription authentication")
          continue
        }
        // The host is the only refresh owner. Export an access-only lease, never its refresh token.
        if (!value.access || (value.expires !== 0 && value.expires < Date.now() + 30_000)) {
          reject("subscription requires renewal in OpenCode")
          continue
        }
        const owner = subscriptionOwners.get(binding[0])
        if (owner && owner !== provider.id) {
          reject("multiple provider aliases share one native subscription adapter")
          continue
        }
        subscriptionOwners.set(binding[0], provider.id)
        const protocol = binding[0] === "github-copilot"
          ? model.modelID.startsWith("claude-") ? "messages" : model.modelID.includes("codex") ? "responses" : binding[2]
          : binding[2]
        const baseURL = endpoint(settings.baseURL ?? binding[1])
        if (frontend && new URL(baseURL).origin === new URL(frontend).origin) {
          reject("recursive BitRouter endpoint")
          continue
        }
        sources.push({
          id, provider: binding[0], model, kind: "subscription",
          baseURL, protocol, headers, compatibility,
          oauth: { access_token: value.access, expires_at: 0 },
        })
        continue
      }
      const defaults = endpoints[canonical]
      const baseURL = endpoint(settings.baseURL ?? defaults?.[0])
      if (frontend && new URL(baseURL).origin === new URL(frontend).origin) {
        reject("recursive BitRouter endpoint")
        continue
      }
      const local = localProviders.has(canonical) || isLoopback(new URL(baseURL))
      const key = typeof settings.apiKey === "string" && settings.apiKey
        ? settings.apiKey
        : value?.type === "key" ? value.key : undefined
      if (!local && !key && !headers.authorization && !headers["x-api-key"]) {
        reject("no active credential")
        continue
      }
      let protocol = defaults?.[1] ?? "chat_completions"
      if (packageName.endsWith("/responses")) protocol = "responses"
      if (packageName.endsWith("/chat") || packageName.includes("openai-compatible")) protocol = packageName.endsWith("/responses") ? "responses" : "chat_completions"
      if (packageName.includes("anthropic")) protocol = "messages"
      if (canonical === "opencode" || canonical === "opencode-go")
        protocol = model.modelID.startsWith("claude-") ? "messages" : "chat_completions"
      sources.push({
        id, provider: `oc_${digest(id).slice(0, 16)}`, model,
        kind: local ? "local" : (canonical === "opencode-go" || provider.id === "opencode-go") ? "subscription" : "byok",
        baseURL, protocol, headers, compatibility, ...(key ? { key } : {}),
      })
    } catch {
      // Provider exceptions may contain URLs, tokens or raw response text. Never retain them.
      reject("credential or endpoint unavailable")
    }
  }
  const selected = preferred.data
  return {
    sources, issues,
    defaultSource: selected && sources.find((source) =>
      source.model.providerID === selected.providerID && source.model.id === selected.id)?.id || undefined,
  }
}
