# Development and testing

Use Bun **1.4.2**, public npm dependencies, and the checked-in lockfile.
An OpenCode source checkout is no longer required.

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs TypeScript checks, server/RPC bundling, declaration generation,
runtime dependency boundary checks, and tests with isolated HOME/XDG directories.
`jsonc-parser` is a build-time dependency bundled into the output. The OpenCode
plugin API remains external; the SDK is development-only and must not enter the
runtime bundle.

Default tests cover catalog discovery, source classification, credential rotation,
file permissions, concurrency, failures, cancellation, policy boundaries, and
reversible JSONC default-model edits. The real 2.3.2 SDK tests offline package
loading, automatic registration, original-model selection, and unload. Subprocess
fixtures verify lifecycle behavior, not selection quality. The test tarball
explicitly links the installed 2.3.2 peer to avoid hidden network access during
offline installation.

To test a real BitRouter process against local HTTP fixtures:

```sh
BITROUTER_TEST_BINARY=/absolute/path/bro bun run check
```

Without this variable, these tests explicitly skip rather than report success.
They validate generated YAML/policy, a local API-key request, and access-only
Claude subscription adaptation. They do not use real provider credentials or send
test prompts to providers. Do not run the archived paid qualification tools.
`bunfig.toml` limits discovery to the active `test/` directory, and the preload
rejects unisolated direct `bun test` runs so the SDK fixture cannot discover real
provider credentials from the service environment. Use the scripts above.

Real-account connectivity, representative coding tasks, task-difficulty routing,
and subscription quota or cost benefits require separately authorized, bounded
tests and independent acceptance. The historical 128 tests belong to the old
implementation and are not counted here. See [local verification results](verification.md)
for the environment, counts, and unverified scope.
