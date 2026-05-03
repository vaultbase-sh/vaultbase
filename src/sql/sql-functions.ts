/**
 * SQLite built-in function catalog. Drives Monaco completion + hover.
 *
 * Coverage: every documented function on https://sqlite.org/lang_*.html
 * that's commonly used in admin queries — aggregate, scalar, date/time,
 * JSON1, math, FTS5, window. Excludes obscure compile-time-flag-only
 * functions and non-standard variants.
 *
 * Each entry is normative — the `signature` field renders as Monaco's
 * detail line; `description` renders as the documentation pane.
 */

export type SqlFunctionCategory =
  | "aggregate" | "scalar" | "datetime" | "json"
  | "math" | "string" | "window" | "fts5" | "vaultbase";

export interface SqlFunction {
  name: string;
  category: SqlFunctionCategory;
  signature: string;
  /** Plain-text description; ~1-2 sentences. */
  description: string;
  /** Return type label for hover. */
  returns?: string;
}

// ── Aggregate ────────────────────────────────────────────────────────────

const AGGREGATE: SqlFunction[] = [
  { name: "count",        category: "aggregate", signature: "count(X | *)",                  returns: "INTEGER",  description: "Returns the number of non-NULL values of X (or all rows for `*`)." },
  { name: "sum",          category: "aggregate", signature: "sum(X)",                        returns: "INTEGER|REAL", description: "Sum of non-NULL values; NULL on empty input." },
  { name: "total",        category: "aggregate", signature: "total(X)",                      returns: "REAL",     description: "Like sum() but returns 0.0 (not NULL) on empty input. Always REAL." },
  { name: "avg",          category: "aggregate", signature: "avg(X)",                        returns: "REAL",     description: "Average of non-NULL values; NULL on empty input." },
  { name: "min",          category: "aggregate", signature: "min(X)",                        returns: "ANY",      description: "Smallest non-NULL value." },
  { name: "max",          category: "aggregate", signature: "max(X)",                        returns: "ANY",      description: "Largest non-NULL value." },
  { name: "group_concat", category: "aggregate", signature: "group_concat(X, sep?)",         returns: "TEXT",     description: "Concatenates non-NULL values, separated by `sep` (default ',')." },
  { name: "string_agg",   category: "aggregate", signature: "string_agg(X, sep)",            returns: "TEXT",     description: "Standard-SQL alias for group_concat with explicit separator." },
];

// ── Scalar / general ─────────────────────────────────────────────────────

const SCALAR: SqlFunction[] = [
  { name: "abs",       category: "math",   signature: "abs(X)",              returns: "NUMERIC", description: "Absolute value." },
  { name: "coalesce",  category: "scalar", signature: "coalesce(X, Y, …)",  returns: "ANY",     description: "First non-NULL argument; requires ≥2 args." },
  { name: "ifnull",    category: "scalar", signature: "ifnull(X, Y)",        returns: "ANY",     description: "X if non-NULL, else Y." },
  { name: "iif",       category: "scalar", signature: "iif(X, Y, Z)",        returns: "ANY",     description: "Y if X is true, else Z. Equivalent to `CASE WHEN X THEN Y ELSE Z END`." },
  { name: "nullif",    category: "scalar", signature: "nullif(X, Y)",        returns: "ANY",     description: "NULL if X = Y, else X." },
  { name: "typeof",    category: "scalar", signature: "typeof(X)",           returns: "TEXT",    description: "Storage class of X: 'null','integer','real','text','blob'." },
  { name: "likelihood",category: "scalar", signature: "likelihood(X, P)",    returns: "ANY",     description: "Hint to optimizer that X is true with probability P. Returns X." },
  { name: "likely",    category: "scalar", signature: "likely(X)",           returns: "ANY",     description: "Optimizer hint that X is usually true. Returns X." },
  { name: "unlikely",  category: "scalar", signature: "unlikely(X)",         returns: "ANY",     description: "Optimizer hint that X is usually false. Returns X." },
  { name: "random",    category: "math",   signature: "random()",            returns: "INTEGER", description: "Pseudo-random integer between -2^63 and +2^63 - 1." },
  { name: "randomblob",category: "scalar", signature: "randomblob(N)",       returns: "BLOB",    description: "Random N-byte blob." },
  { name: "zeroblob",  category: "scalar", signature: "zeroblob(N)",         returns: "BLOB",    description: "BLOB of N zero bytes." },
  { name: "hex",       category: "scalar", signature: "hex(X)",              returns: "TEXT",    description: "Uppercase hex of a BLOB or stringified value." },
  { name: "unhex",     category: "scalar", signature: "unhex(X, ignore?)",   returns: "BLOB",    description: "Inverse of hex(). NULL if input contains non-hex chars (unless ignored)." },
  { name: "quote",     category: "scalar", signature: "quote(X)",            returns: "TEXT",    description: "SQL-literal-safe representation of X (handles strings, blobs, NULL)." },
  { name: "last_insert_rowid", category: "scalar", signature: "last_insert_rowid()", returns: "INTEGER", description: "ROWID of the last successful INSERT in this connection." },
  { name: "changes",   category: "scalar", signature: "changes()",           returns: "INTEGER", description: "Rows modified by the last INSERT/UPDATE/DELETE." },
  { name: "total_changes", category: "scalar", signature: "total_changes()", returns: "INTEGER", description: "Total rows modified since the connection opened." },
  { name: "sqlite_version", category: "scalar", signature: "sqlite_version()", returns: "TEXT",  description: "SQLite library version string." },
];

