# Coding task experiment

Development-only real OpenCode Sessions against an isolated CSV-import repair project. This experiment is separate from the text / MCP qualifier and excluded from the published runtime package.

- `fixture/` is intentionally broken input; do not repair it while maintaining the benchmark.
- `fixture/test/csv.test.ts.txt` becomes a visible Bun test in the project. The suffix prevents normal plugin test discovery.
- `acceptance.test.ts.txt` is independently frozen. Copy it to a temporary `acceptance.test.ts` outside the project, then run it after the Session with `CODING_TASK_ROOT` pointing at the resulting project. Keep its bytes unchanged and do not expose it to the agent.
- `worker.ts` uses the public SDK and native catalogs, loading the built self-driving plugin only in that arm. The existing bounded qualification relay meters requests. Core executes all tools and Steps.

From the plugin directory with qualified Bun 1.4.2:

```sh
bun script/coding-benchmark/worker.ts baseline /path/to/new-artifacts /path/to/frozen-plan.json
bun script/coding-benchmark/worker.ts self-driving /path/to/new-artifacts /path/to/frozen-plan.json
```

Without `--execute`, initialization sends no provider requests. Live execution requires `--execute`, a reviewed qualification plan and `OPENROUTER_TEST_KEY` supplied only through the environment. Baseline uses fixed native `openai/gpt-4.1-mini`; self-driving uses the plan's existing pool.

The caller must create an empty temporary `OPENCODE_BENCH_HOME`, isolate HOME / XDG / TMP / config / database paths as in `script/qualify.ts`, set `OPENCODE_TEST_HOME`, disable models fetch / file watching, and keep Bun 1.4.2 on PATH. Use a fresh environment per arm and remove it after the worker closes. The worker removes the credential from its environment before exposing tools and copies only known task files to artifacts.

Freeze task, source / acceptance hashes, model pairs and budgets before execution. Preserve prior artifacts and do not automatically rerun paid failures. If a module fails to load before JUnit output exists, record zero executed cases and the load error rather than pretending the planned assertions ran.

See [编码任务对照](../../docs/validation/coding-task-live.md) for this run's sequence, budgets, negative results and bridge fix. This is a focused experiment, not a general benchmark or another runtime API.
