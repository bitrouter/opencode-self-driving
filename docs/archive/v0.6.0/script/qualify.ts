import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { decodePlan, environmentNames } from "./qualification/plan"

if (Bun.version !== "1.4.2") throw new Error("Use the qualified Bun 1.4.2")
if (process.argv.includes("--help")) {
  console.log(
    "bun run qualify --plan <JSON> --out <new report.json> [--execute]\nWithout --execute, catalog and credential-reference preflight sends no provider requests.",
  )
  process.exit(0)
}
const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--"))
    throw new Error(`Required argument: ${name}`)
  return resolve(process.argv[index + 1])
}
await Promise.resolve()
  .then(async () => {
    const path = argument("--plan")
    const output = argument("--out")
    if (await Bun.file(output).exists())
      throw new Error("Use a new report path; existing evidence is never overwritten")
    const plan = decodePlan(await Bun.file(path).json())
    if (!(await Bun.file("dist/server.js").exists())) throw new Error("Build the plugin before qualification")
    const directory = await mkdtemp(join(tmpdir(), "self-driving-qualification-env-"))
    await mkdir(dirname(output), { recursive: true })
    const child = Bun.spawn(
      [
        process.execPath,
        "script/qualification/worker.ts",
        path,
        output,
        resolve("."),
        process.argv.includes("--execute") ? "execute" : "preflight",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          USERPROFILE: directory,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_CACHE_HOME: join(directory, "cache"),
          XDG_DATA_HOME: join(directory, "data"),
          XDG_STATE_HOME: join(directory, "state"),
          OPENCODE_TEST_HOME: directory,
          OPENCODE_CONFIG_CONTENT: "{}",
          OPENCODE_DISABLE_FILEWATCHER: "true",
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          ...Object.fromEntries(environmentNames(plan).map((name) => [name, process.env[name]])),
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    // This is a cleanup grace, not additional authorization for model calls.
    const stopping = AbortSignal.timeout(plan.limits.maxDurationMs)
    const killing = AbortSignal.timeout(plan.limits.maxDurationMs + 5_000)
    const stop = () => child.kill("SIGTERM")
    const kill = () => child.kill("SIGKILL")
    stopping.addEventListener("abort", stop, { once: true })
    killing.addEventListener("abort", kill, { once: true })
    const code = await child.exited
    stopping.removeEventListener("abort", stop)
    killing.removeEventListener("abort", kill)
    await rm(directory, { recursive: true, force: true })
    if (!(await Bun.file(output).exists()))
      await Bun.write(
        output,
        JSON.stringify(
          { schemaVersion: 1, state: "failed", failureStage: "worker-or-deadline", quality: "not-qualified" },
          null,
          2,
        ) + "\n",
      )
    console.log(`Qualification report: ${output}`)
    process.exitCode = code
  })
  .catch(() => {
    console.error(
      "Qualification could not start. Check the plan schema, explicit limits, credential references, build and unused output path. No raw configuration or provider errors are printed.",
    )
    process.exitCode = 1
  })
