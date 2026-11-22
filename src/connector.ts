import { timingSafeEqual } from "node:crypto"
import { discover, digest } from "./catalog.js"
import type { Catalog, Host } from "./catalog.js"
import { plan } from "./plan.js"
import type { Options } from "./options.js"
import { launch } from "./process.js"
import type { Generation, Launch } from "./process.js"

interface Lease { generation: Generation; active: number; retired: boolean; closing?: Promise<void> }
export interface Status {
  state: "ready" | "unavailable" | "closed"
  routing?: "bootstrap" | "published-policy"
  revision?: string
  configPath?: string
  sources: { id: string; kind: string; target: string }[]
  excluded: Catalog["issues"]
  error?: string
}

/** A stable authenticated HTTP ingress, not an LLM adapter: all routing/wire conversion belongs to BitRouter. */
export class Connector {
  readonly token = crypto.randomUUID() + crypto.randomUUID()
  readonly controller = new AbortController()
  readonly server: ReturnType<typeof Bun.serve>
  private current?: Lease
  private readonly leases = new Set<Lease>()
  private pending?: Promise<void>
  private previousDefault?: string
  private state: Status = { state: "unavailable", sources: [], excluded: [] }
  private published = ""

  constructor(
    readonly host: Host,
    readonly options: Options,
    readonly changed: () => Promise<void>,
    readonly start: Launch = launch,
  ) {
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024,
      fetch: (request) => this.handle(request),
    })
  }
  get url() { return this.server.url.origin }
  get activePlan() { return this.state.state === "ready" ? this.current?.generation.plan : undefined }
  prefer(source: string) { this.previousDefault = source }
  status(): Status { return structuredClone(this.state) }

  sync(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.reject(new Error("Connector closed"))
    if (this.pending) return this.pending
    this.pending = this.update().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async update() {
    let phase = "discovering sources"
    try {
      const catalog = await discover(this.host, this.url)
      this.previousDefault = catalog.defaultSource ?? this.previousDefault
      catalog.defaultSource ??= this.previousDefault
      this.state = { ...this.state, excluded: catalog.issues }
      phase = "generating policy"
      const next = await plan(catalog, this.options.policyFile, this.options.decision)
      this.controller.signal.throwIfAborted()
      if (!this.current || this.current.generation.plan.revision !== next.revision || !this.current.generation.alive()) {
        phase = "starting BitRouter"
        const generation = await this.start(next, this.options, this.controller.signal)
        if (this.controller.signal.aborted) {
          await generation.close()
          throw new Error("Connector closed")
        }
        const previous = this.current
        this.current = { generation, active: 0, retired: false }
        this.leases.add(this.current)
        if (previous) {
          previous.retired = true
          void this.release(previous).catch(() => console.error("BitRouter retired process cleanup failed"))
        }
      }
      this.state = {
        state: "ready", routing: next.routing, revision: next.revision,
        configPath: `${this.current.generation.directory}/bitrouter.yaml`,
        sources: next.catalog.sources.map((source) => ({ id: source.id, kind: source.kind, target: `${source.provider}:${source.model.id}` })),
        excluded: next.catalog.issues,
      }
    } catch {
      this.state = {
        state: this.controller.signal.aborted ? "closed" : "unavailable",
        sources: [], excluded: this.state.excluded,
        error: `BitRouter unavailable while ${phase}; check source adapters, active credentials, policy and executable`,
      }
    }
    // Publish only catalog-affecting changes, preventing provider.updated -> reload loops.
    const publication = digest({
      ready: this.state.state === "ready",
      limits: this.activePlan?.limits,
      input: this.activePlan?.catalog.sources.map((source) => source.model.capabilities.input),
    })
    if (!this.controller.signal.aborted && publication !== this.published) {
      this.published = publication
      await this.changed()
    }
  }

  private async release(lease: Lease) {
    if (!lease.retired || lease.active !== 0) return
    lease.closing ??= lease.generation.close().finally(() => this.leases.delete(lease))
    await lease.closing
  }
  private authorized(request: Request) {
    const value = Buffer.from(request.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${this.token}`)
    return value.length === expected.length && timingSafeEqual(value, expected)
  }
  private async handle(request: Request): Promise<Response> {
    if (!this.authorized(request)) return new Response(null, { status: 401 })
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/v1/models")
      return Response.json({ object: "list", data: this.activePlan ? [{ id: "bitrouter/auto", object: "model", owned_by: "bitrouter" }] : [] })
    if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response(null, { status: 404 })
    try {
      // Do not snapshot credentials or a generation while a client is still uploading.
      const body = await request.arrayBuffer()
      const parsed = JSON.parse(new TextDecoder().decode(body))
      if (parsed?.model !== "bitrouter/auto") return new Response(null, { status: 400 })
      request.signal.throwIfAborted()
      await this.sync()
      const lease = this.current
      if (!this.activePlan || !lease || !lease.generation.alive()) throw new Error("Router unavailable")
      lease.active++
      const signal = AbortSignal.any([request.signal, this.controller.signal])
      try {
        const response = await fetch(`${lease.generation.url}${path}`, {
          method: "POST", body, headers: {
            "content-type": "application/json", authorization: `Bearer ${lease.generation.token}`,
          }, signal, redirect: "error",
        })
        if (!response.body) {
          lease.active--
          await this.release(lease)
          return new Response(null, { status: response.status })
        }
        const reader = response.body.getReader()
        let finished = false
        const finish = async () => {
          if (finished) return
          finished = true
          lease.active--
          await this.release(lease)
        }
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await reader.read()
              if (part.done) { controller.close(); await finish() }
              else controller.enqueue(part.value)
            } catch { controller.error(new Error("BitRouter response interrupted")); await finish() }
          },
          async cancel(reason) { try { await reader.cancel(reason) } finally { await finish() } },
        }), { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } })
      } catch {
        lease.active--
        await this.release(lease)
        throw new Error("BitRouter transport failed")
      }
    } catch {
      return Response.json({ error: { type: "bitrouter_unavailable", message: "BitRouter unavailable; original OpenCode models remain selectable" } }, { status: 503 })
    }
  }
  async close() {
    this.controller.abort()
    this.state = { state: "closed", sources: [], excluded: [] }
    await this.server.stop(true)
    await this.pending?.catch(() => undefined)
    await Promise.all([...this.leases].map(async (lease) => {
      lease.retired = true
      lease.closing ??= lease.generation.close()
      await lease.closing
    }))
    this.leases.clear()
  }
}
