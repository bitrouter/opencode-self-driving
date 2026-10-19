import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { chat } from "./routing-fixture"
import type { Wire } from "./routing-fixture"

export function contributions(
  input: { invalid?: boolean; codemode?: boolean; dynamic?: boolean; required?: boolean; payload?: string } = {},
) {
  const invoked: string[] = []
  const plugin = Plugin.define({
    id: "public-resource-contributor",
    async setup(ctx) {
      await ctx.tool.transform((editor) => {
        ;["optional_probe", "dependent_probe"].forEach((name) =>
          editor.add({
            name,
            description: name,
            input: { type: "object", properties: {} },
            options: { codemode: input.codemode ?? false },
            async execute() {
              invoked.push(name)
              return { content: name }
            },
          }),
        )
      })
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: "UNKNOWN_NATIVE_INSTRUCTION_MUST_STAY" })
        const units = [
          { id: "optional", tools: ["optional_probe"], dependencies: [] },
          { id: "dependent", tools: ["dependent_probe"], dependencies: [input.invalid ? "missing" : "optional"] },
        ]
        units.forEach((unit) =>
          event.system.push({
            type: "text",
            text: `CONTRIBUTION_${unit.id}${input.dynamic && event.messages.length > 1 ? "_UPDATED" : ""}${unit.id === "optional" ? (input.payload ?? "") : ""}`,
            metadata: {
              "self-driving/resource": {
                ...unit,
                source: "public-resource-contributor",
                kind: "tool-bundle",
                required: input.required ?? false,
              },
            },
          }),
        )
      })
    },
  })
  return { plugin, invoked }
}

export function mcp() {
  const calls: unknown[] = []
  const ready = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message = Schema.decodeUnknownSync(
        Schema.Struct({
          jsonrpc: Schema.String,
          id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
          method: Schema.String,
          params: Schema.optional(Schema.JsonObject),
        }),
      )(await request.json())
      if (message.id === undefined) return new Response(null, { status: 202 })
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
              instructions: "MCP_INSTRUCTIONS_MUST_STAY",
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Echo the exact supplied text",
                    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                  },
                ],
              }
            : message.method === "tools/call"
              ? (calls.push(message.params?.arguments), { content: [{ type: "text", text: "MCP_RESULT" }] })
              : {}
      return Response.json({ jsonrpc: "2.0", id: message.id, result })
    },
  })
  const asked: string[] = []
  const observed: string[] = []
  const plugin = (effect: "ask" | "deny" | "allow" = "ask", action = "fixture_echo") =>
    Plugin.define({
      id: "native-mcp-fixture",
      async setup(ctx) {
        await ctx.mcp.transform((editor) =>
          editor.set("fixture", { type: "remote", url: server.url.href, oauth: false, codemode: false }),
        )
        await ctx.tool.transform((editor) => {
          if (editor.get("fixture_echo")) ready.resolve()
        })
        await ctx.agent.transform((editor) =>
          editor.list().forEach((agent) =>
            editor.update(String(agent.id), (agent) => {
              agent.permissions.push({ action, resource: "*", effect })
            }),
          ),
        )
        await ctx.permission.hook("evaluate", (event) => {
          if (event.action === "fixture_echo") observed.push(event.effect)
        })
        const events = ctx.event.subscribe()[Symbol.asyncIterator]()
        const listening = (async () => {
          for await (const event of { [Symbol.asyncIterator]: () => events }) {
            if (event.type !== "permission.asked") continue
            asked.push(event.data.action)
            await ctx.permission.reply({ sessionID: event.data.sessionID, requestID: event.data.id, decision: "once" })
          }
        })()
        return async () => {
          await events.return?.()
          await listening
        }
      },
    })
  return {
    calls,
    url: server.url.href,
    asked,
    observed,
    plugin,
    ready: ready.promise,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

export function toolGeneration(name = "fixture_echo", text = "exact-parameters", input?: Schema.JsonObject) {
  const calls: Wire[] = []
  return {
    calls,
    generate(body: Wire) {
      calls.push(body)
      if (calls.length > 1) return chat(body.model, { content: "Finished" })
      return chat(
        body.model,
        {
          tool_calls: [
            {
              index: 0,
              id: "policy-call",
              type: "function",
              function: { name, arguments: JSON.stringify(input ?? { text }) },
            },
          ],
        },
        "tool_calls",
      )
    },
  }
}
