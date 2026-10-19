import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { Schema } from "effect"

// Only the isolated acceptance host loads this fixture. It is not part of the package.
export default Plugin.define({
  id: "self-driving-smoke-fixture",
  async setup(ctx) {
    const options = Schema.decodeUnknownSync(Schema.Struct({ wireURL: Schema.String, mcpURL: Schema.String }))(
      ctx.options,
    )
    await ctx.provider.transform((editor) =>
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make("fixture-openai")),
          canonical: Provider.ID.make("openai"),
          integrationID: Integration.ID.make("openai"),
          activation: "enabled",
          package: "@opencode/ai/providers/openai",
          settings: { baseURL: options.wireURL },
        },
        models: ["low", "medium", "high", "xhigh", "max"].map((tier, index) => ({
          ...Model.Info.default(Provider.ID.make("fixture-openai"), Model.ID.make(tier)),
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: [128000, 128000, 256000, 256000, 1000000][index], output: 8192 },
          variants: ["none", "low", "medium", "high"].map((id) => ({
            id: Model.VariantID.make(id),
            settings: { reasoningEffort: id },
          })),
        })),
      }),
    )
    const ready = Promise.withResolvers<void>()
    await ctx.mcp.transform((editor) =>
      editor.set("fixture", { type: "remote", url: options.mcpURL, oauth: false, codemode: false }),
    )
    await ctx.tool.transform((editor) => {
      editor
        .list()
        .filter((tool) => tool.id !== "fixture_echo")
        .forEach((tool) => editor.remove(tool.id))
      if (editor.get("fixture_echo")) ready.resolve()
    })
    await ctx.agent.transform((editor) =>
      editor.list().forEach((agent) =>
        editor.update(String(agent.id), (agent) => {
          agent.steps = 3
          agent.permissions = [
            { action: "*", resource: "*", effect: "deny" },
            { action: "fixture_echo", resource: "*", effect: "ask" },
          ]
        }),
      ),
    )
    await ctx.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text: "Unrelated historical color preference: blue.",
        metadata: {
          "self-driving/resource": {
            id: "smoke-optional",
            kind: "instruction",
            source: "smoke-fixture",
            required: false,
            dependencies: [],
            tools: [],
          },
        },
      })
    })
    await ctx.session.hook("retry", (event) => {
      event.decision = { retry: false }
    })
    await ctx.rpc.register(
      {
        id: "self-driving-smoke",
        methods: {
          ready: {
            input: Schema.toStandardSchemaV1(Schema.Struct({})),
            output: Schema.toStandardSchemaV1(Schema.Struct({ ready: Schema.Boolean })),
          },
        },
        events: {},
      },
      {
        async ready() {
          await ready.promise
          return { ready: true }
        },
      },
    )
  },
})