// ── String ───────────────────────────────────────────────────────────────

const STRING: SqlFunction[] = [
  { name: "length",   category: "string", signature: "length(X)",                 returns: "INTEGER", description: "Length in characters (TEXT) or bytes (BLOB)." },
  { name: "lower",    category: "string", signature: "lower(X)",                  returns: "TEXT",    description: "ASCII lowercase. (Use ICU build for Unicode.)" },
  { name: "upper",    category: "string", signature: "upper(X)",                  returns: "TEXT",    description: "ASCII uppercase." },
  { name: "substr",   category: "string", signature: "substr(X, start, len?)",    returns: "TEXT",    description: "Substring. `start` is 1-based; negative counts from end." },
  { name: "substring",category: "string", signature: "substring(X, start, len?)", returns: "TEXT",    description: "Alias for substr()." },
  { name: "trim",     category: "string", signature: "trim(X, chars?)",           returns: "TEXT",    description: "Strip leading + trailing `chars` (default whitespace)." },
  { name: "ltrim",    category: "string", signature: "ltrim(X, chars?)",          returns: "TEXT",    description: "Strip leading characters." },
  { name: "rtrim",    category: "string", signature: "rtrim(X, chars?)",          returns: "TEXT",    description: "Strip trailing characters." },
  { name: "replace",  category: "string", signature: "replace(X, find, with)",    returns: "TEXT",    description: "Replace every occurrence of `find` with `with`." },
  { name: "instr",    category: "string", signature: "instr(haystack, needle)",   returns: "INTEGER", description: "1-based position of `needle` in `haystack`, or 0 if not found." },
  { name: "char",     category: "string", signature: "char(X1, X2, …)",          returns: "TEXT",    description: "TEXT formed from the given Unicode code points." },
  { name: "unicode",  category: "string", signature: "unicode(X)",                returns: "INTEGER", description: "Code point of the first character." },
  { name: "printf",   category: "string", signature: "printf(format, …)",        returns: "TEXT",    description: "C-style printf formatting." },
  { name: "format",   category: "string", signature: "format(format, …)",        returns: "TEXT",    description: "Alias for printf()." },
  { name: "concat",   category: "string", signature: "concat(X, Y, …)",          returns: "TEXT",    description: "Concatenate non-NULL values into one string." },
  { name: "concat_ws",category: "string", signature: "concat_ws(sep, X, Y, …)",  returns: "TEXT",    description: "Concatenate args with separator; skips NULLs." },
  { name: "glob",     category: "string", signature: "glob(pattern, X)",         returns: "INTEGER", description: "1 if X matches Unix-glob pattern, else 0. Case-sensitive." },
  { name: "like",     category: "string", signature: "like(pattern, X, esc?)",   returns: "INTEGER", description: "1 if X matches LIKE pattern. Case-insensitive on ASCII by default." },
  { name: "soundex",  category: "string", signature: "soundex(X)",               returns: "TEXT",    description: "4-char Soundex code (for English-name fuzzy match)." },
];

// ── Math ─────────────────────────────────────────────────────────────────

