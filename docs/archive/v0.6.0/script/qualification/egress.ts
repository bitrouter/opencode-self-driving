import { Schema } from "effect"
import type { Plan } from "./plan"

const Body = Schema.Struct({
  model: Schema.String,
  max_tokens: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number),
})
export type Target = { kind: "decision" | "generation"; url: string; models: Set<string> }
export type RequestRecord = {
  target: number
  kind: Target["kind"]
  model: string
  inputBytes: number
  outputLimit?: number
  status?: number
  responseBytes: number
  elapsedMs: number
  outcome: "pending" | "complete" | "failed" | "cancelled"
}

/** A development-only transparent relay. All native factories still serialize and execute their requests. */
export function egress(limits: Plan["limits"], targets: Target[], controller: AbortController, execute: boolean) {
  const requests: RequestRecord[] = []
  const state = { inputBytes: 0, responseBytes: 0, blocked: 0, reason: undefined as string | undefined }
  const block = (reason: string) => {
    state.blocked++
    state.reason = reason
    controller.abort()
    return Response.json(
      { error: { message: "Qualification request blocked by explicit run limits" } },
      { status: 400 },
    )
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const match = /^\/(\d+)(\/.*)$/.exec(path)
      const target = match ? targets[Number(match[1])] : undefined
      const suffix = match?.[2]
      if (!execute || controller.signal.aborted || !target || !suffix || request.method !== "POST")
        return block("admission")
      const bytes = new Uint8Array(await request.arrayBuffer())
      const body = Schema.decodeUnknownOption(Schema.fromJsonString(Body))(new TextDecoder().decode(bytes))
      if (body._tag === "None" || !target.models.has(body.value.model)) return block("model-identity")
      const outputs = [body.value.max_tokens, body.value.max_completion_tokens].filter((value) => value !== undefined)
      if (
        target.kind === "generation" &&
        (!outputs.length ||
          outputs.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > limits.maxOutputTokens))
      )
        return block("output-budget")
      // Title and foreground calls may arrive concurrently; check after the last await, before reserving.
      if (requests.length >= limits.maxRequests) return block("request-count")
      if (state.inputBytes + bytes.byteLength > limits.maxInputBytes) return block("input-bytes")
      state.inputBytes += bytes.byteLength
      const record: RequestRecord = {
        target: Number(match?.[1]),
        kind: target.kind,
        model: body.value.model,
        inputBytes: bytes.byteLength,
        ...(outputs.length ? { outputLimit: outputs[0] } : {}),
        responseBytes: 0,
        elapsedMs: 0,
        outcome: "pending",
      }
      requests.push(record)
      const started = performance.now()
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      const signal = AbortSignal.any([request.signal, controller.signal])
      return fetch(`${target.url.replace(/\/$/, "")}${suffix}`, {
        method: "POST",
        headers,
        body: bytes,
        signal,
        redirect: "manual",
      })
        .then((response) => {
          record.status = response.status
          if (response.status >= 300 && response.status < 400) {
            response.body?.cancel().catch(() => undefined)
            record.outcome = "failed"
            return block("redirect")
          }
          const reader = response.body?.getReader()
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(stream) {
                const chunk = await reader?.read().catch(() => {
                  record.outcome = signal.aborted ? "cancelled" : "failed"
                  record.elapsedMs = performance.now() - started
                  throw new Error("Qualification upstream stream failed")
                })
                if (!chunk || chunk.done) {
                  record.outcome = response.ok ? "complete" : "failed"
                  record.elapsedMs = performance.now() - started
                  return stream.close()
                }
                state.responseBytes += chunk.value.byteLength
                record.responseBytes += chunk.value.byteLength
                if (state.responseBytes > limits.maxResponseBytes) {
                  record.outcome = "cancelled"
                  record.elapsedMs = performance.now() - started
                  block("response-bytes")
                  await reader?.cancel().catch(() => undefined)
                  return stream.close()
                }
                stream.enqueue(chunk.value)
              },
              async cancel() {
                record.outcome = "cancelled"
                record.elapsedMs = performance.now() - started
                await reader?.cancel().catch(() => undefined)
              },
            }),
            {
              status: response.status,
              headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
            },
          )
        })
        .catch(() => {
          record.outcome = signal.aborted ? "cancelled" : "failed"
          record.elapsedMs = performance.now() - started
          return Response.json({ error: { message: "Qualification upstream request failed" } }, { status: 502 })
        })
    },
  })
  return {
    requests,
    state,
    url(index: number) {
      return `${server.url.href.replace(/\/$/, "")}/${index}`
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}
