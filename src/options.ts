import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface Options {
  command: string[]
  stateDirectory: string
  startupTimeoutMs: number
  policyFile?: string
  decision?: { model: string; baseURL: string; apiKeyEnv: string }
}

export function options(input: Record<string, unknown>, directory = process.cwd()): Options {
  const known = ["command", "stateDirectory", "startupTimeoutMs", "policyFile", "decision"]
  if (Object.keys(input).some((key) => !known.includes(key))) throw new Error("Unknown BitRouter connector option")
  const command = input.command ?? ["bro"]
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string" || !part))
    throw new Error("command must be a nonempty executable/argument array")
  const timeout = input.startupTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeout) || (timeout as number) <= 0) throw new Error("Invalid startupTimeoutMs")
  for (const key of ["stateDirectory", "policyFile"] as const)
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key]))
      throw new Error(`Invalid ${key}`)
  let decision: Options["decision"]
  if (input.decision !== undefined) {
    const value = input.decision as Record<string, unknown>
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["model", "baseURL", "apiKeyEnv"].includes(key)) ||
      typeof value.model !== "string" || !value.model.trim() || value.model.includes("${") ||
      (value.baseURL !== undefined && (typeof value.baseURL !== "string" || value.baseURL.includes("${"))) ||
      typeof value.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.apiKeyEnv))
      throw new Error("Invalid decision connection")
    const url = new URL(typeof value.baseURL === "string" ? value.baseURL : "https://api.typesafe.ai")
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid decision endpoint")
    decision = { model: value.model, apiKeyEnv: value.apiKeyEnv, baseURL: url.href.replace(/\/$/, "") }
  }
  return {
    command: command as string[],
    stateDirectory: resolve(directory,
      (input.stateDirectory as string | undefined) ??
        join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode-bitrouter"),
    ),
    startupTimeoutMs: timeout as number,
    ...(input.policyFile ? { policyFile: resolve(directory, input.policyFile as string) } : {}),
    ...(decision ? { decision } : {}),
  }
}
