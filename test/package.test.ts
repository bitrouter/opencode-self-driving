import { afterAll, expect, test } from "bun:test"
import { resolve } from "node:path"
import { readdir, realpath } from "node:fs/promises"
import { Schema } from "effect"
import { Status } from "../src/rpc"
import { host, install, poison } from "./fixture"

const installed = await install()
afterAll(() => installed[Symbol.asyncDispose]())

const expected = {
  version: "0.6.0-dev.0",
  state: "unconfigured",
  enabled: false,
  contextSelection: "inherit",
  approval: "off",
} as const

test("built local directory loads through ordinary configuration without adding a model", async () => {
  await using proof = await host(resolve(import.meta.dir, ".."))
  expect(Schema.decodeUnknownSync(Status)((await proof.status()).output)).toEqual(expected)
  const plugins = await proof.plugins()
  expect(plugins.data.find((plugin) => plugin.id === "opencode-self-driving")).toMatchObject({
    state: { status: "active" },
    features: { rpc: true },
  })
  const models = await proof.client.model.list({ location: { directory: proof.directory } })
  expect(models.data.some((model) => model.providerID === "self-driving")).toBe(false)
})

test("offline-installed tarball is relocatable and exposes only compiled package entrypoints", async () => {
  const files = await readdir(installed.package)
  expect(files.sort()).toEqual([
    "README.md",
    "dist",
    "docs",
    "examples",
    "package.json",
    "rpc.js",
    "server.js",
    "tui.js",
  ])
  expect(await Bun.file(resolve(installed.package, "docs/installation.md")).exists()).toBe(true)
  expect(await Bun.file(resolve(installed.package, "docs/README.md")).exists()).toBe(true)
  expect(await realpath(Bun.resolveSync("opencode-self-driving/server", installed.directory))).toBe(
    resolve(installed.package, "server.js"),
  )
  expect(await realpath(Bun.resolveSync("opencode-self-driving/rpc", installed.directory))).toBe(
    resolve(installed.package, "rpc.js"),
  )
  expect(await realpath(Bun.resolveSync("opencode-self-driving/tui", installed.directory))).toBe(
    resolve(installed.package, "tui.js"),
  )
  await using proof = await host(installed.package)
  expect((await proof.plugins()).data.filter((plugin) => plugin.source.type === "local")).toContainEqual(
    expect.objectContaining({ id: "opencode-self-driving", state: { status: "active" } }),
  )
  expect(Schema.decodeUnknownSync(Status)((await proof.status()).output)).toEqual(expected)
  expect((await proof.plugins()).data.find((plugin) => plugin.id === "opencode-self-driving")?.state.status).toBe(
    "active",
  )
})

test("direct and transitive Effect imports use the host despite poisoned private copies", async () => {
  await using altered = await poison(installed.package)
  await using proof = await host(altered.package)
  expect(Schema.decodeUnknownSync(Status)((await proof.status()).output)).toEqual(expected)
  expect((await proof.plugins()).data.find((plugin) => plugin.id === "opencode-self-driving")?.state.status).toBe(
    "active",
  )
})

test("removing and restoring normal configuration unloads RPC and permits clean registration again", async () => {
  await using proof = await host(installed.package)
  expect((await proof.status()).output).toEqual(expected)
  await proof.enable(false)
  expect((await proof.plugins()).data.some((plugin) => plugin.id === "opencode-self-driving")).toBe(false)
  await expect(proof.status()).rejects.toThrow()
  await proof.enable(true)
  expect((await proof.status()).output).toEqual(expected)
  expect((await proof.plugins()).data.filter((plugin) => plugin.id === "opencode-self-driving")).toHaveLength(1)
})

test("unsupported options fail before registering status or silently enabling a policy", async () => {
  await using proof = await host(installed.package, { approval: "auto", token: "SECRET_MUST_NOT_APPEAR" })
  const plugins = await proof.plugins()
  expect(
    plugins.data.find((plugin) => plugin.source.type === "local" && plugin.source.path.includes(installed.package))
      ?.state.status,
  ).toBe("failed")
  expect(JSON.stringify(plugins)).not.toContain("SECRET_MUST_NOT_APPEAR")
  await expect(proof.status()).rejects.toThrow()
})
