import type { Plugin } from "@opencode/plugin"
import { Effect, Schema } from "effect"
import { invalid } from "./error.js"

type Event = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer A> ? A : never
export type Execution = { sessionID: string; sequence: number; controller: AbortController }
export type Work = {
  id: string
  sessionID: string
  phase: "preparing" | "pending" | "streaming" | "approval"
  controller: AbortController
  execution?: Execution
  deadline?: AbortController
  expired?: boolean
}

/** Process-local cancellation associations. These are not durable execution IDs or ownership claims. */
export class Lifecycle {
  readonly controller = new AbortController()
  readonly work = new Map<string, Work>()
  readonly executions = new Map<string, Execution>()
  readonly checkpoints = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  readonly drained = new Set<() => void>()
  readonly timers = new Set<Promise<void>>()

  constructor(
    readonly emit: (token: string) => Promise<void>,
    readonly ended: (execution: Execution) => void,
  ) {}

  start(sessionID: string, phase: Work["phase"], timeoutMs?: number) {
    if (this.controller.signal.aborted) throw invalid("Lifecycle event stream is unavailable; reload the plugin")
    const work: Work = { id: crypto.randomUUID(), sessionID, phase, controller: new AbortController() }
    this.work.set(work.id, work)
    work.controller.signal.addEventListener("abort", () => this.finish(work), { once: true })
    if (timeoutMs !== undefined) {
      work.deadline = new AbortController()
      const timer = Effect.runPromise(
        Effect.sleep(timeoutMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (work.controller.signal.aborted || work.phase === "streaming") return
              work.expired = true
              work.controller.abort()
            }),
          ),
        ),
        { signal: work.deadline.signal },
      )
        .catch(() => undefined)
        .finally(() => this.timers.delete(timer))
      this.timers.add(timer)
    }
    return work
  }

  consume(work: Work) {
    if (work.controller.signal.aborted)
      throw invalid("Self-driving binding was cancelled or expired before stream consumption")
    work.phase = "streaming"
    work.deadline?.abort()
  }

  async attach(work: Work, signal: AbortSignal) {
    if (!this.executions.has(work.sessionID))
      this.executions.set(work.sessionID, {
        sessionID: work.sessionID,
        sequence: -1,
        controller: new AbortController(),
      })
    await this.flush(signal)
    signal.throwIfAborted()
    const execution = this.executions.get(work.sessionID)
    if (!execution || execution.controller.signal.aborted)
      throw invalid("Session execution ended during request preparation")
    work.execution = execution
    return execution
  }

  async flush(signal = this.controller.signal) {
    this.controller.signal.throwIfAborted()
    signal.throwIfAborted()
    const token = crypto.randomUUID()
    const pending = Promise.withResolvers<void>()
    const abort = () =>
      pending.reject(
        invalid(
          this.controller.signal.aborted ? "Lifecycle event stream is unavailable" : "Lifecycle checkpoint cancelled",
        ),
      )
    this.checkpoints.set(token, pending)
    signal.addEventListener("abort", abort, { once: true })
    return Promise.all([this.emit(token), pending.promise])
      .then(() => undefined)
      .finally(() => {
        signal.removeEventListener("abort", abort)
        this.checkpoints.delete(token)
      })
  }

  observe(event: Event) {
    if (event.type === "rpc.opencode-self-driving.checkpoint") {
      const data = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(event.data)
      this.checkpoints.get(data.token)?.resolve()
      return
    }
    if (
      event.type !== "session.execution.started" &&
      event.type !== "session.execution.succeeded" &&
      event.type !== "session.execution.failed" &&
      event.type !== "session.execution.interrupted"
    )
      return
    const previous = this.executions.get(event.data.sessionID)
    if (!previous || event.durable.seq <= previous.sequence) return
    if (event.type === "session.execution.started") {
      this.end(previous)
      this.executions.set(event.data.sessionID, {
        sessionID: event.data.sessionID,
        sequence: event.durable.seq,
        controller: new AbortController(),
      })
      return
    }
    previous.sequence = event.durable.seq
    this.end(previous)
  }

  end(execution: Execution) {
    if (execution.controller.signal.aborted) return
    execution.controller.abort()
    Array.from(this.work.values())
      .filter((work) => work.execution === execution)
      .forEach((work) => work.controller.abort())
    this.ended(execution)
  }

  finish(work: Work) {
    work.deadline?.abort()
    this.work.delete(work.id)
    if (!this.work.size) this.drained.forEach((resolve) => resolve())
  }

  async drain(signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.work.size) return
    const pending = Promise.withResolvers<void>()
    const abort = () => pending.reject(invalid("Waiting for requests was cancelled"))
    this.drained.add(pending.resolve)
    signal.addEventListener("abort", abort, { once: true })
    return pending.promise.finally(() => {
      this.drained.delete(pending.resolve)
      signal.removeEventListener("abort", abort)
    })
  }

  close() {
    this.controller.abort()
    this.work.forEach((work) => work.controller.abort())
    this.executions.forEach((execution) => this.end(execution))
    this.executions.clear()
    this.checkpoints.forEach((checkpoint) => checkpoint.reject(invalid("Lifecycle event stream is unavailable")))
    this.checkpoints.clear()
  }
}
