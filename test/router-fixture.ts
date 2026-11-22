// Local process fixture only. It does not route models and is never used as routing-quality evidence.
import { readFileSync } from "node:fs"
import { join } from "node:path"
const args = process.argv.slice(2)
if (args.includes("key")) {
  console.log(JSON.stringify({ secret: "brvk_fixture_private_ingress" }))
  process.exit(0)
}
const path = args[args.indexOf("--config") + 1]
let yaml = readFileSync(path, "utf8")
yaml = yaml.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "")
const config = Bun.YAML.parse(yaml) as any
if (args[0] === "serve") {
  const [hostname, port] = config.server.listen.split(":")
  const server = Bun.serve({
    hostname, port: Number(port),
    async fetch(request) {
      if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" })
      const body = await request.json() as any
      if (body.model !== "bitrouter/auto") return new Response(null, { status: 400 })
      if (body.fixtureHold) await new Promise((resolve) => setTimeout(resolve, 150))
      if (body.stream) {
        const chunk = (delta: any, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "bitrouter/auto", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        return new Response(chunk({ role: "assistant", content: "fixture" }) + chunk({}, "stop") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({
        id: "fixture", object: "chat.completion", model: "bitrouter/auto",
        choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }],
        fixture: {
          policy: Bun.YAML.parse(readFileSync(join(path, "../policy-lock.yaml"), "utf8")),
          credentials: JSON.parse(readFileSync(join(process.env.XDG_DATA_HOME!, "bitrouter/oauth-tokens.json"), "utf8")),
          headers: Object.values(config.providers).map((provider: any) => provider.headers),
        },
      })
    },
  })
  process.on("SIGTERM", () => { server.stop(true); process.exit(0) })
}
