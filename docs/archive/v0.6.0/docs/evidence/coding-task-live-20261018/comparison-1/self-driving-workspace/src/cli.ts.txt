import { importCsv } from "./import"

try {
  console.log(JSON.stringify(importCsv(await Bun.file(process.argv[2]).text())))
} catch {
  console.error("Invalid CSV")
  process.exitCode = 1
}
