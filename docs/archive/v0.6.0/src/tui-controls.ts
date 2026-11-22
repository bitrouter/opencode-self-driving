import type { Context } from "@opencode/plugin/tui/context"
import { Schema } from "effect"
import { decodeProfile, TIERS } from "./config.js"
import type { Pair, Profile } from "./config.js"
import { Status, Published } from "./rpc.js"

export type ControlsContext = Pick<Context, "client" | "location"> & {
  ui: Pick<Context["ui"], "dialog" | "toast"> & {
    router: Pick<Context["ui"]["router"], "current">
    panel: Pick<Context["ui"]["panel"], "open">
  }
  data: {
    session: Pick<Context["data"]["session"], "get" | "sync">
    location: Pick<Context["data"]["location"], "default">
  }
}

export function controls(context: ControlsContext, signal: AbortSignal, refresh: () => void) {
  type Input = Exclude<Parameters<Context["client"]["rpc"]["call"]>[0]["input"], undefined>
  const mutable = (value: Schema.Json): Input => {
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map((item: Schema.Json) => mutable(item))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutable(item)]))
  }
  const target = () => {
    const route = context.ui.router.current()
    const sessionID = route.type === "session" ? route.sessionID : undefined
    return {
      sessionID,
      location:
        (sessionID ? context.data.session.get(sessionID)?.location : undefined) ??
        context.location ??
        context.data.location.default(),
    }
  }
  const rpc = async (scope: ReturnType<typeof target>, method: string, input: Schema.Json = {}) => {
    signal.throwIfAborted()
    return (
      await context.client.rpc.call(
        { rpcID: "opencode-self-driving", method, input: mutable(input), location: scope.location },
        { signal },
      )
    ).output
  }
  const configuration = async (scope: ReturnType<typeof target>, edited?: Profile): Promise<void> => {
    const current =
      edited ??
      (await rpc(scope, "config").then((value) => {
        const result = Schema.decodeUnknownSync(
          Schema.Struct({ draft: Schema.optional(Published.fields.profile), published: Schema.optional(Published) }),
        )(value)
        return result.draft ?? result.published?.profile
      }))
    if (!current) {
      const input = await context.ui.dialog.prompt({
        title: "Self-driving profile",
        description: "Paste reviewed profile JSON. Use credential references; never paste API keys.",
        placeholder: "Reviewed profile JSON",
      })
      if (input === undefined) return
      const profile = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(input)
      return configuration(scope, decodeProfile(profile))
    }
    const action = await context.ui.dialog.select({
      title: `Self-driving · ${current.name}`,
      options: [
        {
          title: "Review profile",
          value: "review",
          description: "Bindings, budgets, thresholds and credential references",
        },
        {
          title: "Choose tier and auxiliary models",
          value: "models",
          description: "Available native models and variants",
        },
        {
          title: "Edit profile JSON",
          value: "edit",
          description: "Services, credential references, budgets, resources and approvals",
        },
        { title: "Save draft", value: "draft", description: "Keep the currently published profile active" },
        {
          title: "Publish reviewed profile",
          value: "publish",
          description: "Wait for active requests, validate and apply; Session policies reset",
        },
      ],
    })
    if (action === undefined) return
    if (action === "review") {
      await context.ui.dialog.alert({ title: "Profile review", message: review(current) })
      return configuration(scope, current)
    }
    if (action === "models") {
      const name = await context.ui.dialog.select({
        title: "Model assignment",
        options: [
          ...TIERS.map((tier) => ({ title: `${tier} · ${current.tiers[tier].model}`, value: tier, category: "Tiers" })),
          ...Object.entries(current.auxiliary).map(([kind, pair]) => ({
            title: `${kind} · ${pair.model}`,
            value: kind,
            category: "Auxiliary",
          })),
        ],
      })
      if (name === undefined) return configuration(scope, current)
      const tier = TIERS.find((tier) => tier === name)
      const kind = (["title", "compaction", "generate"] as const).find((kind) => kind === name)
      const pair = tier ? current.tiers[tier] : kind ? current.auxiliary[kind] : undefined
      if (!pair) return configuration(scope, current)
      const models = (await context.client.model.list({ location: scope.location })).data.filter(
        (model) => model.enabled && model.providerID === current.backends[pair.backend].providerID,
      )
      const id = await context.ui.dialog.select({
        title: `Native model · ${pair.backend}`,
        current: pair.model,
        options: models.map((model) => ({
          title: model.name,
          value: model.id,
          description: `${model.id} · context ${model.limit.context.toLocaleString()}`,
        })),
      })
      const selected = models.find((model) => model.id === id)
      if (!selected) return configuration(scope, current)
      const effort = await context.ui.dialog.select({
        title: "Native variant",
        current: pair.effort ?? "",
        options: [
          { title: "Model default", value: "" },
          ...selected.variants.map((variant) => ({ title: variant.id, value: variant.id })),
        ],
      })
      if (effort === undefined) return configuration(scope, current)
      const next: Pair = { backend: pair.backend, model: selected.id, ...(effort ? { effort } : {}) }
      return configuration(
        scope,
        tier
          ? { ...current, tiers: { ...current.tiers, [tier]: next } }
          : kind
            ? { ...current, auxiliary: { ...current.auxiliary, [kind]: next } }
            : current,
      )
    }
    if (action === "edit") {
      const input = await context.ui.dialog.prompt({
        title: "Edit profile",
        description: "Credential references only. Every budget and threshold is explicit.",
        value: JSON.stringify(current),
      })
      if (input === undefined) return configuration(scope, current)
      return configuration(scope, decodeProfile(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(input)))
    }
    if (
      action === "publish" &&
      !(await context.ui.dialog.confirm({
        title: "Publish self-driving profile",
        message: `${review(current)}\n\nPublish for this Location? Existing requests finish first; Session policies return to inherit / off.`,
      }))
    )
      return configuration(scope, current)
    await rpc(scope, "draft", { profile: Schema.decodeUnknownSync(Schema.Json)(current) })
    if (action === "publish") await rpc(scope, "publish")
    refresh()
    context.ui.toast.show({
      message: action === "publish" ? "Self-driving profile published" : "Self-driving draft saved",
      variant: "success",
    })
  }
  return async (input = "") => {
    const scope = target()
    await Promise.resolve()
      .then(async () => {
        const command = input.trim().toLowerCase()
        if (command === "config") return configuration(scope)
        if (command === "status") {
          refresh()
          if (scope.sessionID && context.ui.panel.open("self-driving")) return
          const status = Schema.decodeUnknownSync(Status)(
            await rpc(scope, "status", scope.sessionID ? { sessionID: scope.sessionID } : {}),
          )
          return context.ui.dialog.alert({
            title: "Self-driving",
            message: `${status.state} · ${status.enabled ? "enabled" : "disabled"}\nContext ${status.contextSelection} · approval ${status.approval}\n${scope.sessionID ? "Open the status panel from this Session." : "Open a Session to enable routing."}`,
          })
        }
        if (!["", "on", "off", "policies"].includes(command))
          return context.ui.dialog.alert({
            title: "Self-driving commands",
            message: "/self-driving [on | off | config | status | policies]",
          })
        const status = Schema.decodeUnknownSync(Status)(
          await rpc(scope, "status", scope.sessionID ? { sessionID: scope.sessionID } : {}),
        )
        if (status.state !== "configured") {
          if (command === "off" || command === "policies")
            return context.ui.dialog.alert({
              title: "Self-driving",
              message: "No profile is published. Use /self-driving config before enabling Session policies.",
            })
          await configuration(scope)
          if (command !== "" && command !== "on") return
          if (Schema.decodeUnknownSync(Status)(await rpc(scope, "status")).state !== "configured") return
        }
        if (!scope.sessionID)
          return context.ui.dialog.alert({
            title: "Self-driving",
            message: "Open a Session to enable routing or change its policies.",
          })
        if (command === "policies") {
          const contextSelection = await context.ui.dialog.select({
            title: "Context selection · this Session",
            current: status.contextSelection,
            options: [
              { title: "Inherit", value: "inherit" },
              { title: "Shadow", value: "shadow", description: "Observe suggestions; retain all resources" },
              { title: "Select", value: "select", description: "Omit only supported opt-in units" },
            ],
          })
          if (contextSelection === undefined) return
          const approval = await context.ui.dialog.select({
            title: "Tool approval · this Session",
            current: status.approval,
            options: [
              { title: "Off", value: "off" },
              { title: "Shadow", value: "shadow", description: "Observe suggestions; keep native ask" },
              {
                title: "Auto · supported MCP asks",
                value: "auto",
                description: "Only exact, supported evidence below the configured threshold",
              },
            ],
          })
          if (approval === undefined) return
          await rpc(scope, "policies", { sessionID: scope.sessionID, contextSelection, approval })
        } else await rpc(scope, command === "off" ? "disable" : "enable", { sessionID: scope.sessionID })
        await context.data.session.sync(scope.sessionID)
        refresh()
        context.ui.toast.show({
          message:
            command === "off"
              ? "Self-driving disabled; original model restored"
              : command === "policies"
                ? "Self-driving Session policies updated"
                : "Self-driving enabled; resource and approval policies are unchanged",
          variant: "success",
        })
      })
      .catch(() => {
        if (signal.aborted) return
        context.ui.toast.show({
          title: "Self-driving",
          message:
            "Could not apply the action. Check server plugin compatibility, profile, credentials and current status. Invalid profile input is not saved.",
          variant: "error",
        })
        refresh()
      })
  }
}

