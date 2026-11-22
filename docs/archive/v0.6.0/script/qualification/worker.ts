import { decodePlan } from "./plan"
import { run } from "./run"

const controller = new AbortController()
process.once("SIGTERM", () => controller.abort())
const plan = decodePlan(await Bun.file(process.argv[2]).json())
const timeout = AbortSignal.timeout(plan.limits.maxDurationMs)
timeout.addEventListener("abort", () => controller.abort(), { once: true })
const report = await run(plan, process.argv[4], controller, process.argv[5] === "execute")
await Bun.write(process.argv[3], JSON.stringify(report, null, 2) + "\n")
process.exitCode = ["ready", "completed"].includes(report.state) ? 0 : 1
