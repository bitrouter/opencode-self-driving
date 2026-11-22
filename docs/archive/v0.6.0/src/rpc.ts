import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import { Limit, Policies, Profile, Published, Resource, Tier, TIERS } from "./config.js"

export { Policies, Profile, Published, Resource, Tier, TIERS }

const Session = Schema.Struct({ sessionID: Schema.String })
const Model = Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optional(Schema.String) })
export const ResourceResult = Schema.Struct({
  mode: Policies.fields.contextSelection,
  outcome: Schema.Literals(["inherited", "selected", "shadow", "fallback"]),
  viewRevision: Schema.String,
  units: Schema.Array(Schema.Struct({ ...Resource.fields, version: Schema.String })),
  omitted: Schema.Array(Schema.String),
  proposed: Schema.Array(Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  reason: Schema.optional(Schema.String),
  decision: Schema.optional(Schema.JsonObject),
})
export type ResourceResult = typeof ResourceResult.Type
export const ApprovalResult = Schema.Struct({
  mode: Policies.fields.approval,
  action: Schema.String,
  outcome: Schema.Literals(["allowed", "shadow", "manual-required"]),
  reason: Schema.String,
  source: Schema.optional(Schema.Struct({ messageID: Schema.String, id: Schema.String })),
  evidenceRevision: Schema.optional(Schema.String),
  probability: Schema.optional(Schema.Number),
  decision: Schema.optional(Schema.JsonObject),
})
export type ApprovalResult = typeof ApprovalResult.Type
export const Route = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  revision: Schema.String,
  capacityRevision: Schema.String,
  kind: Schema.Literals(["primary", "title", "compaction", "generate"]),
  selection: Schema.Literals(["decision", "capacity", "fixed"]),
  tier: Schema.optional(Tier),
  eligibleTiers: Schema.Array(Tier),
  excluded: Schema.Array(Schema.Struct({ tier: Tier, reason: Schema.String })),
  backend: Schema.String,
  model: Schema.String,
  physicalModel: Schema.String,
  effort: Schema.optional(Schema.String),
  inputEstimate: Schema.Number,
  outputTokens: Schema.Number,
  resources: Schema.optional(ResourceResult),
  decision: Schema.optional(
    Schema.Struct({
      service: Schema.String,
      requestedModel: Schema.String,
      responseModel: Schema.String,
      probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
      confidence: Schema.optional(Schema.Number),
      inputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.optional(Schema.Number),
      evidenceBytes: Schema.Number,
      omitted: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
    }),
  ),
  generationUsage: Schema.optional(
    Schema.Struct({ inputTokens: Schema.optional(Schema.Number), outputTokens: Schema.optional(Schema.Number) }),
  ),
})
export type Route = typeof Route.Type

export const Status = Schema.Struct({
  version: Schema.String,
  state: Schema.Literals(["unconfigured", "configured"]),
  enabled: Schema.Boolean,
  contextSelection: Policies.fields.contextSelection,
  approval: Policies.fields.approval,
  lastApproval: Schema.optional(ApprovalResult),
  lifecycle: Schema.optional(
    Schema.Struct({
      available: Schema.Boolean,
      applying: Schema.Boolean,
      preparing: Schema.Number,
      pending: Schema.Number,
      streaming: Schema.Number,
      approval: Schema.Number,
      views: Schema.Number,
      calls: Schema.Number,
      checkpoints: Schema.Number,
      deadlines: Schema.Number,
    }),
  ),
  revision: Schema.optional(Schema.String),
  capacityRevision: Schema.optional(Schema.String),
  limit: Schema.optional(Limit),
  capacityEstimator: Schema.optional(Schema.Literal("utf8-bytes")),
  previousModel: Schema.optional(Model),
  lastRoute: Schema.optional(Route),
  lastFailure: Schema.optional(
    Schema.Struct({ requestID: Schema.String, kind: Schema.String, revision: Schema.String, message: Schema.String }),
  ),
})

export const Contract = Rpc.define({
  id: "opencode-self-driving",
  methods: {
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
      output: Schema.toStandardSchemaV1(Status),
    },
    config: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({ draft: Schema.optional(Profile), published: Schema.optional(Published) }),
      ),
    },
    draft: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ profile: Schema.Json })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ saved: Schema.Boolean })),
    },
    publish: { input: Schema.toStandardSchemaV1(Schema.Struct({})), output: Schema.toStandardSchemaV1(Published) },
    enable: { input: Schema.toStandardSchemaV1(Session), output: Schema.toStandardSchemaV1(Status) },
    disable: { input: Schema.toStandardSchemaV1(Session), output: Schema.toStandardSchemaV1(Status) },
    policies: { input: Schema.toStandardSchemaV1(Policies), output: Schema.toStandardSchemaV1(Status) },
  },
  events: {
    checkpoint: { schema: Schema.toStandardSchemaV1(Schema.Struct({ token: Schema.String })) },
    configuration: { schema: Schema.toStandardSchemaV1(Schema.Struct({ applying: Schema.Boolean })) },
  },
})

export default Contract
