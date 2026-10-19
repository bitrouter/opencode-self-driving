import { Schema } from "effect"

export const TIERS = ["low", "medium", "high", "xhigh", "max"] as const
export const Tier = Schema.Literals(TIERS)
export type Tier = typeof Tier.Type
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Name = Schema.String.check(Schema.isMinLength(1))
const Endpoint = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/))
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export const Policies = Schema.Struct({
  sessionID: Schema.String,
  contextSelection: Schema.Literals(["inherit", "shadow", "select"]),
  approval: Schema.Literals(["off", "shadow", "auto"]),
})
export type Policies = typeof Policies.Type
export const Resource = Schema.Struct({
  id: Name,
  kind: Schema.Literals(["instruction", "tool-bundle"]),
  source: Name,
  required: Schema.Boolean,
  dependencies: Schema.Array(Name),
  tools: Schema.Array(Name),
})
export type Resource = typeof Resource.Type

export const Auth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("integration"), integrationID: Name }),
  Schema.Struct({ type: Schema.Literal("env"), name: Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/)) }),
])
export type Auth = typeof Auth.Type
export const Backend = Schema.Struct({
  service: Schema.Literals(["openai-chat", "openrouter"]),
  providerID: Name,
  auth: Auth,
})
export type Backend = typeof Backend.Type
export const Pair = Schema.Struct({ backend: Name, model: Name, effort: Schema.optional(Name) })
export type Pair = typeof Pair.Type

export const Profile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Name,
  backends: Schema.Record(Name, Backend),
  decision: Schema.Struct({
    service: Schema.Literals(["typesafe-ai", "opencode", "openrouter", "vercel-ai-gateway"]),
    model: Name,
    allowedResponseModels: Schema.Array(Name).check(Schema.isMinLength(1)),
    auth: Auth,
    baseURL: Schema.optional(Endpoint),
    maxInputBytes: Positive,
    maxInputTokens: Positive,
  }),
  tiers: Schema.Struct({ low: Pair, medium: Pair, high: Pair, xhigh: Pair, max: Pair }),
  auxiliary: Schema.Struct({ title: Pair, compaction: Pair, generate: Pair }),
  outputTokens: Positive,
  overheadTokens: Nonnegative,
  preparationTimeoutMs: Positive,
  evidence: Schema.Struct({ mode: Schema.Literals(["bounded", "full"]), maxBytes: Positive, maxTokens: Positive }),
  resources: Schema.optional(Schema.Struct({ tauOmit: Probability })),
  approval: Schema.optional(
    Schema.Struct({
      tauAllow: Probability,
      timeoutMs: Positive,
      maxBytes: Positive,
      maxTokens: Positive,
      mcpServers: Schema.Array(Name).check(Schema.isMinLength(1)),
    }),
  ),
})
export type Profile = typeof Profile.Type
export const Limit = Schema.Struct({ input: Positive, context: Positive, output: Positive })
export const Published = Schema.Struct({ revision: Name, capacityRevision: Name, profile: Profile, limit: Limit })
export type Published = typeof Published.Type

export function decodeProfile(input: unknown) {
  const profile = Schema.decodeUnknownSync(Profile, { onExcessProperty: "error" })(input)
  Object.values(profile.backends).forEach((backend) => {
    if (backend.providerID === "self-driving") throw new Error("Recursive self-driving backends are unsupported")
  })
  const pairs = [...Object.values(profile.tiers), ...Object.values(profile.auxiliary)]
  pairs.forEach((pair) => {
    if (!profile.backends[pair.backend]) throw new Error("Unknown backend reference")
  })
  if (profile.decision.baseURL) {
    const url = new URL(profile.decision.baseURL)
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Decision endpoint must not contain credentials, query parameters or fragments")
  }
  return profile
}
