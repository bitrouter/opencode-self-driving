import { Model, Plugin, Provider } from "@opencode/plugin"
import type { SessionContext, SessionRequest } from "@opencode/plugin/promise/session"
import { Effect, Schema, Stream } from "effect"
import { version } from "../package.json"
import { ApprovalResult, Contract, Route, Status } from "./rpc.js"
import { decodeProfile, Policies, Published, TIERS } from "./config.js"
import { capacity, credential, inventory, language, request, resolvePair } from "./native.js"
import { decide } from "./decisions.js"
import { invalid } from "./error.js"
import { aborted, nativeError, readable, requestFromCall, response } from "./bridge.js"
import type { Dispatcher } from "./bridge.js"
import { APICallError } from "@ai-sdk/provider"
import { revision, selectResources } from "./resources.js"
import { approve } from "./approval.js"
import type { ApprovalView, Call } from "./approval.js"
import { Lifecycle } from "./lifecycle.js"
import type { Execution, Work } from "./lifecycle.js"

const providerID = Provider.ID.make("self-driving")
const auto = Model.Ref.make({ providerID, id: Model.ID.make("auto") })
const json = Schema.decodeUnknownSync(Schema.Json)
const StoredPolicies = Schema.Struct({ ...Policies.fields, revision: Schema.String })

