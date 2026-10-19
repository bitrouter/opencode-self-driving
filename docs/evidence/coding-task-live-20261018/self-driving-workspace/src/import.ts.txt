import { parseCsv } from "./csv"

export function importCsv(text: string): Record<string, string>[] {
  const [headers, ...rows] = parseCsv(text)
  if (!headers) return []
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])))
}
