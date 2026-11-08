// CSV writing (RFC 4180) with spreadsheet formula-injection protection (OWASP "CSV Injection").

/** Leading characters a spreadsheet may read as a formula (plus full-width forms). */
const FORMULA = /^[=+\-@\t\r＝＋－＠]/;

/** One cell: text that could start a formula gets a leading `'`; then quoted if needed. */
export function cell(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows -> CSV text with CRLF line ends and a UTF-8 BOM, so Excel reads accents correctly. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
