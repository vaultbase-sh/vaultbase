/**
 * An SQL identifier in double quotes, an embedded `"` doubled: the quoting
 * SQLite and Postgres share, safe for DDL.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
