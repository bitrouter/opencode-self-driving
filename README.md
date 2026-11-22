# opencode-self-driving

Automatically connect existing OpenCode **2.3.2** model sources to a local
BitRouter. This first release focuses only on model connectivity and routing:

```text
Existing OpenCode providers / models / active connections
  → Generate isolated BitRouter YAML and policy
  → Register bitrouter/auto and set the project default
  → Let local BitRouter select, adapt, and forward requests
```

All original models remain manually selectable. OpenCode still owns tools,
permissions, context, compaction, and sessions. The plugin has no model-selection
engine, context filtering, automatic approvals, self-learning, or second agent loop.

## Installation

Requires Bun **1.4.2**, OpenCode **2.3.2**, and a BitRouter `bro` binary with
the current router and policy v4 interfaces. The local integration baseline is
BitRouter **1.0.0-alpha.36**, revision
`5feee26e714bd58e9a77371d4709e4a24888d5af`. Older CLI versions are not qualified.

```sh
bun install --frozen-lockfile
bun run check
```

Add the complete built plugin directory to your OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/opencode-self-driving",
    "options": { "command": ["/absolute/path/bro"] }
  }]
}
```

Omit `options` if `bro` is on your PATH. There are no five-tier model profiles
or duplicate API keys to configure.

**Default-model change:** after successful setup, the connector changes only the
project's `.opencode/opencode.json(c)` `model` field to `bitrouter/auto`. It
preserves other fields and JSONC comments and saves the original value in plugin
storage. If no file exists, it creates `.opencode/opencode.jsonc`. Existing session
selections and explicit agent or command models are not switched.
Run **`/bitrouter-restore` before removing the plugin**. Restoration never
overwrites a later user-selected default.

## Sources and boundaries

- **BYOK:** reuse active keys, endpoints, model mappings, and headers.
- **Subscription:** native OpenAI → Codex, Anthropic → Claude Code, and Copilot
  adapters. OpenCode alone owns refresh; BitRouter receives temporary access-only
  snapshots, never refresh tokens.
- **Local:** Ollama, LM Studio, vLLM, and compatible local HTTP services.

This is not a universal translator for arbitrary provider packages. Unknown
authentication, external credentials, unsupported body/settings overrides, and
unknown capacities are reported in `excluded`, not silently replaced with a
different billing source. Files and routing run on the OpenCode server machine;
upstream traffic goes to the imported endpoints, not automatically to BitRouter Cloud.

**Policy limitations:** generated policy is a conservative bootstrap. Imported
models become candidate actions, initially using the previous default, or the
first eligible model in stable order if that default is unavailable. No quality
scores or evaluation certificates are fabricated. A YAML configuration and model
list alone do not provide task-difficulty-aware routing. Optional `policyFile`
and `decision` settings connect an evaluated policy and compatible decision
backend; without those prerequisites, there is no claim of intelligent selection,
better quality, or cost savings.

## Documentation and verification

- [Configuration, RPC, credentials, and policy](docs/configuration.md)
- [Installation, restoration, and migration](docs/installation.md)
- [Development and testing](docs/development.md)
- [Local verification results](docs/verification.md)
- [Architecture and boundaries](docs/spec.md)
- [Historical implementation and failed live runs](docs/archive/v0.6.0/README.md):
  preserved in their original language, excluded from build and package output.

The npm package is marked `private` and has not been published. Real-account
connectivity, representative coding quality, and cost benefits are not qualified;
offline and loopback checks do not establish those outcomes.
