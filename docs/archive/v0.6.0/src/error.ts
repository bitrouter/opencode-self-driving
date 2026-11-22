import { APICallError } from "@ai-sdk/provider"

export function invalid(message: string) {
  // AI SDK errors use a cross-package marker; bundled AIError classes fail the host's instanceof check.
  return new APICallError({
    message,
    url: "self-driving://request",
    requestBodyValues: undefined,
    statusCode: 400,
    isRetryable: false,
  })
}
