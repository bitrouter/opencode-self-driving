# CSV import repair task

Repair `src/csv.ts` and `src/import.ts` so the existing CSV-to-JSON CLI works correctly. Keep the exported APIs and use no dependencies. Do not modify any other file.

`parseCsv(text)` must return rows of string fields. An empty string is zero rows. Support LF and CRLF record separators, commas inside double-quoted fields, LF/CRLF inside quoted fields, and doubled double quotes as escaped quotes. Preserve all field whitespace and embedded line endings. Strip one optional UTF-8 BOM at the beginning of the input only. Preserve empty fields and empty records. A final record separator terminates the last record without adding another row: `a\n` is one row, `a\n\n` is two rows, and `\n` is one row containing one empty field.

Quotes may start only at the beginning of a field. After a closing quote, only a comma, record separator, or end of input is legal. Reject unterminated quoted fields, quotes in unquoted fields, characters after a closing quote, and bare CR outside quoted fields by throwing `Error`. Bare CR inside a quoted field is data.

`importCsv(text)` must use the first row as headers and return objects for subsequent rows. Reject empty header names, duplicate header names, and any data row whose field count differs from the header count. Preserve header spelling and field strings, including surrounding spaces. A header-only input returns an empty array. Header names such as `__proto__` and `constructor` must work as ordinary own data properties.

Read the source and visible tests, fix both implementation files, and run `bun test`. The available tools are native `read`, `edit`, `write`, and `shell`. Shell is limited to `bun test` (or `bun test test`) in this project. Finish with a short description of the changes and test result. Additional independent acceptance tests will run after the session ends.
