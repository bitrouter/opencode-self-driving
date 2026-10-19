import type { Plugin } from "@opencode/plugin"
import { LLM } from "@opencode/ai"
import type { LanguageModel } from "@opencode/ai"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Auth, Pair, Profile, TIERS } from "./config.js"
import { invalid } from "./error.js"

export async function credential(ctx: Plugin.Context, auth: Auth) {
  if (auth.type === "env") {
    const key = process.env[auth.name]
    if (!key) throw invalid("Configured credential environment variable is unavailable")
    return key
  }
  const connection = await ctx.integration.connection.active(auth.integrationID)
  if (!connection) throw invalid("Configured integration has no active connection")
  if (connection.type === "credential" && connection.method !== "key")
    throw invalid("This binding requires a key connection; OAuth and external credentials are unsupported")
  const value = await ctx.integration.connection.resolve(connection)
  if (value?.type !== "key" || !value.key)
    throw invalid("This binding requires a key connection; OAuth and external credentials are unsupported")
  return value.key
}

export async function inventory(ctx: Plugin.Context) {
  const [models, providers] = await Promise.all([ctx.model.list(), ctx.provider.list()])
  return { models: models.data, providers: providers.data }
}
export type Inventory = Awaited<ReturnType<typeof inventory>>

export function resolvePair(profile: Profile, pair: Pair, current: Inventory) {
  const backend = profile.backends[pair.backend]
  const provider = current.providers.find((provider) => provider.id === backend.providerID)
  const model = current.models.find(
    (model) => model.providerID === backend.providerID && model.id === pair.model && model.enabled,
  )
  if (!provider || !model) throw invalid("Configured physical model is unavailable")
  const expected = backend.service === "openai-chat" ? "openai" : "openrouter"
  if ((provider.canonical ?? provider.id) !== expected)
    throw invalid("Configured provider does not match the selected native binding")
  if (backend.auth.type === "integration" && provider.integrationID !== backend.auth.integrationID)
    throw invalid("Backend credential integration does not match the provider")
  const variant = pair.effort === undefined ? undefined : model.variants.find((variant) => variant.id === pair.effort)
  if (pair.effort !== undefined && !variant) throw invalid("Configured effort is not an available model variant")
  if (
    !model.capabilities.tools ||
    !model.capabilities.input.includes("text") ||
    !model.capabilities.output.includes("text")
  )
    throw invalid("Physical model must support text input, text output and tools")
  if (
    model.limit.context <= 0 ||
    model.limit.output < profile.outputTokens ||
    (model.limit.input ?? model.limit.context) <= 0
  )
    throw invalid("Physical model has unknown or insufficient capacity")
  const settings = { ...provider.settings, ...model.settings, ...variant?.settings }
  if (settings.transport === "websocket" || settings.compaction?.type === "native")
    throw invalid("This binding supports HTTP generation and native summary compaction only")
  if (settings.encoding !== undefined && settings.encoding !== "none")
    throw invalid("This binding requires uncompressed JSON requests")
  const body = { ...provider.body, ...model.body, ...variant?.body }
  if (
    settings.models !== undefined ||
    Object.keys(body).some((key) =>
      [
        "model",
        "models",
        "messages",
        "tools",
        "max_tokens",
        "max_completion_tokens",
        "reasoning",
        "reasoning_effort",
      ].includes(key),
    )
  )
    throw invalid("Body overrides of model, input, tools, output or reasoning are unsupported")
  const packageName = model.package ?? provider.package
  const supported =
    backend.service === "openai-chat"
      ? ["@opencode/ai/providers/openai", "@opencode/ai/providers/openai/chat", "aisdk:@ai-sdk/openai"]
      : ["@opencode/ai/providers/openrouter", "aisdk:@openrouter/ai-sdk-provider"]
  if (!supported.includes(packageName))
    throw invalid("Physical provider package has not been qualified for this binding")
  return {
    pair,
    backend,
    model,
    settings,
    headers: { ...provider.headers, ...model.headers, ...variant?.headers },
    body,
    room:
      Math.min(model.limit.input ?? model.limit.context, model.limit.context - profile.outputTokens) -
      profile.overheadTokens,
  }
}
export type Resolved = ReturnType<typeof resolvePair>

export async function language(ctx: Plugin.Context, pair: Resolved): Promise<LanguageModel> {
  const settings = {
    ...pair.settings,
    apiKey: await credential(ctx, pair.backend.auth),
    headers: pair.headers,
    body: pair.body,
  }
  if (pair.backend.service === "openai-chat") {
    const { chatModel } = await import("@opencode/ai/providers/openai")
    return chatModel(pair.model.modelID, settings)
  }
  const { model } = await import("@opencode/ai/providers/openrouter")
  return model(pair.model.modelID, settings)
}

export function capacity(profile: Profile, current: Inventory) {
  const pairs = TIERS.map((tier) => resolvePair(profile, profile.tiers[tier], current))
  const auxiliary = Object.values(profile.auxiliary).map((pair) => resolvePair(profile, pair, current))
  const witness = pairs.reduce((best, pair) => (pair.room > best.room ? pair : best))
  const compaction = resolvePair(profile, profile.auxiliary.compaction, current)
  if (
    pairs.some((pair) => pair.room <= 0) ||
    auxiliary.some((pair) => pair.room <= 0) ||
    compaction.room < witness.room
  )
    throw invalid("All pairs need usable joint capacity, and compaction must cover the advertised input range")
  const snapshot = [...pairs, ...auxiliary].map((pair) => ({
    backend: pair.pair.backend,
    model: pair.model.modelID,
    effort: pair.pair.effort,
    limit: pair.model.limit,
    capabilities: pair.model.capabilities,
  }))
  return {
    capacityRevision: new Bun.CryptoHasher("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    limit: { input: witness.room, context: witness.room + profile.outputTokens, output: profile.outputTokens },
  }
}

export function request(
  model: LanguageModel,
  event: Pick<SessionContext, "system" | "messages" | "tools" | "options">,
  outputTokens: number,
) {
  if (
    event.messages.some((message) =>
      message.content.some((part) => !["text", "reasoning", "tool-call", "tool-result"].includes(part.type)),
    )
  )
    throw invalid("This binding supports text and local tool history only")
  return LLM.request({
    model,
    system: event.system,
    messages: event.messages,
    tools: Object.entries(event.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.input,
    })),
    generation: {
      maxTokens: outputTokens,
      temperature: event.options.temperature,
      topP: event.options.topP,
      topK: event.options.topK,
      frequencyPenalty: event.options.frequencyPenalty,
      presencePenalty: event.options.presencePenalty,
      seed: event.options.seed,
      stop: event.options.stop,
    },
  })
}
