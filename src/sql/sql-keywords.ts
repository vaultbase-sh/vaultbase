/**
 * SQLite keyword + snippet catalog. Drives Monaco completion.
 *
 * Keywords are reserved/contextual SQLite words. Snippets are templated
 * common patterns the LLM/user reaches for first (`sel<Tab>`, `joi<Tab>`).
 * Both register as completion items; snippets also expose `insertText`
 * with `${1:...}` placeholders for tab-stop navigation.
 */

/** Reserved + context keywords from https://sqlite.org/lang_keywords.html. */
export const SQL_KEYWORDS: readonly string[] = [
  "ABORT", "ACTION", "ADD", "AFTER", "ALL", "ALTER", "ALWAYS", "ANALYZE",
  "AND", "AS", "ASC", "ATTACH", "AUTOINCREMENT", "BEFORE", "BEGIN",
  "BETWEEN", "BY", "CASCADE", "CASE", "CAST", "CHECK", "COLLATE", "COLUMN",
  "COMMIT", "CONFLICT", "CONSTRAINT", "CREATE", "CROSS", "CURRENT",
  "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "DATABASE",
  "DEFAULT", "DEFERRABLE", "DEFERRED", "DELETE", "DESC", "DETACH",
  "DISTINCT", "DO", "DROP", "EACH", "ELSE", "END", "ESCAPE", "EXCEPT",
  "EXCLUDE", "EXCLUSIVE", "EXISTS", "EXPLAIN", "FAIL", "FILTER", "FIRST",
  "FOLLOWING", "FOR", "FOREIGN", "FROM", "FULL", "GENERATED", "GLOB",
  "GROUP", "GROUPS", "HAVING", "IF", "IGNORE", "IMMEDIATE", "IN", "INDEX",
  "INDEXED", "INITIALLY", "INNER", "INSERT", "INSTEAD", "INTERSECT",
  "INTO", "IS", "ISNULL", "JOIN", "KEY", "LAST", "LEFT", "LIKE", "LIMIT",
  "MATCH", "MATERIALIZED", "NATURAL", "NO", "NOT", "NOTHING", "NOTNULL",
  "NULL", "NULLS", "OF", "OFFSET", "ON", "OR", "ORDER", "OTHERS", "OUTER",
  "OVER", "PARTITION", "PLAN", "PRAGMA", "PRECEDING", "PRIMARY", "QUERY",
  "RAISE", "RANGE", "RECURSIVE", "REFERENCES", "REGEXP", "REINDEX",
  "RELEASE", "RENAME", "REPLACE", "RESTRICT", "RETURNING", "RIGHT",
  "ROLLBACK", "ROW", "ROWS", "SAVEPOINT", "SELECT", "SET", "TABLE",
  "TEMP", "TEMPORARY", "THEN", "TIES", "TO", "TRANSACTION", "TRIGGER",
  "UNBOUNDED", "UNION", "UNIQUE", "UPDATE", "USING", "VACUUM", "VALUES",
  "VIEW", "VIRTUAL", "WHEN", "WHERE", "WINDOW", "WITH", "WITHOUT",
];

export interface SqlSnippet {
  label: string;
  detail: string;
  /** Monaco snippet syntax — `${1:placeholder}` are tab stops. */
  insertText: string;
  /** Plain-text body for hover docs. */
  documentation: string;
}

export const SQL_SNIPPETS: readonly SqlSnippet[] = [
  {
    label: "sel",
    detail: "SELECT … FROM …",
    insertText: "SELECT ${1:*}\nFROM ${2:table}\n${3:WHERE ${4:cond}};",
    documentation: "Basic SELECT.",
  },
  {
    label: "ins",
    detail: "INSERT INTO … VALUES …",
    insertText: "INSERT INTO ${1:table} (${2:cols}) VALUES (${3:vals});",
    documentation: "INSERT one row.",
  },
  {
    label: "ins-multi",
    detail: "INSERT INTO … multi-row VALUES …",
    insertText: "INSERT INTO ${1:table} (${2:cols}) VALUES\n  (${3:row1}),\n  (${4:row2});",
    documentation: "INSERT multiple rows.",
  },
  {
    label: "upd",
    detail: "UPDATE … SET … WHERE …",
    insertText: "UPDATE ${1:table}\nSET ${2:col} = ${3:val}\nWHERE ${4:cond};",
    documentation: "UPDATE rows.",
  },
  {
    label: "del",
    detail: "DELETE FROM … WHERE …",
    insertText: "DELETE FROM ${1:table}\nWHERE ${2:cond};",
    documentation: "DELETE rows.",
  },
  {
    label: "joi",
    detail: "JOIN clause",
    insertText: "JOIN ${1:other} ${2:o} ON ${2:o}.${3:fk} = ${4:t}.${5:id}",
    documentation: "INNER JOIN snippet.",
  },
  {
    label: "ljoi",
    detail: "LEFT JOIN clause",
    insertText: "LEFT JOIN ${1:other} ${2:o} ON ${2:o}.${3:fk} = ${4:t}.${5:id}",
    documentation: "LEFT OUTER JOIN snippet.",
  },
  {
    label: "cte",
    detail: "WITH … AS (…) SELECT …",
    insertText: "WITH ${1:name} AS (\n  SELECT ${2:*}\n  FROM ${3:table}\n)\nSELECT ${4:*}\nFROM ${1};",
    documentation: "Common Table Expression.",
  },
  {
    label: "case",
    detail: "CASE WHEN … THEN … ELSE … END",
    insertText: "CASE\n  WHEN ${1:cond} THEN ${2:val}\n  ELSE ${3:other}\nEND",
    documentation: "Conditional expression.",
  },
  {
    label: "expl",
    detail: "EXPLAIN QUERY PLAN …",
    insertText: "EXPLAIN QUERY PLAN ${1:SELECT …};",
    documentation: "Show the SQLite query plan.",
  },
];
