# Repository boundaries

- Use existing public OpenCode plugin / AI APIs only. Do not modify or import host Core, Server, Protocol, generated client code, or private runtime implementations. SDK is development-only.
- Core owns Sessions, history, tools, retries, compaction and recovery. Stateful observer and plugin recovery remain deferred.
- Use Bun 1.4.2 and a compatible dependency-installed OpenCode checkout; see `docs/development.md`. Run `bun run check` from this package. Never edit `dist/` directly.
- Keep credentials and raw artifacts local. Real provider calls require an explicitly authorized, bounded plan; never automatically rerun paid failures.
- Preserve failed live results. HTTP success, Session completion, local checks, hosted CI and task quality are separate claims.
- Keep current guides and verification in `docs/`; historical phase snapshots belong in `docs/archive/`. Update links when moving files.
- The default branch is `dev`. Use short hyphenated branch names and conventional commit messages. No Changesets.
