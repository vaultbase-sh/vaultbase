import { useEffect, useRef } from "react";
import Icon from "../Icon.tsx";

export interface KvRow { key: string; value: string; on: boolean }

/**
 * Editable key / value rows with an on/off box each, as the Params, Headers
 * and form-data tabs use. A blank row at the end is always there to type into.
 */
export function KvTable<Row extends KvRow>({
  rows,
  onChange,
  make,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
  renderValue,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  /** A new row from a key and value. */
  make: (key: string, value: string) => Row;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Replace the value input, e.g. with a file picker. */
  renderValue?: (row: Row, set: (patch: Partial<Row>) => void) => React.ReactNode;
}) {
  // Typing in the blank row adds a row; carry the caret into it.
  const tableRef = useRef<HTMLTableElement>(null);
  const focusNext = useRef<{ row: number; field: "key" | "value" } | null>(null);
  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const el = tableRef.current?.querySelector<HTMLInputElement>(`[data-row="${f.row}"][data-field="${f.field}"]`);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
  const add = (key: string, value: string, field: "key" | "value") => {
    focusNext.current = { row: rows.length, field };
    onChange([...rows, make(key, value)]);
  };
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));

  return (
    <table className="ap-kv" ref={tableRef}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} data-off={r.on ? undefined : "true"}>
            <td>
              <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked } as Partial<Row>)} aria-label="Send this row" />
            </td>
            <td>
              <input className="input mono" data-row={i} data-field="key" value={r.key} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value } as Partial<Row>)} aria-label="Key" />
            </td>
            <td>
              {renderValue
                ? renderValue(r, (patch) => set(i, patch))
                : <input className="input mono" data-row={i} data-field="value" value={r.value} placeholder={valuePlaceholder} onChange={(e) => set(i, { value: e.target.value } as Partial<Row>)} aria-label="Value" />}
            </td>
            <td>
              <button type="button" className="btn-icon" title="Remove" aria-label="Remove row" onClick={() => remove(i)}>
                <Icon name="x" size={12} />
              </button>
            </td>
          </tr>
        ))}
        <tr>
          <td />
          <td>
            <input className="input mono" value="" placeholder={keyPlaceholder} aria-label="New key" onChange={(e) => add(e.target.value, "", "key")} />
          </td>
          <td>
            <input className="input mono" value="" placeholder={valuePlaceholder} aria-label="New value" onChange={(e) => add("", e.target.value, "value")} />
          </td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}