function review(profile: Profile) {
  const auth = (value: Profile["decision"]["auth"]) =>
    value.type === "env" ? `env ${value.name}` : `integration ${value.integrationID}`
  return [
    profile.name,
    `Decision: ${profile.decision.service} / ${profile.decision.model} · ${auth(profile.decision.auth)}`,
    `Decision endpoint: ${profile.decision.baseURL ?? "native default"}; accepted responses: ${profile.decision.allowedResponseModels.join(", ")}`,
    ...Object.entries(profile.backends).map(
      ([id, backend]) => `${id}: ${backend.service} / ${backend.providerID} · ${auth(backend.auth)}`,
    ),
    ...TIERS.map(
      (tier) =>
        `${tier}: ${profile.tiers[tier].backend} / ${profile.tiers[tier].model} / ${profile.tiers[tier].effort ?? "default"}`,
    ),
    ...Object.entries(profile.auxiliary).map(
      ([kind, pair]) => `${kind}: ${pair.backend} / ${pair.model} / ${pair.effort ?? "default"}`,
    ),
    `Output ${profile.outputTokens}; overhead ${profile.overheadTokens}; preparation ${profile.preparationTimeoutMs} ms`,
    `Evidence ${profile.evidence.mode}: ${profile.evidence.maxBytes} bytes / ${profile.evidence.maxTokens} token budget`,
    `Decision budget ${profile.decision.maxInputBytes} bytes / ${profile.decision.maxInputTokens} token budget`,
    `Resource threshold: ${profile.resources?.tauOmit ?? "not configured"}`,
    `Approval threshold: ${profile.approval?.tauAllow ?? "not configured"}; MCP: ${profile.approval?.mcpServers.join(", ") ?? "none"}`,
    ...(profile.approval
      ? [
          `Approval: ${profile.approval.timeoutMs} ms / ${profile.approval.maxBytes} bytes / ${profile.approval.maxTokens} token budget`,
        ]
      : []),
  ].join("\n")
}
