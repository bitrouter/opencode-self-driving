import type { RGBA } from "@opentui/core"
import { For, Show } from "solid-js"
import type { Status } from "./rpc.js"

export type Colors = { text: RGBA; muted: RGBA; error: RGBA }

export function StatusView(props: { status?: typeof Status.Type; error?: string; colors: Colors }) {
  const route = () => props.status?.lastRoute
  return (
    <box flexDirection="column" gap={1} padding={1}>
      <text fg={props.colors.text}>Self-driving</text>
      <Show when={props.error}>
        <text fg={props.colors.error} wrapMode="word">
          {props.error}
        </text>
      </Show>
      <Show
        when={props.status}
        fallback={
          <Show when={!props.error}>
            <text fg={props.colors.muted}>Loading status…</text>
          </Show>
        }
      >
        {(status) => (
          <>
            <text fg={props.colors.text} wrapMode="word">
              {status().state === "configured"
                ? status().enabled
                  ? "Enabled for this Session"
                  : "Configured · disabled for this Session"
                : "Not configured · /self-driving config"}
            </text>
            <text fg={props.colors.muted} wrapMode="word">
              Context: {status().contextSelection} · Approval: {status().approval}
            </text>
            <Show when={status().limit}>
              {(limit) => (
                <text fg={props.colors.text} wrapMode="word">
                  Window: input {limit().input.toLocaleString()} · context {limit().context.toLocaleString()} · output{" "}
                  {limit().output.toLocaleString()} · UTF-8 byte estimate
                </text>
              )}
            </Show>
            <Show when={status().lifecycle?.applying}>
              <text fg={props.colors.muted} wrapMode="word">
                Applying configuration; new requests wait for an explicit retry.
              </text>
            </Show>
            <Show when={status().lifecycle && !status().lifecycle?.available}>
              <text fg={props.colors.error} wrapMode="word">
                Lifecycle unavailable · reload the server plugin.
              </text>
            </Show>
            <Show when={route()}>
              {(value) => (
                <>
                  <text fg={props.colors.text} wrapMode="word">
                    Last request: {value().kind} · {value().tier ?? "fixed"} · {value().selection}
                  </text>
                  <text fg={props.colors.text} wrapMode="word">
                    Physical target: {value().backend} / {value().physicalModel}
                    {value().effort ? ` · effort ${value().effort}` : ""}
                  </text>
                  <text fg={props.colors.muted} wrapMode="word">
                    Eligible: {value().eligibleTiers.join(", ") || "fixed pair"}
                  </text>
                  <For each={value().excluded}>
                    {(excluded) => (
                      <text fg={props.colors.muted} wrapMode="word">
                        Excluded {excluded.tier}: {excluded.reason}
                      </text>
                    )}
                  </For>
                  <Show when={value().decision}>
                    {(decision) => (
                      <text fg={props.colors.muted} wrapMode="word">
                        Decision: {decision().service} / {decision().responseModel} · confidence{" "}
                        {decision().confidence ?? "unknown"} (diagnostic)
                      </text>
                    )}
                  </Show>
                  <Show when={value().resources}>
                    {(resource) => (
                      <text fg={props.colors.text} wrapMode="word">
                        Resources: {resource().outcome} · omitted {resource().omitted.join(", ") || "none"} · proposed{" "}
                        {resource().proposed.join(", ") || "none"}
                        {resource().reason ? ` · ${resource().reason}` : ""}
                      </text>
                    )}
                  </Show>
                  <text fg={props.colors.muted} wrapMode="word">
                    Generation tokens: input {value().generationUsage?.inputTokens ?? "unknown"} · output{" "}
                    {value().generationUsage?.outputTokens ?? "unknown"}
                  </text>
                </>
              )}
            </Show>
            <Show when={status().lastApproval}>
              {(approval) => (
                <text fg={props.colors.text} wrapMode="word">
                  Last approval: {approval().outcome} · p(needs human) {approval().probability ?? "unknown"} ·{" "}
                  {approval().reason}
                </text>
              )}
            </Show>
            <Show when={status().lastFailure}>
              {(failure) => (
                <text fg={props.colors.error} wrapMode="word">
                  Last failure ({failure().kind}): {failure().message}
                </text>
              )}
            </Show>
            <text fg={props.colors.muted} wrapMode="word">
              Core records the composite model. Its cost is an estimate; physical billing is unknown.
            </text>
            <text fg={props.colors.muted} wrapMode="word">
              /self-driving config · policies · off
            </text>
          </>
        )}
      </Show>
    </box>
  )
}

export function Footer(props: { status?: typeof Status.Type; loading?: boolean; compact: boolean; colors: Colors }) {
  return (
    <text fg={props.colors.muted}>
      {props.compact ? "SD:" : "Self-driving: "}
      {props.loading
        ? "…"
        : !props.status
          ? "unavailable"
          : props.status.enabled
            ? (props.status.lastRoute?.tier ?? "on")
            : props.status.state === "configured"
              ? "off"
              : "configure"}
    </text>
  )
}
