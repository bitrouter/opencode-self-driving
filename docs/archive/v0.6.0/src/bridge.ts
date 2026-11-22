import type { AISDKHooks } from "@opencode/plugin/promise/aisdk"
import { AIError, InvalidRequestError, isRetryable, LLM, LLMClient, Message } from "@opencode/ai"
import { APICallError, isJSONObject } from "@ai-sdk/provider"
import type { ContentPart, LanguageModel, LLMEvent } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route/executor"
import { Effect, Layer, Schema, Stream } from "effect"
import { invalid } from "./error.js"

export type Dispatcher = NonNullable<AISDKHooks["language"]["language"]>
export type CallOptions = Parameters<Dispatcher["doStream"]>[0]
export type Part = Awaited<ReturnType<Dispatcher["doStream"]>>["stream"] extends ReadableStream<infer A> ? A : never

export function requestFromCall(model: LanguageModel, options: CallOptions) {
  if (options.responseFormat && options.responseFormat.type !== "text")
    throw invalid("Structured response formats are unsupported")
  if (options.tools?.some((tool) => tool.type !== "function")) throw invalid("Provider-executed tools are unsupported")
  return LLM.request({
    model,
    system: options.prompt.flatMap((message) =>
      message.role === "system" ? [{ type: "text" as const, text: message.content }] : [],
    ),
    messages: options.prompt.flatMap((message) => {
      if (message.role === "system") return []
      return [
        Message.make({
          role: message.role,
          content: message.content.map((part): ContentPart => {
            if (part.type === "text") return { type: "text", text: part.text, providerMetadata: part.providerOptions }
            if (part.type === "reasoning")
              return { type: "reasoning", text: part.text, providerMetadata: part.providerOptions }
            if (part.type === "tool-call") {
              if (part.providerExecuted) throw invalid("Provider-executed tool history is unsupported")
              return {
                type: "tool-call",
                id: part.toolCallId,
                name: part.toolName,
                input: part.input,
                providerMetadata: part.providerOptions,
              }
            }
            if (part.type === "tool-result") {
              const output = part.output
              if (output.type === "content") {
                // Failed native shell commands include separate text blocks for output and exit status.
                const value = output.value.map((item) => {
                  if (item.type !== "text")
                    throw invalid("Multimodal and denied tool results are unsupported by this binding")
                  return { type: "text" as const, text: item.text }
                })
                return {
                  type: "tool-result",
                  id: part.toolCallId,
                  name: part.toolName,
                  result: { type: "content", value },
                  providerMetadata: part.providerOptions,
                }
              }
              if (
                output.type !== "text" &&
                output.type !== "json" &&
                output.type !== "error-text" &&
                output.type !== "error-json"
              )
                throw invalid("Multimodal and denied tool results are unsupported by this binding")
              return {
                type: "tool-result",
                id: part.toolCallId,
                name: part.toolName,
                result: {
                  type: output.type.startsWith("error") ? "error" : output.type === "text" ? "text" : "json",
                  value: output.value,
                },
                providerMetadata: part.providerOptions,
              }
            }
            throw invalid("This binding supports text, reasoning and local tool history only")
          }),
          providerMetadata: message.providerOptions,
        }),
      ]
    }),
    tools: options.tools?.flatMap((tool) =>
      tool.type === "function"
        ? [{ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }]
        : [],
    ),
    toolChoice:
      options.toolChoice?.type === "tool" ? { type: "tool", name: options.toolChoice.toolName } : options.toolChoice,
    generation: {
      maxTokens: options.maxOutputTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      stop: options.stopSequences,
    },
  })
}

export const aborted = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    const stop = () => resume(Effect.fail(new DOMException("Self-driving request cancelled", "AbortError")))
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", stop))
  })

// Zero buffering keeps ownership with the pending binding until Core actually reads the stream.
export function readable(stream: Stream.Stream<Part, Error>, started: () => void, settled: () => void) {
  let reader: ReadableStreamDefaultReader<Part> | undefined
  return new ReadableStream<Part>(
    {
      async pull(controller) {
        if (!reader) {
          started()
          reader = Stream.toReadableStream(stream).getReader()
        }
        const result = await reader.read()
        if (result.done) return controller.close()
        controller.enqueue(result.value)
      },
      async cancel(reason) {
        settled()
        await reader?.cancel(reason).catch(() => undefined)
      },
    },
    { highWaterMark: 0 },
  )
}

