import type { SessionContext, SessionRequest } from "@opencode/plugin/promise/session"
import { Schema } from "effect"
import { Profile, Tier } from "./config.js"
import { invalid } from "./error.js"

export function evidence(
  profile: Profile,
  event: Pick<SessionRequest, "system" | "messages"> & Partial<Pick<SessionContext, "tools">>,
  tiers: readonly Tier[],
  descriptions?: Readonly<Record<string, Schema.JsonObject>>,
) {
  const units: { start: number; end: number }[] = []
  const pending = new Set<string>()
  event.messages.forEach((message, index) => {
    if (!units.length || (message.role === "user" && pending.size === 0)) units.push({ start: index, end: index })
    units[units.length - 1].end = index
    message.content.forEach((part) => {
      if (part.type === "tool-call") pending.add(part.id)
      if (part.type === "tool-result") pending.delete(part.id)
    })
  })
  const selected = new Set<number>(units.length ? [units.length - 1] : [])
  const viewRevision = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ system: event.system, messages: event.messages, tools: event.tools }))
    .digest("hex")
  const build = () => ({
    schemaVersion: 1,
    policyVersion: "route-evidence-v1",
    viewRevision,
    system: event.system,
    tools: event.tools ?? {},
    userConstraints: event.messages.filter((message) => message.role === "user"),
    candidates: tiers.map((tier) => ({ tier, ...(descriptions?.[tier] ?? profile.tiers[tier]) })),
    history: units.flatMap((unit, index) =>
      selected.has(index) ? [{ ...unit, messages: event.messages.slice(unit.start, unit.end + 1) }] : [],
    ),
    omitted: units.filter((_, index) => !selected.has(index)),
  })
  const fits = () => {
    const bytes = Buffer.byteLength(JSON.stringify(build()), "utf8")
    // UTF-8 byte count is an intentionally conservative estimator, not a provider tokenizer claim.
    return bytes <= profile.evidence.maxBytes && bytes + profile.overheadTokens <= profile.evidence.maxTokens
  }
  if (profile.evidence.mode === "full") units.forEach((_, index) => selected.add(index))
  if (!fits()) throw invalid("Required decision evidence exceeds its explicit input budget")
  units
    .map((_, index) => index)
    .toReversed()
    .filter((index) => !selected.has(index))
    .forEach((index) => {
      selected.add(index)
      if (!fits()) selected.delete(index)
    })
  return {
    state: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(JSON.stringify(build())),
    omitted: build().omitted,
    bytes: Buffer.byteLength(JSON.stringify(build()), "utf8"),
  }
}
