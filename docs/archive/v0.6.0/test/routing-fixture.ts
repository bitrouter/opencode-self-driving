import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { Schema } from "effect"
import { Profile, Published, TIERS } from "../src/config"
import { Status } from "../src/rpc"
import { host } from "./fixture"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const Wire = Schema.StructWithRest(Schema.Struct({ model: Schema.String }), [Schema.Record(Schema.String, Schema.Json)])
export type Wire = typeof Wire.Type

export function endpoint(
  input: {
    choice?: string
    answer?(body: Wire, request: Request): Response | Promise<Response>
    generation?(body: Wire, request: Request): Response | Promise<Response>
  } = {},
) {
  const calls: { path: string; authorization: string | null; body: Wire }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(Wire)(await request.json())
      const path = new URL(request.url).pathname
      calls.push({ path, authorization: request.headers.get("authorization"), body })
      if (path.endsWith("/systemone") || path.endsWith("/evaluate")) {
        if (input.answer) return input.answer(body, request)
        return decision(body, {}, input.choice, path.endsWith("/evaluate"))
      }
      if (input.generation) return input.generation(body, request)
      return chat(body.model, { content: `physical:${body.model}` })
    },
  })
  return {
    url: server.url.href.replace(/\/$/, ""),
    calls,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

export function decision(body: Wire, probabilities: Record<string, number> = {}, choice = "medium", gateway = false) {
  const questions = Schema.decodeUnknownSync(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.String,
        criteria: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
      }),
    ),
  )(body.questions)
  return Response.json({
    model: body.model,
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === "choice"
          ? {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria ?? {}).map((key) => [key, key === choice ? 1 : 0]),
              ),
            }
          : question.type === "noul"
            ? { type: "noul", noul: probabilities[id] ?? 0 }
            : { type: "boolean", probability: probabilities[id] ?? 0 },
      ]),
    ),
    usage: gateway ? { inputTokens: 11, outputTokens: 1 } : { input_tokens: 11, output_tokens: 1 },
  })
}

export function chat(model: string, delta: Record<string, unknown>, finish = "stop") {
  const chunks = [
    {
      id: "fixture-completion",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
    },
    {
      id: "fixture-completion",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 },
    },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

export function profile(url: string): Profile {
  return {
    schemaVersion: 1,
    name: "loopback-verification",
    backends: {
      coding: {
        service: "openai-chat",
        providerID: "fixture-openai",
        auth: { type: "env", name: "SELF_DRIVING_TEST_KEY" },
      },
    },
    decision: {
      service: "typesafe-ai",
      model: "fixture-jev",
      allowedResponseModels: ["fixture-jev"],
      auth: { type: "env", name: "SELF_DRIVING_TEST_KEY" },
      baseURL: url,
      maxInputBytes: 500_000,
      maxInputTokens: 500_000,
    },
    tiers: {
      low: { backend: "coding", model: "low", effort: "none" },
      medium: { backend: "coding", model: "medium", effort: "low" },
      high: { backend: "coding", model: "high", effort: "medium" },
      xhigh: { backend: "coding", model: "xhigh", effort: "high" },
      max: { backend: "coding", model: "max", effort: "high" },
    },
    auxiliary: {
      title: { backend: "coding", model: "low" },
      compaction: { backend: "coding", model: "max" },
      generate: { backend: "coding", model: "max" },
    },
    outputTokens: 1_024,
    overheadTokens: 1_024,
    preparationTimeoutMs: 5_000,
    evidence: { mode: "bounded", maxBytes: 400_000, maxTokens: 400_000 },
  }
}

export function catalog(
  url: string,
  service: "openai" | "openrouter" = "openai",
  limits = [128_000, 128_000, 256_000, 256_000, 1_000_000],
) {
  return Plugin.define({
    id: "self-driving-loopback-catalog",
    async setup(ctx) {
      await ctx.provider.transform((editor) =>
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make("fixture-openai")),
            canonical: Provider.ID.make(service),
            integrationID: Integration.ID.make("openai"),
            activation: "enabled",
            package: `@opencode/ai/providers/${service}`,
            settings: { baseURL: url },
          },
          models: TIERS.map((tier, index) => ({
            ...Model.Info.default(Provider.ID.make("fixture-openai"), Model.ID.make(tier)),
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: limits[index], output: 8_192 },
            variants: ["none", "low", "medium", "high"].map((effort) => ({
              id: Model.VariantID.make(effort),
              settings: service === "openai" ? { reasoningEffort: effort } : { reasoning: { effort } },
            })),
          })),
        }),
      )
    },
  })
}

export async function routing(
  target: string,
  url: string,
  input: {
    plugins?: readonly Plugin.Plugin[]
    config?: Record<string, unknown>
    service?: "openai" | "openrouter"
    limits?: number[]
    trailing?: string[]
    instructions?: Record<string, string>
  } = {},
) {
  const proof = await host(target, undefined, {
    ...input,
    plugins: [catalog(url, input.service, input.limits), ...(input.plugins ?? [])],
  })
  type Input = Exclude<Parameters<typeof proof.client.rpc.call>[0]["input"], undefined>
  const mutable = (value: Schema.Json): Input => {
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map((item: Schema.Json) => mutable(item))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutable(item)]))
  }
  const rpc = async (method: string, value: Schema.Json = {}, directory = proof.directory) =>
    (
      await proof.client.rpc.call({
        rpcID: "opencode-self-driving",
        method,
        input: mutable(value),
        location: { directory },
      })
    ).output
  return {
    ...proof,
    rpc,
    async publish(configuration = profile(url)) {
      await rpc("draft", { profile: Schema.decodeUnknownSync(Schema.Json)(configuration) })
      return Schema.decodeUnknownSync(Published)(await rpc("publish"))
    },
    async session() {
      const session = await proof.client.sessions.create({
        title: "Loopback verification",
        location: { directory: proof.directory },
        model: { providerID: "fixture-openai", id: "low", variant: "high" },
      })
      await rpc("enable", { sessionID: session.id })
      return session
    },
    async inspect(sessionID?: string) {
      return Schema.decodeUnknownSync(Status)(await rpc("status", sessionID ? { sessionID } : {}))
    },
    async prompt(sessionID: string, text: string) {
      await proof.client.sessions.prompt({ sessionID, text })
      await proof.client.sessions.wait({ sessionID })
      return Array.fromAsync(proof.client.sessions.log({ sessionID }))
    },
  }
}

export async function laterPlugin(hook: string) {
  const directory = await mkdtemp(join(tmpdir(), "self-driving-later-"))
  await Bun.write(
    join(directory, "server.js"),
    `import { Plugin } from "@opencode/plugin"
export default Plugin.define({ id: "later-public-plugin", async setup(ctx) { ${hook} } })`,
  )
  return {
    directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
