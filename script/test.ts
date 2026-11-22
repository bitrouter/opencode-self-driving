import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = await mkdtemp(join(tmpdir(), "opencode-bitrouter-tests-"))
try {
  const child = Bun.spawn([process.execPath, "test", "./test", "--timeout", "60000", ...process.argv.slice(2)], {
    env: {
      PATH: process.env.PATH,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"), TMPDIR: home, TMP: home, TEMP: home,
      OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_BITROUTER_TEST_SANDBOX: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true",
      ...(process.env.BITROUTER_TEST_BINARY ? { BITROUTER_TEST_BINARY: process.env.BITROUTER_TEST_BINARY } : {}),
      CI: "true",
    },
    stdout: "inherit", stderr: "inherit",
  })
  process.exitCode = await child.exited
} finally {
  await rm(home, { recursive: true, force: true })
}