export default Plugin.define({
  id: "opencode-self-driving",
  async setup(ctx) {
    if (Object.keys(ctx.options).length > 0)
      throw new Error("Use the self-driving configuration RPC instead of plugin options")
    const stored = await ctx.storage.get("published")
    const state = {
      published: stored === undefined ? undefined : Schema.decodeUnknownSync(Published)(stored),
      mutation: Promise.resolve(),
      applying: undefined as Set<Execution> | undefined,
    }
    const latest = new Map<string, Route>()
    const failures = new Map<string, { requestID: string; kind: string; revision: string; message: string }>()
    const pending = new Map<string, { published: Published; route: Route; work: Work; execution?: Execution }>()
    const views = new Map<string, ApprovalView & { execution: Execution; assistantMessageID?: string }>()
    const calls = new Map<string, Call & { execution?: Execution }>()
    const approvals = new Map<string, ApprovalResult>()
    const attempts = new Map<string, string>()
    const lifecycle = new Lifecycle(
      (token) => registration.events.emit("checkpoint", { token }),
      (execution) => {
        if (views.get(execution.sessionID)?.execution === execution) views.delete(execution.sessionID)
        Array.from(calls)
          .filter(([, call]) => call.execution === execution)
          .forEach(([key]) => calls.delete(key))
      },
    )
    const start = (sessionID: string, phase: Work["phase"], timeoutMs?: number) => {
      const work = lifecycle.start(sessionID, phase, timeoutMs)
      work.controller.signal.addEventListener(
        "abort",
        () => {
          const bound = pending.get(work.id)
          if (work.expired && bound && attempts.get(`${sessionID}:${bound.route.kind}`) === work.id)
            failures.set(sessionID, {
              requestID: work.id,
              kind: bound.route.kind,
              revision: bound.published.revision,
              message: "Request binding handoff exceeded its preparation deadline",
            })
          pending.delete(work.id)
        },
        { once: true },
      )
      return work
    }
    const policies = async (sessionID: string): Promise<Policies> => {
      const stored = await ctx.storage.get(`policies:${sessionID}`)
      const value = stored ? Schema.decodeUnknownSync(StoredPolicies)(stored) : undefined
      if (value?.revision === state.published?.revision && value) return value
      return { sessionID, contextSelection: "inherit", approval: "off" }
    }
    const change = <A>(fn: () => Promise<A>) => {
      const next = state.mutation.then(() => {
        lifecycle.controller.signal.throwIfAborted()
        return fn()
      })
      state.mutation = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }
    const wait = (sessionID: string, signal: AbortSignal) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => ctx.session.wait({ sessionID }),
          catch: () => invalid("Unable to wait for the Session"),
        }),
        { signal },
      )
    const waitSessions = async (signal: AbortSignal, cursor?: string): Promise<void> => {
      signal.throwIfAborted()
      const page = await ctx.session.list({ directory: ctx.location.directory, ...(cursor ? { cursor } : {}) })
      await Promise.all(
        page.data
          .filter(
            (session) =>
              session.location.directory === ctx.location.directory &&
              (session.model?.providerID === providerID || lifecycle.executions.has(session.id)),
          )
          .map((session) => wait(session.id, signal)),
      )
      if (page.cursor.next) await waitSessions(signal, page.cursor.next)
    }
    const verifyCatalog = async (published?: Published) => {
      const model = (await ctx.model.list()).data.find(
        (model) => model.providerID === providerID && model.id === "auto",
      )
      if (!published && !model) return
      if (
        published &&
        model?.enabled &&
        model.limit.context === published.limit.context &&
        model.limit.input === published.limit.input &&
        model.limit.output === published.limit.output
      )
        return
      throw invalid("The public composite model catalog does not match the published profile")
    }
    const status = async (sessionID?: string, signal = lifecycle.controller.signal) => {
      if (!lifecycle.controller.signal.aborted) await lifecycle.flush(signal).catch(() => undefined)
      signal.throwIfAborted()
      const session = sessionID ? await ctx.session.get({ sessionID }) : undefined
      const previous = sessionID ? await ctx.storage.get(`previous:${sessionID}`) : undefined
      const modes = sessionID ? await policies(sessionID) : undefined
      return Schema.decodeUnknownSync(Schema.fromJsonString(Status))(
        JSON.stringify({
          version,
          state: state.published ? "configured" : "unconfigured",
          enabled: session?.model?.providerID === providerID && session.model.id === "auto",
          contextSelection: modes?.contextSelection ?? "inherit",
          approval: modes?.approval ?? "off",
          ...(sessionID && approvals.has(sessionID) ? { lastApproval: approvals.get(sessionID) } : {}),
          ...(sessionID
            ? {
                lifecycle: {
                  available: !lifecycle.controller.signal.aborted,
                  applying: !!state.applying,
                  ...Object.fromEntries(
                    ["preparing", "pending", "streaming", "approval"].map((phase) => [
                      phase,
                      Array.from(lifecycle.work.values()).filter(
                        (work) => work.sessionID === sessionID && work.phase === phase,
                      ).length,
                    ]),
                  ),
                  views: views.has(sessionID) ? 1 : 0,
                  calls: Array.from(calls.keys()).filter((key) => key.startsWith(`${sessionID}:`)).length,
                  checkpoints: lifecycle.checkpoints.size,
                  deadlines: lifecycle.timers.size,
                },
              }
            : {}),
          ...(state.published
            ? {
                revision: state.published.revision,
                capacityRevision: state.published.capacityRevision,
                limit: state.published.limit,
                capacityEstimator: "utf8-bytes",
              }
            : {}),
          ...(previous ? { previousModel: Schema.decodeUnknownSync(Model.Ref)(previous) } : {}),
          ...(sessionID && latest.has(sessionID) ? { lastRoute: latest.get(sessionID) } : {}),
          ...(sessionID && failures.has(sessionID) ? { lastFailure: failures.get(sessionID) } : {}),
        }),
      )
    }

    await ctx.provider.transform((editor) => {
      if (!state.published) return
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Self-driving",
          activation: "enabled",
          package: `aisdk:${new URL("./provider.js", import.meta.url).href}`,
        },
        models: [
          {
            ...Model.Info.default(providerID, Model.ID.make("auto")),
            name: "Self-driving auto",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: state.published.limit,
          },
        ],
      })
    })
    const dispatcher: Dispatcher = {
      specificationVersion: "v3",
      provider: providerID,
      modelId: "auto",
      supportedUrls: {},
      async doGenerate() {
        throw invalid("Self-driving supports streaming Session requests only")
      },
      async doStream(options) {
        const id = options.providerOptions?.[providerID]?.selfDrivingBinding
        if (typeof id !== "string")
          throw invalid("Missing self-driving Session request binding; global generation is unsupported")
        const bound = pending.get(id)
        pending.delete(id)
        if (!bound) throw invalid("Unknown or already consumed self-driving binding")
        const signal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, bound.work.controller.signal])
          : bound.work.controller.signal
        const stream = Stream.unwrap(
          Effect.tryPromise({
            try: async (interruption) => {
              const cancelled = AbortSignal.any([signal, interruption])
              cancelled.throwIfAborted()
              const catalog = await inventory(ctx)
              cancelled.throwIfAborted()
              if (capacity(bound.published.profile, catalog).capacityRevision !== bound.published.capacityRevision)
                throw invalid("Physical model capacity changed; republish the profile")
              const pair = resolvePair(
                bound.published.profile,
                {
                  backend: bound.route.backend,
                  model: bound.route.model,
                  effort: bound.route.effort,
                },
                catalog,
              )
              if (options.maxOutputTokens !== bound.published.profile.outputTokens)
                throw invalid("Output budget changed after route binding")
              const model = await language(ctx, pair)
              cancelled.throwIfAborted()
              const physical = requestFromCall(model, options)
              const view = views.get(bound.route.sessionID)
              if (bound.route.kind === "primary" && view?.requestID === id) {
                if (
                  bound.route.resources?.omitted.length &&
                  revision(view.selectedTools.toSorted()) !==
                    revision((physical.tools ?? []).map((tool) => tool.name).sort())
                )
                  throw invalid("Tool view changed after resource selection")
                view.actual = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
                  JSON.stringify({ system: physical.system, messages: physical.messages, tools: physical.tools }),
                )
              }
              const body = await Effect.runPromise(model.route.body.from(physical), { signal: cancelled })
              const estimate = Buffer.byteLength(JSON.stringify(body), "utf8") + bound.published.profile.overheadTokens
              if (
                estimate > (pair.model.limit.input ?? pair.model.limit.context) ||
                estimate + bound.route.outputTokens > pair.model.limit.context
              )
                throw invalid("Final physical request no longer fits the selected pair")
              cancelled.throwIfAborted()
              return response(
                physical,
                cancelled,
                (usage) => {
                  if (latest.get(bound.route.sessionID)?.id !== id || signal.aborted) return
                  latest.set(bound.route.sessionID, {
                    ...bound.route,
                    inputEstimate: estimate,
                    generationUsage: { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens },
                  })
                },
                {
                  input: pair.model.limit.input ?? pair.model.limit.context,
                  context: pair.model.limit.context,
                  output: bound.route.outputTokens,
                  overhead: bound.published.profile.overheadTokens,
                },
              )
            },
            catch: nativeError,
          }),
        ).pipe(
          Stream.interruptWhen(aborted(signal)),
          Stream.tapError((error) =>
            Effect.sync(() => {
              if (
                attempts.get(`${bound.route.sessionID}:${bound.route.kind}`) !== id ||
                signal.aborted ||
                (bound.execution && lifecycle.executions.get(bound.route.sessionID) !== bound.execution)
              )
                return
              failures.set(bound.route.sessionID, {
                requestID: id,
                kind: bound.route.kind,
                revision: bound.route.revision,
                message: error.message,
              })
            }),
          ),
          Stream.ensuring(Effect.sync(() => bound.work.controller.abort())),
        )
        return {
          stream: readable(
            stream,
            () => {
              lifecycle.consume(bound.work)
              // Native title jobs can outlive the foreground execution; Core now owns their stream.
              if (bound.route.kind === "title") bound.work.execution = undefined
            },
            () => bound.work.controller.abort(),
          ),
        }
      },
    }
    await ctx.aisdk.hook(
      "language",
      (event) => {
        event.language = dispatcher
      },
      { providerID },
    )

    const bind = async (event: SessionRequest, kind: Route["kind"], tools: SessionContext["tools"]) => {
      if (event.model.providerID !== providerID || event.model.id !== "auto") {
        if (kind === "primary") return
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (session.model?.providerID === providerID && session.model.id === "auto")
          throw invalid("Host auxiliary model overrides this profile's fixed pair")
        return
      }
      if ((kind === "title" || kind === "compaction") && "result" in event && event.result !== undefined) return
      const published = state.published
      if (!published) throw invalid("Self-driving has no published profile")
      const work = start(event.sessionID, "preparing", published.profile.preparationTimeoutMs)
      const id = work.id
      attempts.set(`${event.sessionID}:${kind}`, id)
      if (kind === "primary") failures.delete(event.sessionID)
      const prepared = await Effect.runPromise(
        Effect.tryPromise({
          try: async (signal) => {
            const execution = kind !== "generate" ? await lifecycle.attach(work, signal) : undefined
            if (state.applying && (!execution || !state.applying.has(execution)))
              throw invalid("Self-driving configuration is changing; retry after it is applied")
            const modes = await policies(event.sessionID)
            const original =
              kind === "primary" && (modes.contextSelection === "select" || modes.approval !== "off")
                ? structuredClone({ system: event.system, messages: event.messages, tools })
                : undefined
            const selected =
              kind === "primary"
                ? await selectResources(ctx, published.profile, { ...event, tools }, modes.contextSelection, signal)
                : { system: event.system, messages: event.messages, tools, diagnostic: undefined }
            const view = { ...event, system: selected.system, messages: selected.messages, tools: selected.tools }
            const current = await inventory(ctx)
            if (capacity(published.profile, current).capacityRevision !== published.capacityRevision)
              throw invalid("Physical model capacity changed; republish the profile")
            const candidates =
              kind === "primary"
                ? await Promise.all(
                    TIERS.map(async (tier) => {
                      const pair = resolvePair(published.profile, published.profile.tiers[tier], current)
                      const model = await language(ctx, pair)
                      const body = await Effect.runPromise(
                        model.route.body.from(request(model, view, published.profile.outputTokens)),
                        { signal },
                      )
                      const estimate =
                        Buffer.byteLength(JSON.stringify(body), "utf8") + published.profile.overheadTokens
                      return {
                        tier,
                        pair,
                        estimate,
                        fits:
                          estimate <= (pair.model.limit.input ?? pair.model.limit.context) &&
                          estimate + published.profile.outputTokens <= pair.model.limit.context,
                      }
                    }),
                  )
                : []
            const eligible = candidates.filter((candidate) => candidate.fits)
            const choice =
              kind !== "primary" || eligible.length === 1
                ? undefined
                : eligible.length
                  ? await decide(ctx, published.profile, view, eligible, signal)
                  : undefined
            const tier = kind === "primary" ? (choice?.tier ?? eligible[0]?.tier) : undefined
            const pair =
              kind === "primary"
                ? tier
                  ? published.profile.tiers[tier]
                  : undefined
                : published.profile.auxiliary[kind]
            if (!pair) throw invalid("No capacity-eligible routing tier")
            const resolved = resolvePair(published.profile, pair, current)
            const model = await language(ctx, resolved)
            const body = await Effect.runPromise(
              model.route.body.from(request(model, view, published.profile.outputTokens)),
              { signal },
            )
            const estimate = Buffer.byteLength(JSON.stringify(body), "utf8") + published.profile.overheadTokens
            if (
              estimate > (resolved.model.limit.input ?? resolved.model.limit.context) ||
              estimate + published.profile.outputTokens > resolved.model.limit.context
            )
              throw invalid("Configured auxiliary or selected pair cannot fit this request")
            signal.throwIfAborted()
            const route = Route.make({
              id,
              sessionID: event.sessionID,
              revision: published.revision,
              capacityRevision: published.capacityRevision,
              kind,
              selection: kind !== "primary" ? "fixed" : choice ? "decision" : "capacity",
              tier,
              eligibleTiers: kind === "primary" ? eligible.map((candidate) => candidate.tier) : [],
              excluded:
                kind === "primary"
                  ? candidates
                      .filter((candidate) => !candidate.fits)
                      .map((candidate) => ({
                        tier: candidate.tier,
                        reason: "input/output budget exceeds physical capacity",
                      }))
                  : [],
              backend: pair.backend,
              model: pair.model,
              physicalModel: resolved.model.modelID,
              effort: pair.effort,
              inputEstimate: estimate,
              outputTokens: published.profile.outputTokens,
              ...(selected.diagnostic ? { resources: selected.diagnostic } : {}),
              ...(choice ? { decision: choice.diagnostic } : {}),
            })
            const prefix = original
              ? (await ctx.session.context({ sessionID: event.sessionID })).map((message) => message.id)
              : []
            signal.throwIfAborted()
            return { route, selected, prefix, original, execution }
          },
          catch: (cause) =>
            APICallError.isInstance(cause) && cause.url === "self-driving://request"
              ? cause
              : invalid(
                  "Self-driving request preparation failed; inspect profile, capacity and native decision binding",
                ),
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(
              () =>
                attempts.get(`${event.sessionID}:${kind}`) === id &&
                !work.controller.signal.aborted &&
                failures.set(event.sessionID, {
                  requestID: id,
                  kind,
                  revision: published.revision,
                  message: error.message,
                }),
            ),
          ),
        ),
        { signal: work.controller.signal },
      ).catch(() => {
        if (work.expired && attempts.get(`${event.sessionID}:${kind}`) === id)
          failures.set(event.sessionID, {
            requestID: id,
            kind,
            revision: published.revision,
            message: "Request preparation exceeded its deadline",
          })
        work.controller.abort()
        throw invalid("Self-driving request preparation failed or exceeded its deadline")
      })
      work.controller.signal.throwIfAborted()
      if (kind === "primary") {
        Object.assign(event, { system: prepared.selected.system, tools: prepared.selected.tools })
      }
      if (prepared.original && prepared.execution) {
        views.set(event.sessionID, {
          requestID: id,
          revision: published.revision,
          prefix: prepared.prefix,
          original: prepared.original,
          execution: prepared.execution,
          selectedTools: Object.keys(prepared.selected.tools),
          omittedTools: Object.keys(prepared.original.tools).filter((name) => !(name in prepared.selected.tools)),
        })
      }
      work.phase = "pending"
      pending.set(id, { published, route: prepared.route, work, execution: prepared.execution })
      if (kind === "primary" || !latest.has(event.sessionID)) latest.set(event.sessionID, prepared.route)
      event.options.maxTokens = published.profile.outputTokens
      event.options.selfDrivingBinding = id
    }
    await ctx.session.hook("context", (event) => bind(event, "primary", event.tools))
    await ctx.session.hook("title", (event) => bind(event, "title", {}))
    await ctx.session.hook("compaction", (event) => bind(event, "compaction", event.tools))
    await ctx.session.hook("generate", (event) => bind(event, "generate", event.tools))

    await ctx.tool.hook("execute.before", async (event) => {
      const key = `${event.sessionID}:${event.messageID}:${event.id}`
      const view = views.get(event.sessionID)
      const route = latest.get(event.sessionID)
      if (route?.resources?.omitted.length && view?.requestID === route.id) {
        if (view.omittedTools.includes(event.tool)) throw invalid("Tool was omitted from this request's resource view")
      }
      if ((await policies(event.sessionID)).approval === "off") return
      if (!view || view.execution.controller.signal.aborted || lifecycle.controller.signal.aborted) return
      await Promise.resolve()
        .then(() => {
          calls.set(key, {
            tool: event.tool,
            agent: event.agent,
            input: Schema.decodeUnknownSync(Schema.JsonObject)(structuredClone(event.input)),
            view,
            execution: view?.execution,
          })
        })
        .catch(() => calls.delete(key))
    })
    await ctx.tool.hook("execute.after", (event) => {
      calls.delete(`${event.sessionID}:${event.messageID}:${event.id}`)
    })
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask") return
      const modes = await policies(event.sessionID)
      const published = state.published
      if (modes.approval === "off" || !published) return
      const key = event.source ? `${event.sessionID}:${event.source.messageID}:${event.source.id}` : undefined
      const call = key ? calls.get(key) : undefined
      if (key) calls.delete(key)
      const work = start(event.sessionID, "approval")
      work.execution = call?.execution
      const controller = work.controller
      if (work.execution?.controller.signal.aborted) controller.abort()
      const identity = () =>
        revision({
          action: event.action,
          resources: event.resources,
          source: event.source,
          metadata: event.metadata,
        })
      const result = await Effect.runPromise(
        Effect.tryPromise({
          try: async (signal) => {
            const before = identity()
            const result = await approve(ctx, published, modes.approval, event, call, signal)
            return identity() === before
              ? result
              : {
                  ...result,
                  outcome: "manual-required" as const,
                  reason: "Permission identity changed during decision",
                }
          },
          catch: () => invalid("Approval evidence or native decision is unavailable"),
        }).pipe(Effect.timeout(published.profile.approval?.timeoutMs ?? published.profile.preparationTimeoutMs)),
        { signal: controller.signal },
      )
        .catch(
          (): ApprovalResult => ({
            mode: modes.approval,
            action: event.action,
            outcome: "manual-required",
            reason: "Approval failed, was cancelled, or exceeded its independent deadline",
          }),
        )
        .finally(() => lifecycle.finish(work))
      if (
        state.published?.revision !== published.revision ||
        (await policies(event.sessionID)).approval !== modes.approval ||
        controller.signal.aborted
      )
        return
      approvals.set(event.sessionID, result)
      if (result.outcome === "allowed" && event.effect === "ask") event.effect = "allow"
    })

    const registration = await ctx.rpc.register(Contract, {
      status: (input, rpc) => status(input.sessionID, rpc.signal),
      async config() {
        const draft = await ctx.storage.get("draft")
        return {
          ...(draft ? { draft: decodeProfile(draft) } : {}),
          ...(state.published ? { published: state.published } : {}),
        }
      },
      draft: (input, rpc) =>
        change(async () => {
          rpc.signal.throwIfAborted()
          const profile = await Promise.resolve()
            .then(() => decodeProfile(input.profile))
            .catch(() => {
              throw invalid(
                "Invalid profile: only supported credential references and configuration fields are accepted",
              )
            })
          lifecycle.controller.signal.throwIfAborted()
          rpc.signal.throwIfAborted()
          await ctx.storage.set("draft", json(profile))
          return { saved: true }
        }),
      publish: (_, rpc) =>
        change(async () => {
          rpc.signal.throwIfAborted()
          const draft = await ctx.storage.get("draft")
          if (!draft) throw invalid("Save a profile draft before publishing")
          const profile = decodeProfile(draft)
          await Promise.all([
            ...Object.values(profile.backends).map((backend) => credential(ctx, backend.auth)),
            credential(ctx, profile.decision.auth),
          ])
          capacity(profile, await inventory(ctx))
          const signal = AbortSignal.any([rpc.signal, lifecycle.controller.signal])
          await lifecycle.flush(signal)
          state.applying = new Set(
            Array.from(lifecycle.executions.values()).filter((execution) => !execution.controller.signal.aborted),
          )
          try {
            await registration.events.emit("configuration", { applying: true })
            await waitSessions(signal)
            await lifecycle.flush(signal)
            await lifecycle.drain(signal)
            const validated = capacity(profile, await inventory(ctx))
            signal.throwIfAborted()
            const published = Published.make({ revision: crypto.randomUUID(), profile, ...validated })
            const previous = state.published
            state.published = published
            await ctx.provider
              .reload()
              .then(() => verifyCatalog(published))
              .then(() => ctx.storage.set("published", json(published)))
              .catch(async () => {
                state.published = previous
                await ctx.provider
                  .reload()
                  .then(() => verifyCatalog(previous))
                  .catch(() => lifecycle.close())
                throw invalid("Profile publication failed; previous published profile retained")
              })
            return published
          } finally {
            state.applying = undefined
            if (!lifecycle.controller.signal.aborted)
              await registration.events.emit("configuration", { applying: false })
          }
        }),
      enable: (input, rpc) =>
        change(async () => {
          if (!state.published) throw invalid("Publish a complete profile before enabling")
          const signal = AbortSignal.any([rpc.signal, lifecycle.controller.signal])
          await wait(input.sessionID, signal)
          signal.throwIfAborted()
          const session = await ctx.session.get(input)
          if (session.model?.providerID === providerID && session.model.id === "auto") return status(input.sessionID)
          const fallback =
            session.model ??
            (await ctx.model
              .default()
              .then((result) => (result.data ? { providerID: result.data.providerID, id: result.data.id } : undefined)))
          if (!fallback) throw invalid("Session has no restorable model selection")
          signal.throwIfAborted()
          await ctx.storage.set(`previous:${input.sessionID}`, json(fallback))
          await ctx.session.switchModel({ sessionID: input.sessionID, model: auto })
          return status(input.sessionID)
        }),
      disable: (input, rpc) =>
        change(async () => {
          const signal = AbortSignal.any([rpc.signal, lifecycle.controller.signal])
          await wait(input.sessionID, signal)
          signal.throwIfAborted()
          const session = await ctx.session.get(input)
          if (session.model?.providerID === providerID && session.model.id === "auto") {
            const previous = await ctx.storage.get(`previous:${input.sessionID}`)
            if (!previous) throw invalid("Previous model is unavailable; select a model explicitly")
            const ref = Schema.decodeUnknownSync(Model.Ref)(previous)
            const model = (await ctx.model.list()).data.find(
              (model) => model.providerID === ref.providerID && model.id === ref.id && model.enabled,
            )
            if (!model || (ref.variant && !model.variants.some((variant) => variant.id === ref.variant)))
              throw invalid("Previous model or variant is unavailable; select a model explicitly")
            signal.throwIfAborted()
            await ctx.session.switchModel({ sessionID: input.sessionID, model: ref })
          }
          signal.throwIfAborted()
          await ctx.storage.remove(`previous:${input.sessionID}`)
          await ctx.storage.remove(`policies:${input.sessionID}`)
          views.delete(input.sessionID)
          return status(input.sessionID)
        }),
      policies: (input, rpc) =>
        change(async () => {
          const published = state.published
          if (!published) throw invalid("Publish a profile before enabling policies")
          if (input.contextSelection !== "inherit" && !published.profile.resources)
            throw invalid("Configure a resource omission threshold before enabling selection")
          if (input.approval !== "off" && !published.profile.approval)
            throw invalid("Configure approval thresholds, evidence budgets and MCP servers before enabling approval")
          const signal = AbortSignal.any([rpc.signal, lifecycle.controller.signal])
          await wait(input.sessionID, signal)
          signal.throwIfAborted()
          await ctx.session.get({ sessionID: input.sessionID })
          signal.throwIfAborted()
          await ctx.storage.set(`policies:${input.sessionID}`, json({ ...input, revision: published.revision }))
          views.delete(input.sessionID)
          return status(input.sessionID)
        }),
    })
    const events = ctx.event.subscribe()[Symbol.asyncIterator]()
    const observing = (async () => {
      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        if (event.type === "session.step.started") {
          const view = views.get(event.data.sessionID)
          if (
            view &&
            lifecycle.executions.get(event.data.sessionID) === view.execution &&
            event.durable.seq > view.execution.sequence
          )
            view.assistantMessageID = event.data.assistantMessageID
        }
        if (event.type === "session.step.ended" || event.type === "session.step.failed") {
          if (views.get(event.data.sessionID)?.assistantMessageID === event.data.assistantMessageID)
            views.delete(event.data.sessionID)
          const prefix = `${event.data.sessionID}:${event.data.assistantMessageID}:`
          Array.from(calls.keys())
            .filter((key) => key.startsWith(prefix))
            .forEach((key) => calls.delete(key))
        }
        lifecycle.observe(event)
      }
    })()
      .catch(() => undefined)
      .finally(() => lifecycle.close())
    return async () => {
      lifecycle.close()
      pending.clear()
      views.clear()
      calls.clear()
      await registration.dispose()
      await events.return?.()
      await observing
      await Promise.all(lifecycle.timers)
    }
  },
})
