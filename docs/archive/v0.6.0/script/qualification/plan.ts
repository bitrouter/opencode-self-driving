import { Schema } from "effect"
import { decodeProfile, Profile, Tier } from "../../src/config"

const Name = Schema.String.check(Schema.isMinLength(1))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Environment = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/))
export const Case = Schema.Struct({
  id: Name,
  split: Schema.Literals(["tuning", "holdout"]),
  prompt: Name,
  expectedText: Schema.optional(Name),
  acceptableTiers: Schema.Array(Tier),
  contextSelection: Schema.Literals(["inherit", "shadow", "select"]),
  approval: Schema.Literals(["off", "shadow", "auto"]),
  resources: Schema.Array(Schema.Struct({ id: Name, text: Name, required: Schema.Boolean, needed: Schema.Boolean })),
  tool: Schema.optional(Schema.Struct({ text: Name, needsHuman: Schema.Boolean })),
})
export type Case = typeof Case.Type
export const Plan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  profile: Profile,
  endpoints: Schema.Struct({ decision: Name, backends: Schema.Record(Name, Name) }),
  credentials: Schema.Record(Name, Environment),
  limits: Schema.Struct({
    maxRequests: Positive,
    maxOutputTokens: Positive,
    maxDurationMs: Positive,
    maxInputBytes: Positive,
    maxResponseBytes: Positive,
    maxStepsPerCase: Positive,
  }),
  cases: Schema.Array(Case).check(Schema.isMinLength(1)),
})
export type Plan = typeof Plan.Type

export function decodePlan(value: unknown) {
  const plan = Schema.decodeUnknownSync(Plan, { onExcessProperty: "error" })(value)
  decodeProfile(plan.profile)
  if (plan.profile.outputTokens > plan.limits.maxOutputTokens) throw new Error("Output budget exceeds run limit")
  if (new Set(plan.cases.map((item) => item.id)).size !== plan.cases.length) throw new Error("Duplicate case IDs")
  const splits = new Map<string, string>()
  plan.cases.forEach((item) => {
    const input = JSON.stringify({
      prompt: item.prompt,
      resources: item.resources.map((resource) => ({ text: resource.text, required: resource.required })),
    })
    if (splits.has(input) && splits.get(input) !== item.split)
      throw new Error("Tuning and holdout must not reuse the same input")
    splits.set(input, item.split)
  })
  const backends = Object.keys(plan.profile.backends)
  if (
    Object.keys(plan.endpoints.backends).length !== backends.length ||
    backends.some((backend) => !plan.endpoints.backends[backend])
  )
    throw new Error("Every configured backend needs one explicit endpoint")
  Object.entries(plan.profile.backends).forEach(([name, backend]) => {
    if (
      backends.some(
        (other) =>
          plan.profile.backends[other].providerID === backend.providerID &&
          plan.endpoints.backends[other] !== plan.endpoints.backends[name],
      )
    )
      throw new Error("A provider cannot use different qualification endpoints")
  })
  ;[plan.endpoints.decision, ...Object.values(plan.endpoints.backends)].forEach((endpoint) => {
    const url = new URL(endpoint)
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Use HTTPS or loopback endpoints without credentials, query or fragment")
  })
  const integrations = references(plan).filter((auth) => auth.type === "integration")
  if (integrations.some((auth) => !plan.credentials[auth.integrationID]))
    throw new Error("Isolated integrations require an explicit environment key source")
  if (Object.keys(plan.credentials).some((id) => !integrations.some((auth) => auth.integrationID === id)))
    throw new Error("Unreferenced credential sources are unsupported")
  if (
    environmentNames(plan).some(
      (name) =>
        ["HOME", "PATH", "USERPROFILE", "TMPDIR", "TMP", "TEMP"].includes(name) ||
        name.startsWith("XDG_") ||
        (name.startsWith("OPENCODE_") && !["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"].includes(name)),
    )
  )
    throw new Error("Credential references cannot replace the isolated host environment")
  plan.cases.forEach((item) => {
    if (new Set(item.resources.map((resource) => resource.id)).size !== item.resources.length)
      throw new Error("Duplicate resource IDs")
    if (item.contextSelection !== "inherit" && !plan.profile.resources)
      throw new Error("Resource cases require an explicit omission threshold")
    if (item.approval !== "off" && (!plan.profile.approval || !item.tool))
      throw new Error("Approval cases require a labeled tool case and approval budgets")
    if (item.approval !== "off" && !plan.profile.approval?.mcpServers.includes("qualification"))
      throw new Error("Approval cases must explicitly include the qualification MCP server")
  })
  return plan
}

function references(plan: Plan) {
  return [plan.profile.decision.auth, ...Object.values(plan.profile.backends).map((backend) => backend.auth)]
}

export function environmentNames(plan: Plan) {
  return [
    ...new Set([
      ...references(plan).flatMap((auth) => (auth.type === "env" ? [auth.name] : [])),
      ...Object.values(plan.credentials),
    ]),
  ].sort()
}
