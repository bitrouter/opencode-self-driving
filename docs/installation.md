# Installation and migration

The verified OpenCode, plugin API, and SDK version is **2.3.2**. Development uses
Bun **1.4.2**. The BitRouter baseline is **1.0.0-alpha.36**, revision
`5feee26e714bd58e9a77371d4709e4a24888d5af`, built with the gateway profile.
It must support `config validate`, `route`, `key sign`, `serve`, and policy v4.
The plugin does not download or globally install BitRouter. Compatibility with
alpha.33 or arbitrary 1.x builds is not claimed.

```sh
bun install --frozen-lockfile
bun run check
```

Add the complete built directory to `plugins`, as shown in the
[README](../README.md#installation). Use `options.command` to supply an absolute
path to `bro` if needed. Keep existing provider/model configuration and logins;
they do not need migration. The plugin has server and RPC entrypoints only, with
no TUI peer, runtime SDK, or runtime vendor SDK. OpenCode's native compatible
provider handles its side of requests; BitRouter handles upstream protocols.

When installing a tarball, install the declared `@opencode/plugin@2.3.2` peer.
Skipping it with `--legacy-peer-deps` does not produce a complete installation.

The 0.6.0 configuration, RPC, and TUI are incompatible. Commands under
`/self-driving config/on/policies`, old profiles, and `self-driving/auto` are no
longer used. Original source, experiments, and failed results are preserved in
[the archive](archive/v0.6.0/README.md), excluded from packages and current
qualification. Finish or interrupt active sessions at a safe host boundary before
updating. Historical virtual-model sessions are not migrated.

## Default model and removal

Successful setup automatically sets the project default. Original models remain
manually selectable in `/models`. Before removing the plugin, run
`/bitrouter-restore` or invoke the `restore` method on the `opencode-bitrouter` RPC.
Restoration preserves later user edits and prevents reload from automatically
enabling the default again.

Removing the plugin without restoring leaves a `bitrouter/auto` reference in the
project configuration. In that case, manually change the project's `model` back
to the original model. No system-wide provider is installed, and original logins
are not deleted. Do not delete the OpenCode database or account credentials to
fix a plugin-loading problem.
