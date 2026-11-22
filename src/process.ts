import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Options } from "./options.js"
import type { Plan } from "./plan.js"

export interface Generation {
  url: string
  directory: string
  plan: Plan
  token: string
  alive(): boolean
  close(): Promise<void>
}
export type Launch = (plan: Plan, options: Options, signal: AbortSignal) => Promise<Generation>

async function terminate(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000)
  try { await child.exited } finally { clearTimeout(timeout) }
}

async function run(command: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, capture = false): Promise<string> {
  signal.throwIfAborted()
  const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: capture ? "pipe" : "ignore", stderr: "ignore" })
  const cancel = () => { void terminate(child) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    const output = capture ? new Response(child.stdout as ReadableStream<Uint8Array>).text() : Promise.resolve("")
    const [code, text] = await Promise.all([child.exited, output])
    if (code !== 0) throw new Error("BitRouter rejected generated configuration; original models remain available")
    signal.throwIfAborted()
    return text
  } finally {
    signal.removeEventListener("abort", cancel)
    await terminate(child)
  }
}

/** Each generation owns an isolated process and files; no shared daemon or user config is mutated. */
export const launch: Launch = async (plan, options, parent) => {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(options.stateDirectory, "instance-"))
  // Unix sockets have a much smaller path limit than regular files. Use a
  // separate owner-only temporary directory, falling back to the short POSIX
  // temp alias only when a caller's TMPDIR is too long.
  const socketRoot = process.platform !== "win32" && Buffer.byteLength(tmpdir()) > 75 ? "/tmp" : tmpdir()
  let socketDirectory: string | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  let phase = "writing files"
  const signal = AbortSignal.any([parent, AbortSignal.timeout(options.startupTimeoutMs)])
  try {
    socketDirectory = await mkdtemp(join(socketRoot, "br-"))
    const data = join(directory, "data")
    await mkdir(join(data, "bitrouter"), { recursive: true, mode: 0o700 })
    // Access-only, non-refreshable snapshots. They are removed with this generation.
    await writeFile(join(data, "bitrouter/oauth-tokens.json"), JSON.stringify(plan.credentials), { mode: 0o600, flag: "wx" })
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reservation.port!
    await reservation.stop(true)
    const config = {
      ...plan.config,
      server: { listen: `127.0.0.1:${port}`, skip_auth: false, control_socket: join(socketDirectory, "s"), log_level: "error" },
      database: { url: `sqlite://${join(directory, "router.db")}?mode=rwc` },
    }
    const configPath = join(directory, "bitrouter.yaml")
    let yaml = Bun.YAML.stringify(config, null, 2)
    // References must remain unquoted: their env values are complete escaped YAML scalars.
    for (const variable of Object.keys(plan.env)) {
      if (variable === "OPENCODE_BITROUTER_DECISION") continue
      const reference = `\${${variable}}`
      yaml = yaml.replaceAll(JSON.stringify(reference), reference)
      if (!yaml.includes(`: ${reference}`)) throw new Error("Unsafe credential interpolation")
    }
    await writeFile(configPath, yaml, { mode: 0o600, flag: "wx" })
    await writeFile(join(directory, "policy-lock.yaml"), Bun.YAML.stringify(plan.policy, null, 2), { mode: 0o600, flag: "wx" })
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: directory, USERPROFILE: directory,
      XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
      TMPDIR: directory, TMP: directory, TEMP: directory,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...plan.env,
    }
    phase = "validating configuration"
    await run([...options.command, "config", "validate", "--config", "bitrouter.yaml"], directory, env, signal)
    phase = "resolving policy"
    await run([...options.command, "route", "bitrouter/auto", "--config", "bitrouter.yaml"], directory, env, signal)
    phase = "creating local ingress credential"
    const signed = JSON.parse(await run([
      ...options.command, "--json", "key", "sign", "--user", "opencode-connector", "--db", config.database.url,
    ], directory, env, signal, true))
    if (typeof signed.secret !== "string" || !signed.secret.startsWith("brvk_"))
      throw new Error("Invalid local ingress credential")
    const token: string = signed.secret
    signal.throwIfAborted()
    phase = "starting server"
    child = Bun.spawn([...options.command, "serve", "--config", "bitrouter.yaml"], {
      cwd: directory, env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    })
    const url = `http://127.0.0.1:${port}`
    for (;;) {
      signal.throwIfAborted()
      if (child.exitCode !== null) throw new Error("BitRouter exited before readiness")
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]), redirect: "error" })
        await response.body?.cancel()
        if (response.ok) break
      } catch { signal.throwIfAborted() }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const running = child
    return {
      url, directory, plan, token,
      alive: () => running.exitCode === null,
      async close() {
        await terminate(running)
        await rm(directory, { recursive: true, force: true })
        await rm(socketDirectory!, { recursive: true, force: true })
      },
    }
  } catch {
    if (child) await terminate(child)
    await rm(directory, { recursive: true, force: true })
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true })
    throw new Error(`BitRouter startup failed while ${phase}; check command, version, policy and local state permissions`)
  }
}
