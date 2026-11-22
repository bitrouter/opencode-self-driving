import { Model, Plugin, Provider } from "@opencode/plugin"
import { Connector } from "./connector.js"
import { options } from "./options.js"
import { Contract } from "./rpc.js"
import { DefaultModel } from "./default.js"

const providerID = Provider.ID.make("bitrouter")
const modelID = Model.ID.make("auto")

export default Plugin.define({
  // Keep the package's stable ID for plugin lifecycle compatibility; old stored profiles are ignored.
  id: "opencode-self-driving",
  async setup(ctx) {
    if ((await ctx.provider.list({ location: ctx.location })).data.some((provider) => provider.id === providerID))
      throw new Error("Provider bitrouter already exists; remove the conflicting definition or disable the connector")
    let installed = false
    const defaults = new DefaultModel(ctx.location.directory, ctx.storage)
    const connector: Connector = new Connector(ctx, options(ctx.options, ctx.location.directory), async () => {
      if (installed) {
        await ctx.provider.reload()
        if (connector.activePlan)
          await defaults.install(connector.activePlan.catalog.defaultSource)
      }
    })
    const controller = new AbortController()
    let observing: Promise<void> | undefined
    try {
      await ctx.provider.transform((editor) => {
        const plan = connector.activePlan
        if (!plan) return
        const commonInput = ["text", "image"].filter((type) =>
          plan.catalog.sources.every((source) => source.model.capabilities.input.includes(type)))
        editor.add({
          info: {
            ...Provider.Info.empty(providerID), name: "BitRouter", activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${connector.url}/v1`, apiKey: connector.token, encoding: "none", transport: "http", compaction: { type: "summary" } },
          },
          models: [{
            ...Model.Info.default(providerID, modelID),
            modelID: Model.ID.make("bitrouter/auto"), name: "BitRouter Auto",
            capabilities: { tools: true, input: commonInput, output: ["text"], freeform: [] },
            limit: plan.limits,
            // Composite billing is unknown; never present an invented physical tariff.
            cost: [],
          }],
        })
      })
      installed = true
      // Finish startup before reading dynamic inventories. An explicit model in the
      // built-in config layer outranks custom transforms in 2.3.2, so the one-field
      // reversible project edit is what establishes a persistent configured default.
      const ready = Promise.withResolvers<void>()
      let initializing: Promise<void> | undefined
      const deferred = setImmediate(() => {
        initializing = (async () => {
          if (controller.signal.aborted) return
          if ((await ctx.provider.list({ location: ctx.location })).data.some((provider) => provider.id === providerID))
            throw new Error("Provider bitrouter already exists; refusing to overwrite it")
          const saved = await defaults.saved()
          if (saved?.source) connector.prefer(saved.source)
          await connector.sync()
          if (controller.signal.aborted) return
          await ctx.model.transform((editor) => {
            if (defaults.enabled && connector.activePlan && editor.get(providerID, modelID))
              editor.default.set(providerID, modelID)
          })
        })()
        void initializing.then(ready.resolve, ready.reject)
      })
      // A failed bootstrap is also observable through RPC without unhandled rejections.
      void ready.promise.catch(() => undefined)
      await ctx.rpc.register(Contract, {
        status: async () => { await ready.promise; await connector.sync(); return connector.status() },
        sync: async () => { await ready.promise; await connector.sync(); return connector.status() },
        restore: async () => {
          await ready.promise
          await defaults.restore()
          await ctx.model.reload()
          return { restored: true }
        },
      })
      await ctx.command.transform((editor) => {
        editor.add({
          name: "bitrouter-restore",
          description: "Restore the previous project default model without changing providers",
          execute: async () => { await ready.promise; await defaults.restore(); await ctx.model.reload() },
        })
      })
      // Live-only inventory/credential changes trigger a refresh; the ingress also resyncs
      // before every dispatch, so missed events never authorize use of stale credentials.
      observing = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if ("location" in event && event.location && event.location.directory !== ctx.location.directory) continue
          if ([
            "model.updated", "provider.updated", "config.updated", "credential.updated",
            "credential.switched", "integration.updated", "integration.connection.updated",
          ].includes(event.type)) await connector.sync()
        }
      })().catch(() => {
        if (!controller.signal.aborted) console.error("BitRouter inventory subscription ended; requests still resync before dispatch")
      })
      return async () => {
        controller.abort()
        clearImmediate(deferred)
        ready.resolve()
        await connector.close()
        await initializing?.catch(() => undefined)
        await observing
      }
    } catch (error) {
      controller.abort()
      await connector.close()
      throw error
    }
  },
})
