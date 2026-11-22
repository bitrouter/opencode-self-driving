# Configuration and operation

The plugin reads the effective public provider/model catalogs and active
integration connections for the current Location. It does not scrape the
OpenCode database, authentication files, or the entire models.dev catalog.
Disabled models, unavailable providers, and models that are not tool-capable chat
models do not enter the routing pool. `bitrouter`, the old `self-driving`
provider, and endpoints pointing back to this plugin are excluded to prevent recursion.

## Options

| Field | Default | Purpose |
| --- | --- | --- |
| `command` | `["bro"]` | Executable and fixed leading arguments; no shell |
| `stateDirectory` | `$XDG_STATE_HOME/opencode-bitrouter` | Parent of private generated directories |
| `startupTimeoutMs` | `30000` | Total deadline for local validation, key creation, and startup |
| `policyFile` | None | User-owned v4 policy lock, copied without modifying the source |
| `decision` | None | `{ model, baseURL?, apiKeyEnv }` for a BitRouter TypeSafe-compatible backend |

If XDG state is unset, `stateDirectory` defaults to
`~/.local/state/opencode-bitrouter`. Relative `stateDirectory` and `policyFile`
paths resolve against the current Location, not the remote client's directory or
the shared service's working directory.
`decision.baseURL` defaults to `https://api.typesafe.ai` and supports only
BitRouter's native typed-decision protocol. Changing a URL does not make an
OpenRouter/Jev protocol compatible. `apiKeyEnv` names an environment variable on
the server, not a credential value. Enabling this connection can incur decision
costs during normal inference.

Old profile, tiers, resource/approval, and other unknown options are rejected
rather than silently reinterpreted.

## Synchronization

Each instance owns an isolated BitRouter process and a mode-0700 directory. It
does not edit the user's BitRouter YAML or stop a shared daemon. It generates
`bitrouter.yaml`, `policy-lock.yaml`, and temporary credential snapshots.
Generated configuration and credential files use mode 0600. The Unix control
socket uses a separate short path to avoid macOS socket-path limits.

Generated configuration disables registry/default inheritance, automatic
discovery, trajectories, and server tools. Model IDs, endpoints, headers,
tool/image capabilities, capacities, and available single-tier prices come from
the original catalog. Subscription/local sources are not assigned invented
per-token prices. Unmapped model/provider bodies, settings (including explicit
timeouts that cannot be expressed equivalently), compatibility flags, custom
packages, AWS/ADC, and external authentication are reported in `excluded`.
`maxTokensField` and `streamUsage` have explicit compatibility mappings.
Non-default variants are not expanded into separate candidates; arbitrary
reasoning parameters are not assumed equivalent across protocols.

New configuration passes `config validate` and a non-inference `route` check
before startup and health readiness. A successful generation atomically replaces
the backend behind the plugin's stable HTTP ingress. Existing streams keep their
old process until they drain. Both HTTP layers require private credentials:
BitRouter uses a local database-backed virtual key, and the outer ingress uses
an instance-specific random token. Upstream credentials are not sent to
OpenCode's BitRouter provider. Normal cancellation, failures, and unload release
owned processes, streams, and files. Crash leftovers are not treated as recovery state.

The connector observes catalog/credential events and rereads active connections
before each dispatch so missed events do not authorize continued use of old
logins. A failed update retains the previous generation for diagnosis/recovery
but blocks new automatic dispatch rather than using stale accounts. Original
model paths are unaffected. Requests are limited to 16 MiB. The connector
forwards only the native Chat Completions entrypoint; it does not parse or rewrite
generation streams, run an LLM loop, or automatically retry an already-started stream.

## Subscriptions

Subscription adapters are selected from the active credential type and canonical
provider, not just a display name: OpenAI OAuth → `openai-codex`, Anthropic OAuth
→ `claude-code`, and GitHub Copilot OAuth → `github-copilot`. BitRouter performs
its native protocol/authentication adaptation. OpenCode Go's key-based
subscription retains its original endpoint/key and is also labeled subscription;
a key credential does not make it a per-token API account.

OpenCode resolves and refreshes the original connection. Access tokens are
exported only while the lease is valid. Snapshots never contain refresh tokens,
and BitRouter does not refresh or overwrite an OpenCode login. Account switches,
logout, and expiry are reconciled on the next synchronization; requests already
accepted upstream cannot be revoked. Upstream 401s are not blindly retried.
Importing multiple distinct provider aliases/accounts into the same native
subscription adapter is currently rejected to prevent account mixing. Copilot's
own GitHub-to-Copilot short-lived token exchange belongs to its native adapter;
it does not transfer refresh-token ownership.

Real-account compatibility is not qualified. The native Claude subscription
adapter is covered against a local simulated upstream, which does not qualify
all providers or accounts.

## Default model and restoration

An explicit model in OpenCode 2.3.2's built-in configuration layer overrides a
plugin transform's default suggestion. After successful setup, the connector
therefore makes one reversible field edit in the project's
`.opencode/opencode.json(c)`. It does not change global configuration, providers,
models, agents, or permissions. In that directory, it prefers an existing JSONC
file, then JSON, otherwise creates JSONC. Normal configuration reload applies
the change without switching existing session selections. Higher-priority
system-managed configuration remains authoritative.

The original field's presence, value, and path are saved in plugin storage under
a record isolated by Location path. Reloads do not overwrite the backup, and
later user edits to `model` are not overridden. `/bitrouter-restore` or the
`restore` RPC restores the field only if it still equals `bitrouter/auto`, while
preserving other edits. Only an otherwise-empty configuration file created by
the connector is removed. A restoration marker prevents automatic reenabling on
reload. **Restore before uninstalling:** cleanup cannot distinguish an ordinary
reload from removal, so it does not rewrite configuration and cause reload
loops. Symlinked configuration files/directories are not replaced.

## RPC

The RPC ID is `opencode-bitrouter`. Its public `Contract` is exported from
`opencode-self-driving/rpc`.

| Method | Input | Behavior |
| --- | --- | --- |
| `status` | `{}` | Reconcile local state and return ready/unavailable, sources, and exclusion reasons |
| `sync` | `{}` | Synchronize explicitly; no generation-model call |
| `restore` | `{}` | Restore the default model without deleting original providers/models |

Use `client.rpc(Contract)` or native `client.rpc.call` with the current Location.
Status does not return key/token/header values, raw requests, provider responses,
or subprocess logs.

## Policy

Bootstrap maps the imported pool to stably named tiers with `context: preserve`
and empty routes. There are no pretrained routes, evaluation certificates, or
self-learning. The previous default is the conservative starting point when
available; other actions are not validated task routes. Composite capacity
reflects the candidates' common safe limits. Composite pricing is unknown, not
a physical upstream bill.

`policyFile` must be an existing user-owned v4 lock containing an `auto` policy.
Every action must remain within the current imported pool and preserve context.
BitRouter still validates full syntax, certificates, and runtime applicability.
The connector does not fabricate a published policy or invent quality data for
an arbitrary model pool.
