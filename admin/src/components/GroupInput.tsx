/**
 * Record-form editor for a group field: one card per item, with add, remove
 * and move, or a single card when the group is one object. Subfield inputs
 * come from the caller (the record form's own FieldInput), so every
 * subfield type edits the same way it does at the top level.
 */
import { useRef, useState } from "react";
import type { FieldDef } from "../api.ts";
import { VbBtn } from "./Vb.tsx";
import Icon from "./Icon.tsx";
import {
  groupItemBounds, isGroupList, itemSummary, moveItem, singleGroupValue, subfieldsOf, type GroupItem,
} from "../lib/group.ts";

export type RenderSubfield = (sub: FieldDef, value: unknown, onChange: (v: unknown) => void) => React.ReactNode;

let nextKey = 0;
const newKey = () => `new-${++nextKey}`;

export function GroupInput({ field, value, onChange, readOnly, renderSubfield }: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  renderSubfield: RenderSubfield;
}) {
  if (!isGroupList(field)) {
    if (value !== null && value !== undefined && !isItem(value)) {
      return <NotItems what="an object" value={value} readOnly={readOnly} onReset={() => onChange(null)} reset="Clear it" />;
    }
    const item = (value ?? {}) as GroupItem;
    return (
      <div style={cardStyle}>
        <ItemFields field={field} item={item} readOnly={readOnly} renderSubfield={renderSubfield}
          onChange={(next) => onChange(singleGroupValue(next))} />
      </div>
    );
  }
  return <GroupList field={field} value={value} onChange={onChange} readOnly={readOnly} renderSubfield={renderSubfield} />;
}

function GroupList({ field, value, onChange, readOnly, renderSubfield }: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  renderSubfield: RenderSubfield;
}) {
  const items = (Array.isArray(value) ? value : []) as GroupItem[];
  const { min, max } = groupItemBounds(field);

  // Keys for React: a saved item has its id; a new one gets a key here,
  // moved along with it, until the server gives it an id.
  const keys = useRef<string[]>([]);
  if (keys.current.length !== items.length) {
    keys.current = items.map((it, i) => (typeof it?.["id"] === "string" ? it["id"] : keys.current[i] ?? newKey()));
  }
  const keyOf = (i: number) => (typeof items[i]?.["id"] === "string" ? items[i]!["id"] as string : keys.current[i]!);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // A value that isn't a list of objects (a hand-edited row) can't be edited as items.
  if (value !== null && value !== undefined && (!Array.isArray(value) || !value.every(isItem))) {
    return <NotItems what="a list of items" value={value} readOnly={readOnly} onReset={() => onChange([])} reset="Replace with an empty list" />;
  }

  const commit = (next: GroupItem[], nextKeys: string[]) => { keys.current = nextKeys; onChange(next); };
  const add = () => commit([...items, {}], [...keys.current, newKey()]);
  const remove = (i: number) => commit(items.filter((_, x) => x !== i), keys.current.filter((_, x) => x !== i));
  const move = (from: number, to: number) => commit(moveItem(items, from, to), moveItem(keys.current, from, to));
  const toggle = (k: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
          No items{min > 0 ? ` · needs at least ${min}` : ""}.
        </div>
      )}
      {items.map((item, i) => {
        const k = keyOf(i);
        const open = !collapsed.has(k);
        const summary = itemSummary(item, field);
        return (
          <div key={k} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: open ? 10 : 0 }}>
              <button type="button" onClick={() => toggle(k)} aria-expanded={open} aria-label={open ? `Collapse item ${i + 1}` : `Expand item ${i + 1}`} style={headButtonStyle}>
                <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg-3)" }}>#{i + 1}</span>
                <span style={{ fontSize: 12, color: "var(--vb-fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {summary || <span style={{ color: "var(--vb-fg-3)" }}>empty</span>}
                </span>
              </button>
              {!readOnly && (
                <>
                  <VbBtn kind="ghost" size="sm" icon="arrowUp" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)} />
                  <VbBtn kind="ghost" size="sm" icon="arrowDown" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} />
                  <VbBtn kind="danger" size="sm" icon="trash" title="Remove item" onClick={() => remove(i)} />
                </>
              )}
            </div>
            {open && (
              <ItemFields field={field} item={item} readOnly={readOnly} renderSubfield={renderSubfield}
                onChange={(next) => onChange(items.map((x, xi) => (xi === i ? next : x)))} />
            )}
          </div>
        );
      })}
      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <VbBtn kind="ghost" size="sm" icon="plus" onClick={add} disabled={items.length >= max}>Add item</VbBtn>
          <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>
            {items.length} of {max}{min > 0 ? `, at least ${min}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function ItemFields({ field, item, onChange, readOnly, renderSubfield }: {
  field: FieldDef;
  item: GroupItem;
  onChange: (next: GroupItem) => void;
  readOnly?: boolean;
  renderSubfield: RenderSubfield;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {subfieldsOf(field).map((sub) => (
        <div key={sub.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--vb-fg-3)" }}>
            {sub.name}
            {sub.required && <span style={{ color: "var(--vb-status-danger)", marginLeft: 3 }}>*</span>}
            <span style={{ marginLeft: 6, opacity: 0.7 }}>{sub.type}</span>
          </span>
          {renderSubfield(sub, item[sub.name], (v) => {
            if (readOnly) return;
            onChange({ ...item, [sub.name]: v });
          })}
        </div>
      ))}
    </div>
  );
}

const isItem = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

function NotItems({ what, value, readOnly, onReset, reset }: {
  what: string;
  value: unknown;
  readOnly?: boolean;
  onReset: () => void;
  reset: string;
}) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--vb-status-warning)" }}>
      The stored value isn't {what}: <code>{JSON.stringify(value).slice(0, 120)}</code>.
      {!readOnly && <> <VbBtn kind="ghost" size="sm" onClick={onReset}>{reset}</VbBtn></>}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "var(--vb-bg-1)",
  border: "1px solid var(--vb-border)",
  borderRadius: 6,
};

const headButtonStyle: React.CSSProperties = {
  appearance: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  flex: 1,
  minWidth: 0,
  padding: 0,
  background: "transparent",
  border: 0,
  color: "var(--vb-fg-2)",
  cursor: "pointer",
  textAlign: "left",
};
