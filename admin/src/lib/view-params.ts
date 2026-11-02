/**
 * Parameters on view collections (server: core/view-params.ts): the
 * helpers behind components/ViewParams.tsx, kept free of React so the
 * server's test run (which has no admin dependencies) can load their tests.
 */

export type ViewParamType = "text" | "number" | "bool" | "date";
export type ViewParamMode = "default" | "required" | "auth";

/** One row of the editor. `default` is what was typed; the server converts it. */
export interface ViewParamDraft {
  name: string;
  type: ViewParamType;
  mode: ViewParamMode;
  default: string;
}


/** Drafts from a collection's stored `view_params` (JSON text). */
export function draftsFromJson(raw: string | null | undefined): ViewParamDraft[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ name: string; type: ViewParamType; default?: string | number | null; required?: boolean; from?: string }>;
    return list.map((p) => ({
      name: p.name,
      type: p.type,
      mode: p.from ? "auth" : p.required ? "required" : "default",
      // A stored date default is Unix seconds; shown as a date.
      default: p.default === undefined || p.default === null ? ""
        : p.type === "date" && typeof p.default === "number" ? new Date(p.default * 1000).toISOString().slice(0, 10)
        : p.type === "bool" ? (p.default ? "true" : "false")
        : String(p.default),
    }));
  } catch {
    return [];
  }
}

/** What the API takes as `view_params`. */
export function draftsToPayload(drafts: ViewParamDraft[]): Array<Record<string, unknown>> {
  return drafts.map((d) => {
    if (d.mode === "auth") return { name: d.name, type: "text", from: "auth.id" };
    if (d.mode === "required") return { name: d.name, type: d.type, required: true };
    return { name: d.name, type: d.type, ...(d.default.trim() !== "" ? { default: d.default.trim() } : {}) };
  });
}

/**
 * The `:name`s in a query, first occurrence order, skipping strings, quoted
 * names, comments, `::` casts and array slices. The server checks the same.
 */
export function queryParamNames(query: string): string[] {
  const out: string[] = [];
  let i = 0;
  let brackets = 0;
  while (i < query.length) {
    const c = query[i]!;
    const next = query[i + 1];
    if (c === "-" && next === "-") { const e = query.indexOf("\n", i); i = e < 0 ? query.length : e + 1; continue; }
    if (c === "/" && next === "*") { const e = query.indexOf("*/", i + 2); i = e < 0 ? query.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        const k = query.indexOf(c, j);
        if (k < 0) { j = query.length; break; }
        if (query[k + 1] === c) { j = k + 2; continue; }
        j = k + 1; break;
      }
      i = j; continue;
    }
    if (c === "[") brackets++;
    if (c === "]") brackets = Math.max(0, brackets - 1);
    if (c === ":" && next === ":") { i += 2; continue; }
    if (c === ":" && next && /[A-Za-z_]/.test(next) && query[i - 1] !== ":" && brackets === 0) {
      let j = i + 2;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j]!)) j++;
      const name = query.slice(i + 1, j);
      if (!out.includes(name)) out.push(name);
      i = j; continue;
    }
    i++;
  }
  return out;
}

/** `params[name]=value` for the values filled in. */
export function appendViewParams(search: URLSearchParams, values: Record<string, string>): void {
  for (const [k, v] of Object.entries(values)) if (v.trim() !== "") search.set(`params[${k}]`, v.trim());
}
