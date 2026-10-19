import { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { Schema } from "effect"
import { Status } from "./rpc.js"
import { controls } from "./tui-controls.js"
import { Footer, StatusView } from "./tui-view.js"

export default Plugin.define({
  id: "opencode-self-driving",
  setup(context) {
    const lifetime = new AbortController()
    context.ui.slot({ append: "app", render: () => <Connection context={context} signal={lifetime.signal} /> })
    return () => lifetime.abort()
  },
})

function Connection(props: { context: Plugin.Context; signal: AbortSignal }) {
  const dimensions = useTerminalDimensions()
  const [revision, update] = createSignal(0)
  const refresh = () => update((value) => value + 1)
  const scope = () => {
    const route = props.context.ui.router.current()
    const sessionID = route.type === "session" ? route.sessionID : undefined
    const location =
      (sessionID ? props.context.data.session.get(sessionID)?.location : undefined) ??
      props.context.location ??
      props.context.data.location.default()
    return { sessionID, location, revision: revision() }
  }
  const [result] = createResource(scope, async (target) => {
    return props.context.client.rpc
      .call(
        {
          rpcID: "opencode-self-driving",
          method: "status",
          input: target.sessionID ? { sessionID: target.sessionID } : {},
          location: target.location,
        },
        { signal: props.signal },
      )
      .then((value) => ({
        sessionID: target.sessionID,
        directory: target.location.directory,
        status: Schema.decodeUnknownSync(Status)(value.output),
        error: undefined,
      }))
      .catch(() => ({
        sessionID: target.sessionID,
        directory: target.location.directory,
        status: undefined,
        error: "Self-driving server unavailable. Check the server plugin and compatible V2 client.",
      }))
  })
  const current = () =>
    result()?.sessionID === scope().sessionID && result()?.directory === scope().location.directory
      ? result()
      : undefined
  const status = () => current()?.status
  const run = controls(props.context, props.signal, refresh)
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "self-driving.open",
        title: "Self-driving: enable or configure",
        group: "Self-driving",
        palette: true,
        slash: { name: "self-driving", arguments: true },
        run,
      },
      {
        id: "self-driving.config",
        title: "Self-driving: configuration",
        group: "Self-driving",
        palette: true,
        run: () => run("config"),
      },
      {
        id: "self-driving.status",
        title: "Self-driving: status",
        group: "Self-driving",
        palette: true,
        run: () => run("status"),
      },
      {
        id: "self-driving.off",
        title: "Self-driving: disable",
        group: "Self-driving",
        palette: true,
        run: () => run("off"),
      },
      {
        id: "self-driving.policies",
        title: "Self-driving: Session policies",
        group: "Self-driving",
        palette: true,
        run: () => run("policies"),
      },
    ],
  }))
  const colors = () => ({
    text: props.context.theme.text.base,
    muted: props.context.theme.text.muted,
    error: props.context.theme.text.feedback.error.base,
  })
  const remove = [
    props.context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={input.mode === "normal" && input.sessionID === scope().sessionID}>
          <Footer status={status()} loading={result.loading} compact={dimensions().width < 70} colors={colors()} />
        </Show>
      ),
    }),
    props.context.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === "self-driving" && input.sessionID === scope().sessionID}>
          <Panel context={props.context} input={input} status={status()} error={current()?.error} />
        </Show>
      ),
    }),
    props.context.data.listen(({ details }) => {
      if (details.type === "rpc.opencode-self-driving.configuration") {
        if ("location" in details && details.location?.directory === scope().location.directory) refresh()
        return
      }
      if (
        (details.type === "session.step.started" ||
          details.type === "session.step.ended" ||
          details.type === "session.step.failed" ||
          details.type === "session.execution.succeeded" ||
          details.type === "session.execution.failed" ||
          details.type === "session.execution.interrupted") &&
        details.data.sessionID === scope().sessionID
      )
        refresh()
    }),
  ]
  onCleanup(() => remove.forEach((dispose) => dispose()))
  return null
}

function Panel(props: { context: Plugin.Context; input: PanelInput; status?: typeof Status.Type; error?: string }) {
  props.context.keymap.layer(() => ({
    commands: [
      { id: "self-driving.close", title: "Close self-driving status", bind: "escape", run: props.input.close },
    ],
  }))
  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox flexGrow={1}>
        <StatusView
          status={props.status}
          error={props.error}
          colors={{
            text: props.context.theme.text.base,
            muted: props.context.theme.text.muted,
            error: props.context.theme.text.feedback.error.base,
          }}
        />
      </scrollbox>
      <text fg={props.context.theme.text.action.secondary.base} paddingLeft={1} onMouseUp={props.input.close}>
        esc close
      </text>
    </box>
  )
}
