import { Model, Provider } from "@opencode/plugin"
import type { Host } from "../src/catalog"
import type { Options } from "../src/options"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function model(provider: string, id = "coder"): Model.Info {
  return { ...Model.Info.default(Provider.ID.make(provider), Model.ID.make(id)), type: "chat", limit: { context: 32768, output: 2048 } }
}
export function provider(id: string, baseURL = "https://api.example.test/v1"): Provider.Info {
  return {
    ...Provider.Info.empty(Provider.ID.make(id)), activation: "enabled" as const,
    package: "@opencode/ai/providers/openai-compatible", settings: { baseURL },
  }
}
export function host(input: {
  models?: ReturnType<typeof model>[]
  providers?: ReturnType<typeof provider>[]
  credentials?: Record<string, unknown>
  preferred?: { providerID: string; id: string }
} = {}) {
  const state = {
    models: input.models ?? [model("local")],
    providers: input.providers ?? [provider("local", "http://127.0.0.1:1234/v1")],
    credentials: input.credentials ?? {},
    preferred: input.preferred ?? { providerID: "local", id: "coder" },
    resolutions: 0,
    failConnections: false,
  }
  const api = {
    model: {
      list: async () => ({ data: state.models }),
      default: async () => ({ data: state.preferred }),
    },
    provider: { list: async () => ({ data: state.providers }) },
    integration: { connection: {
      active: async (id: string) => {
        if (state.failConnections) throw new Error("secret-token-example")
        return state.credentials[id] ? { integrationID: id } : undefined
      },
      resolve: async (entry: { integrationID: string }) => { state.resolutions++; return state.credentials[entry.integrationID] },
    } },
  } as unknown as Host
  return { api, state }
}
export async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "bitrouter-connector-"))
  return {
    directory,
    async [Symbol.asyncDispose]() { await rm(directory, { recursive: true, force: true }) },
  }
}
export function options(directory: string): Options {
  return {
    command: [process.execPath, join(import.meta.dir, "router-fixture.ts")],
    stateDirectory: directory, startupTimeoutMs: 10_000,
  }
}
