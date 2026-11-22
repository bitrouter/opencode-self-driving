# Local connector verification

Date: 2026-11-22. This page covers `0.7.0-dev.0`; it does not reuse historical
qualification claims.

## Environment

- macOS arm64, Bun **1.4.2**.
- Public `@opencode/plugin` / `@opencode/sdk` **2.3.2**.
- BitRouter **1.0.0-alpha.36**, gateway profile, revision
  `5feee26e714bd58e9a77371d4709e4a24888d5af`.

## Executed checks

```sh
bun install --frozen-lockfile --ignore-scripts
BITROUTER_TEST_BINARY=/absolute/path/bro bun run check
BITROUTER_TEST_BINARY=/absolute/path/bro bun run test -- --rerun-each 3 --randomize --seed=237911
git diff --check
```

| Check | Result |
| --- | --- |
| Types, bundles, declarations, runtime dependency boundaries | Passed |
| Full suite, including real BitRouter → loopback upstream | **25 pass, 0 fail** |
| Randomized order, three runs per test | **75 pass, 0 fail** |
| Installed package in the real OpenCode 2.3.2 SDK | Passed; peer explicitly linked offline |
| Automatic registration, project default, manual original-model selection, streamed generation, unload | Passed; local fixture responses |
| JSONC comments/later edits, per-project backups, restoration, symlink protection | Passed |
| Credential rotation/logout, resolution after slow uploads, cancellation, concurrency, generation draining | Passed; fake credentials |
| Unauthorized request to BitRouter's inner HTTP ingress | 401; no upstream request |
| Native Claude subscription adapter with an access-only lease | Passed; local simulated upstream only |
| Historical snapshots compared with the pre-refactor Git HEAD | 178 matching files, including failed live results |
| Git diff whitespace check | Passed |
| Current README/guides: English text and local links | 7 Markdown files checked; no issues |
| Pre-publication secret scan | Gitleaks 8.30.1: no findings in existing Git history or staged changes |

The SDK fixture disables file watching and explicitly reloads the Location to
load the project default edit. This does not establish real-client file-watching
or GUI/TUI behavior. Without `BITROUTER_TEST_BINARY`, the two real-process tests
explicitly skip.
Secret scanning is a preventive check, not proof that every possible sensitive
value has been detected. Scanner reports and raw check logs remain local.

## Not qualified

- No real-account login, paid model request, or real-subscription end-to-end request.
- No training or evaluation of task-difficulty-aware selection; bootstrap remains
  a conservative starting point using the previous default.
- No evidence of coding-task quality, subscription quota benefits, or cost savings.
- These results are local, not hosted CI. The npm package has not been published.

HTTP success, SDK generation completion, and passing local checks do not qualify
any of the outcomes above.
