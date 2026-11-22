import { Rpc } from "@opencode/plugin/rpc"

export const Contract = Rpc.define({
  id: "opencode-bitrouter",
  methods: {
    status: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
    sync: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
    restore: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
  },
  events: {},
})
export default Contract
