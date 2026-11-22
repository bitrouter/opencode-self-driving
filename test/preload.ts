if (process.env.OPENCODE_BITROUTER_TEST_SANDBOX !== "1" ||
  !process.env.OPENCODE_TEST_HOME || process.env.HOME !== process.env.OPENCODE_TEST_HOME)
  throw new Error("Run tests through bun run test/check: inherited provider credentials must not enter the SDK fixture")
