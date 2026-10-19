import { expect, test } from "bun:test"
import { model } from "@opencode/ai/providers/openrouter"
import { requestFromCall } from "../src/bridge"

test("mixed text and media tool results remain unsupported", () => {
  expect(() =>
    requestFromCall(model("offline-model", { apiKey: "offline-fixture" }), {
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "offline-call",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "An image follows" },
                  { type: "image-data", data: "AAAA", mediaType: "image/png" },
                ],
              },
            },
          ],
        },
      ],
    }),
  ).toThrow("Multimodal and denied tool results are unsupported")
})