const MATH: SqlFunction[] = [
  { name: "round",   category: "math", signature: "round(X, digits?)", returns: "REAL",    description: "Round to `digits` decimal places (default 0)." },
  { name: "ceil",    category: "math", signature: "ceil(X)",           returns: "INTEGER", description: "Smallest integer ≥ X." },
  { name: "ceiling", category: "math", signature: "ceiling(X)",        returns: "INTEGER", description: "Alias for ceil()." },
  { name: "floor",   category: "math", signature: "floor(X)",          returns: "INTEGER", description: "Largest integer ≤ X." },
  { name: "trunc",   category: "math", signature: "trunc(X)",          returns: "INTEGER", description: "X with fractional part removed (toward zero)." },
  { name: "sign",    category: "math", signature: "sign(X)",           returns: "INTEGER", description: "-1, 0, +1 depending on sign of X; NULL if not numeric." },
  { name: "exp",     category: "math", signature: "exp(X)",            returns: "REAL",    description: "e^X." },
  { name: "ln",      category: "math", signature: "ln(X)",             returns: "REAL",    description: "Natural logarithm." },
  { name: "log",     category: "math", signature: "log(B?, X)",        returns: "REAL",    description: "log_B(X) (or log_10 with one arg)." },
  { name: "log10",   category: "math", signature: "log10(X)",          returns: "REAL",    description: "Base-10 logarithm." },
  { name: "log2",    category: "math", signature: "log2(X)",           returns: "REAL",    description: "Base-2 logarithm." },
  { name: "sqrt",    category: "math", signature: "sqrt(X)",           returns: "REAL",    description: "Square root of X." },
  { name: "pow",     category: "math", signature: "pow(X, Y)",         returns: "REAL",    description: "X to the power Y." },
  { name: "power",   category: "math", signature: "power(X, Y)",       returns: "REAL",    description: "Alias for pow()." },
  { name: "mod",     category: "math", signature: "mod(X, Y)",         returns: "REAL",    description: "Remainder of X / Y." },
  { name: "pi",      category: "math", signature: "pi()",              returns: "REAL",    description: "π." },
  { name: "sin",     category: "math", signature: "sin(X)",            returns: "REAL",    description: "Sine of X (radians)." },
  { name: "cos",     category: "math", signature: "cos(X)",            returns: "REAL",    description: "Cosine of X (radians)." },
  { name: "tan",     category: "math", signature: "tan(X)",            returns: "REAL",    description: "Tangent of X (radians)." },
  { name: "asin",    category: "math", signature: "asin(X)",           returns: "REAL",    description: "Arcsine in radians." },
  { name: "acos",    category: "math", signature: "acos(X)",           returns: "REAL",    description: "Arccosine in radians." },
  { name: "atan",    category: "math", signature: "atan(X)",           returns: "REAL",    description: "Arctangent in radians." },
  { name: "atan2",   category: "math", signature: "atan2(Y, X)",       returns: "REAL",    description: "atan(Y/X) using signs to determine quadrant." },
  { name: "degrees", category: "math", signature: "degrees(X)",        returns: "REAL",    description: "Radians → degrees." },
  { name: "radians", category: "math", signature: "radians(X)",        returns: "REAL",    description: "Degrees → radians." },
];

// ── Date/time ────────────────────────────────────────────────────────────

const DATETIME: SqlFunction[] = [
  { name: "date",      category: "datetime", signature: "date(time, modifiers…)",      returns: "TEXT",    description: "YYYY-MM-DD. Pass 'now' for today; modifiers like '+1 day', 'unixepoch'." },
  { name: "time",      category: "datetime", signature: "time(time, modifiers…)",      returns: "TEXT",    description: "HH:MM:SS." },
  { name: "datetime",  category: "datetime", signature: "datetime(time, modifiers…)",  returns: "TEXT",    description: "YYYY-MM-DD HH:MM:SS." },
  { name: "julianday", category: "datetime", signature: "julianday(time, modifiers…)", returns: "REAL",    description: "Julian day number (fractional)." },
  { name: "strftime",  category: "datetime", signature: "strftime(fmt, time, mods…)",  returns: "TEXT",    description: "Format-string variant. e.g. strftime('%Y-%m', 'now')." },
  { name: "unixepoch", category: "datetime", signature: "unixepoch(time?, mods…)",     returns: "INTEGER", description: "Unix-seconds since 1970-01-01. No args → now." },
  { name: "timediff",  category: "datetime", signature: "timediff(end, start)",        returns: "TEXT",    description: "Difference between two times as ±HHHH:MM:SS.sss (SQLite ≥ 3.43)." },
];

// ── JSON1 ────────────────────────────────────────────────────────────────

