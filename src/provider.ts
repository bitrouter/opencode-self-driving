// The public AISDK loader creates this factory before the language hook supplies the dispatcher.
export function createProvider() {
  return {
    languageModel() {
      throw new Error("Self-driving dispatcher is unavailable")
    },
  }
}
