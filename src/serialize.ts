/** Machine output: pure serialization, no ANSI or human framing. */
export type Row = Record<string, unknown>;
const cell = (value: unknown): string => {
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export function csv(
  rows: Row[],
  columns = [...new Set(rows.flatMap(Object.keys))],
): string {
  return [...csvChunks(rows, columns)].join("");
}
export function* csvChunks(
  rows: Iterable<Row>,
  columns: string[],
): Generator<string> {
  yield columns.map(cell).join(",") + "\r\n";
  for (const row of rows)
    yield columns.map((key) => cell(row[key])).join(",") + "\r\n";
}
export function* serializeRows(
  rows: Iterable<Row>,
  format: "json" | "ndjson" | "csv",
  columns: string[],
): Generator<string> {
  if (format === "csv") {
    yield* csvChunks(rows, columns);
    return;
  }
  if (format === "json") yield "[";
  let first = true;
  for (const row of rows) {
    yield (format === "json" && !first ? "," : "") +
      JSON.stringify(row) +
      (format === "ndjson" ? "\n" : "");
    first = false;
  }
  if (format === "json") yield "]\n";
}
/** Repeat report metadata on every CSV row so filtering cannot erase coverage. */
export function reportCsv(data: unknown): string {
  if (Array.isArray(data)) return csv(data);
  if (data && typeof data === "object") {
    const { rows, ...meta } = data as Row;
    if (Array.isArray(rows))
      return csv(
        rows.length ? rows.map((row) => ({ ...meta, ...row })) : [meta],
      );
    return csv([data as Row]);
  }
  return csv([{ value: data }]);
}