const JSON_FUNCS: SqlFunction[] = [
  { name: "json",            category: "json", signature: "json(X)",                       returns: "TEXT", description: "Parse + canonicalise JSON. Throws on invalid input." },
  { name: "json_valid",      category: "json", signature: "json_valid(X)",                 returns: "INTEGER", description: "1 if X is well-formed JSON, else 0." },
  { name: "json_type",       category: "json", signature: "json_type(X, path?)",           returns: "TEXT", description: "JSON type at path: object/array/string/number/integer/real/true/false/null." },
  { name: "json_array",      category: "json", signature: "json_array(values…)",           returns: "TEXT", description: "Build a JSON array from arguments." },
  { name: "json_object",     category: "json", signature: "json_object(k, v, k, v, …)",    returns: "TEXT", description: "Build a JSON object from alternating key/value args." },
  { name: "json_extract",    category: "json", signature: "json_extract(X, paths…)",       returns: "ANY",  description: "Pull values at JSON paths. Same as the `->` operator with default unwrap." },
  { name: "json_set",        category: "json", signature: "json_set(X, path, value, …)",   returns: "TEXT", description: "Replace or insert at path." },
  { name: "json_insert",     category: "json", signature: "json_insert(X, path, value, …)",returns: "TEXT", description: "Insert at path; no-op if path exists." },
  { name: "json_replace",    category: "json", signature: "json_replace(X, path, value, …)",returns: "TEXT", description: "Replace at path; no-op if path missing." },
  { name: "json_remove",     category: "json", signature: "json_remove(X, paths…)",        returns: "TEXT", description: "Remove the values at the given paths." },
  { name: "json_array_length",category: "json", signature: "json_array_length(X, path?)",  returns: "INTEGER", description: "Length of array at path (0 if not an array)." },
  { name: "json_each",       category: "json", signature: "json_each(X, path?)",           returns: "TABLE", description: "Table-valued: iterate one level of the JSON value." },
  { name: "json_tree",       category: "json", signature: "json_tree(X, path?)",           returns: "TABLE", description: "Table-valued: walk the entire JSON tree." },
  { name: "json_group_array",category: "json", signature: "json_group_array(X)",           returns: "TEXT", description: "Aggregate values into a JSON array." },
  { name: "json_group_object",category: "json", signature: "json_group_object(k, v)",      returns: "TEXT", description: "Aggregate key/value pairs into a JSON object." },
  { name: "json_quote",      category: "json", signature: "json_quote(X)",                 returns: "TEXT", description: "Wrap X as a JSON-quoted string." },
];

// ── Window ───────────────────────────────────────────────────────────────

const WINDOW: SqlFunction[] = [
  { name: "row_number",  category: "window", signature: "row_number() OVER (…)",         returns: "INTEGER", description: "1-based row index within the window partition." },
  { name: "rank",        category: "window", signature: "rank() OVER (…)",               returns: "INTEGER", description: "Rank with gaps for ties." },
  { name: "dense_rank",  category: "window", signature: "dense_rank() OVER (…)",         returns: "INTEGER", description: "Rank without gaps for ties." },
  { name: "percent_rank",category: "window", signature: "percent_rank() OVER (…)",       returns: "REAL",    description: "(rank-1) / (count-1)." },
  { name: "cume_dist",   category: "window", signature: "cume_dist() OVER (…)",          returns: "REAL",    description: "Cumulative distribution within the partition." },
  { name: "ntile",       category: "window", signature: "ntile(N) OVER (…)",             returns: "INTEGER", description: "Distribute rows into N buckets." },
  { name: "lag",         category: "window", signature: "lag(X, offset?, default?) OVER (…)", returns: "ANY", description: "Value from a row `offset` rows earlier in the partition." },
  { name: "lead",        category: "window", signature: "lead(X, offset?, default?) OVER (…)", returns: "ANY", description: "Value from a row `offset` rows later." },
  { name: "first_value", category: "window", signature: "first_value(X) OVER (…)",       returns: "ANY",     description: "X from the first row of the window frame." },
  { name: "last_value",  category: "window", signature: "last_value(X) OVER (…)",        returns: "ANY",     description: "X from the last row of the window frame." },
  { name: "nth_value",   category: "window", signature: "nth_value(X, N) OVER (…)",      returns: "ANY",     description: "X from the Nth row of the window frame." },
];

// ── FTS5 ─────────────────────────────────────────────────────────────────

const FTS5: SqlFunction[] = [
  { name: "match",     category: "fts5", signature: "<col> MATCH '<query>'",     returns: "INTEGER", description: "Full-text-search match. Right-hand side is the FTS5 query syntax." },
  { name: "snippet",   category: "fts5", signature: "snippet(tab, col, l, r, ellip, n)", returns: "TEXT", description: "Return a short HTML-tagged excerpt around a match." },
  { name: "highlight", category: "fts5", signature: "highlight(tab, col, l, r)", returns: "TEXT",    description: "Wrap matched terms in a column with start/end markers." },
  { name: "bm25",      category: "fts5", signature: "bm25(tab, weights…)",      returns: "REAL",    description: "BM25 relevance score (lower = better match)." },
];

// ── Vaultbase-flavour helpers (none yet, placeholder for future reg) ────

const VAULTBASE: SqlFunction[] = [];

export const SQL_FUNCTIONS: SqlFunction[] = [
  ...AGGREGATE,
  ...SCALAR,
  ...STRING,
  ...MATH,
  ...DATETIME,
  ...JSON_FUNCS,
  ...WINDOW,
  ...FTS5,
  ...VAULTBASE,
];

/** Look up by name (case-insensitive). */
export function findFunction(name: string): SqlFunction | null {
  const n = name.toLowerCase();
  return SQL_FUNCTIONS.find((f) => f.name === n) ?? null;
}