export function response(
  request: ReturnType<typeof requestFromCall>,
  signal: AbortSignal,
  finish: (usage?: Extract<LLMEvent, { type: "finish" }>["usage"]) => void,
  budget: { input: number; context: number; output: number; overhead: number },
) {
  const Wire = Schema.Struct({
    model: Schema.String,
    max_tokens: Schema.optional(Schema.Number),
    max_completion_tokens: Schema.optional(Schema.Number),
    models: Schema.optional(Schema.Unknown),
  })
  const executor = RequestExecutor.middleware((wire, next) =>
    Effect.gen(function* () {
      const reject = () =>
        new AIError({
          reason: new InvalidRequestError({
            message: "Final serialized generation request violates its bound identity or capacity",
          }),
        })
      if (wire.body._tag !== "Uint8Array") return yield* Effect.fail(reject())
      const bytes = wire.body.body.byteLength + budget.overhead
      if (bytes > budget.input || bytes + budget.output > budget.context) return yield* Effect.fail(reject())
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Wire))(
        new TextDecoder().decode(wire.body.body),
      ).pipe(Effect.mapError(reject))
      const outputs = [decoded.max_tokens, decoded.max_completion_tokens].filter((value) => value !== undefined)
      if (
        decoded.model !== request.model.id ||
        decoded.models !== undefined ||
        !outputs.length ||
        outputs.some((value) => value !== budget.output)
      )
        return yield* Effect.fail(reject())
      return yield* next(wire)
    }),
  )
  const stream = LLM.stream(request).pipe(
    Stream.provide(LLMClient.layer.pipe(Layer.provide(executor))),
    Stream.interruptWhen(aborted(signal)),
    Stream.mapEffect((event) =>
      Effect.try({
        try: () => {
          if (event.type === "finish") finish(event.usage)
          return parts(event)
        },
        catch: nativeError,
      }),
    ),
    Stream.flatMap(Stream.fromIterable),
    Stream.mapError(nativeError),
  )
  return stream
}

export function nativeError(cause: unknown) {
  if (APICallError.isInstance(cause)) return cause
  if (!(cause instanceof AIError)) return invalid("Native generation failed")
  const overflow = cause.reason._tag === "InvalidRequest" && cause.reason.classification === "context-overflow"
  return new APICallError({
    message: overflow ? "Physical model context window exceeded" : `Native generation failed (${cause.reason._tag})`,
    url: "self-driving://request",
    requestBodyValues: undefined,
    statusCode:
      cause.reason.http?.status ??
      (cause.reason._tag === "RateLimit" ? 429 : cause.reason._tag === "Authentication" ? 401 : 400),
    isRetryable: isRetryable(cause),
    responseBody: overflow
      ? JSON.stringify({ error: { code: "context_length_exceeded", message: "Context window exceeded" } })
      : undefined,
  })
}

function parts(event: LLMEvent): Part[] {
  const providerMetadata =
    "providerMetadata" in event && event.providerMetadata
      ? Object.fromEntries(
          Object.entries(event.providerMetadata).map(([key, value]) => {
            if (!isJSONObject(value)) throw invalid("Native provider metadata is not portable JSON")
            return [key, value]
          }),
        )
      : undefined
  switch (event.type) {
    case "step-start":
      return [{ type: "stream-start", warnings: [] }]
    case "text-start":
      return [{ type: "text-start", id: event.id, providerMetadata }]
    case "text-delta":
      return [{ type: "text-delta", id: event.id, delta: event.text, providerMetadata }]
    case "text-end":
      return [{ type: "text-end", id: event.id, providerMetadata }]
    case "reasoning-start":
      return [{ type: "reasoning-start", id: event.id, providerMetadata }]
    case "reasoning-delta":
      return [{ type: "reasoning-delta", id: event.id, delta: event.text, providerMetadata }]
    case "reasoning-end":
      return [{ type: "reasoning-end", id: event.id, providerMetadata }]
    case "tool-input-start":
      return [{ type: "tool-input-start", id: event.id, toolName: event.name }]
    case "tool-input-delta":
      return [{ type: "tool-input-delta", id: event.id, delta: event.text }]
    case "tool-input-end":
      return [{ type: "tool-input-end", id: event.id }]
    case "tool-call":
      return [
        {
          type: "tool-call",
          toolCallId: event.id,
          toolName: event.name,
          input: JSON.stringify(event.input),
          providerMetadata,
        },
      ]
    case "finish":
      return [
        {
          type: "finish",
          finishReason: {
            unified: event.reason.normalized === "unknown" ? "other" : event.reason.normalized,
            raw: event.reason.raw,
          },
          usage: {
            inputTokens: {
              total: event.usage?.inputTokens,
              noCache: event.usage?.nonCachedInputTokens,
              cacheRead: event.usage?.cacheReadInputTokens,
              cacheWrite: event.usage?.cacheWriteInputTokens,
            },
            outputTokens: {
              total: event.usage?.outputTokens,
              text: event.usage?.visibleOutputTokens,
              reasoning: event.usage?.reasoningTokens,
            },
          },
        },
      ]
    case "step-finish":
      return []
    default:
      throw invalid("Native provider returned an unsupported stream event")
  }
}
