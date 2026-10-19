import { Plugin } from "@opencode/plugin"
import type { Lifecycle } from "../src/lifecycle"

type Event = Parameters<Lifecycle["observe"]>[0]

export function monitor() {
  const listeners = new Set<{ test: (event: Event) => boolean; resolve: (event: Event) => void }>()
  const plugin = Plugin.define({
    id: "lifecycle-event-monitor",
    async setup(ctx) {
      const events = ctx.event.subscribe()[Symbol.asyncIterator]()
      const consuming = (async () => {
        for await (const event of { [Symbol.asyncIterator]: () => events }) {
          listeners.forEach((listener) => {
            if (!listener.test(event)) return
            listeners.delete(listener)
            listener.resolve(event)
          })
        }
      })()
      return async () => {
        await events.return?.()
        await consuming
      }
    },
  })
  return {
    plugin,
    next(test: (event: Event) => boolean) {
      const pending = Promise.withResolvers<Event>()
      listeners.add({ test, resolve: pending.resolve })
      return pending.promise
    },
  }
}
