import { expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import { evidence } from "../src/evidence"
import { profile } from "./routing-fixture"

test("bounded evidence keeps constraints and complete tool exchanges with reproducible omissions", () => {
  const configuration = profile("http://127.0.0.1")
  const event = {
    sessionID: "fixture",
    model: { id: "auto", providerID: "self-driving" },
    options: {},
    system: [{ type: "text" as const, text: "Required system policy" }],
    messages: [
      Message.user("Original user constraint"),
      Message.assistant("old history".repeat(500)),
      Message.user("Current task"),
      Message.assistant([{ type: "tool-call", id: "call-1", name: "echo", input: { value: 1 } }]),
      Message.tool({ id: "call-1", name: "echo", result: { type: "text", value: "evidence" } }),
    ],
  }
  const bounded = { ...configuration, evidence: { ...configuration.evidence, maxBytes: 2_000, maxTokens: 3_000 } }
  const first = evidence(bounded, event, ["medium", "high"])
  expect(first).toEqual(evidence(bounded, event, ["medium", "high"]))
  expect(first.omitted).toEqual([{ start: 0, end: 1 }])
  expect(JSON.stringify(first.state)).toContain("Original user constraint")
  expect(JSON.stringify(first.state)).toContain("call-1")
  expect(JSON.stringify(first.state)).not.toContain("old historyold history")
  expect(() =>
    evidence({ ...bounded, evidence: { ...bounded.evidence, mode: "full" } }, event, ["medium", "high"]),
  ).toThrow()
})

test("required evidence is never silently truncated to fit", () => {
  const configuration = profile("http://127.0.0.1")
  expect(() =>
    evidence(
      { ...configuration, evidence: { ...configuration.evidence, maxBytes: 20 } },
      {
        system: [{ type: "text", text: "Required constraints" }],
        messages: [Message.user("Task")],
      },
      ["low", "high"],
    ),
  ).toThrow()
})
