import { useEffect, useRef, useState } from "react";
import type { FieldDef } from "../api.ts";

/**
 * Inline rule expression editor with autocomplete.
 * Suggests:
 *   - @request.auth.id, @request.auth.email, @request.auth.type
 *   - field names from the current collection schema
 *   - operators (=, !=, >, >=, <, <=, ~, &&, ||)
 *   - common literal values (true, false, null, "")
 */

const AUTH_REFS = [
  { label: "@request.auth.id",    detail: "current authenticated user/admin id" },
  { label: "@request.auth.email", detail: "auth email (if present)" },
  { label: "@request.auth.type",  detail: "'user' | 'admin'" },
];

const OPERATORS = [
  { label: "=",  detail: "equals" },
  { label: "!=", detail: "not equals" },
  { label: ">",  detail: "greater than" },
  { label: ">=", detail: "greater or equal" },
  { label: "<",  detail: "less than" },
  { label: "<=", detail: "less or equal" },
  { label: "~",  detail: "contains (LIKE)" },
  { label: "&&", detail: "AND" },
  { label: "||", detail: "OR" },
];

const LITERALS = [
  { label: "true",  detail: "boolean true" },
  { label: "false", detail: "boolean false" },
  { label: "null",  detail: "null value" },
  { label: '""',    detail: "empty string" },
];

interface Suggestion {
  label: string;
  insertText?: string;
  detail?: string;
  category: "auth" | "field" | "op" | "literal";
}

export interface RuleEditorProps {
  value: string;
  onChange: (v: string) => void;
  schemaFields: FieldDef[];
  placeholder?: string;
}

export function RuleEditor({ value, onChange, schemaFields, placeholder }: RuleEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [tokenStart, setTokenStart] = useState(0);

  const fieldNames = schemaFields
    .filter((f) => f.type !== "autodate" || f.system)
    .map((f) => ({
      label: f.name,
      detail: `${f.type}${f.system ? " · system" : ""}`,
      category: "field" as const,
    }));

  // Compute suggestions based on current token
  function computeSuggestions(text: string, cursor: number): Suggestion[] {
    // Find token start: walk backward over [a-zA-Z0-9_.@]
    let start = cursor;
    while (start > 0 && /[a-zA-Z0-9_.@]/.test(text[start - 1]!)) start--;
    setTokenStart(start);
    const token = text.slice(start, cursor);

    // Determine context — what came before this token
    const before = text.slice(0, start).trimEnd();
    const lastChar = before[before.length - 1] ?? "";
    const isAfterOp = /[=!<>~]/.test(lastChar);
    const isAfterValue = /['"a-zA-Z0-9_]/.test(lastChar);

    const tokenLower = token.toLowerCase();

    // Empty token + after value → suggest operators / && / ||
    if (token === "" && isAfterValue) {
      return OPERATORS.map((o) => ({ ...o, category: "op" as const }));
    }

    // After comparison operator → suggest values + auth refs
    if (isAfterOp) {
      const opts: Suggestion[] = [
        ...AUTH_REFS.map((a) => ({ ...a, category: "auth" as const })),
        ...LITERALS.map((l) => ({ ...l, category: "literal" as const })),
        ...fieldNames,
      ];
      return tokenLower
        ? opts.filter((s) => s.label.toLowerCase().includes(tokenLower))
        : opts;
    }

    // Default: suggest fields + auth refs
    const opts: Suggestion[] = [
      ...AUTH_REFS.map((a) => ({ ...a, category: "auth" as const })),
      ...fieldNames,
    ];

    // Token starts with @ → only auth refs
    if (token.startsWith("@")) {
      return AUTH_REFS
        .filter((a) => a.label.toLowerCase().startsWith(tokenLower))
        .map((a) => ({ ...a, category: "auth" as const }));
    }

    return tokenLower
      ? opts.filter((s) => s.label.toLowerCase().startsWith(tokenLower))
      : opts;
  }

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const newValue = e.target.value;
    onChange(newValue);
    const cursor = e.target.selectionStart ?? newValue.length;
    const sugs = computeSuggestions(newValue, cursor);
    setSuggestions(sugs);
    setHighlighted(0);
    setOpen(sugs.length > 0);
  }

  function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
    const cursor = e.target.selectionStart ?? value.length;
    const sugs = computeSuggestions(value, cursor);
    setSuggestions(sugs);
    setHighlighted(0);
    if (sugs.length > 0) setOpen(true);
  }

  function applySuggestion(s: Suggestion) {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? value.length;
    const insert = s.insertText ?? s.label;
    const newValue = value.slice(0, tokenStart) + insert + value.slice(cursor);
    onChange(newValue);
    setOpen(false);
    // Restore cursor
    queueMicrotask(() => {
      input.focus();
      const pos = tokenStart + insert.length;
      input.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === " ")) {
        e.preventDefault();
        const cursor = inputRef.current?.selectionStart ?? value.length;
        const sugs = computeSuggestions(value, cursor);
        setSuggestions(sugs);
        setHighlighted(0);
        setOpen(sugs.length > 0);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const sel = suggestions[highlighted];
      if (sel) applySuggestion(sel);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Close suggestions on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!inputRef.current?.parentElement?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input
        ref={inputRef}
        className="input mono rule-input"
        style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        value={value}
        onChange={handleInput}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            background: "var(--bg-raised)",
            border: "0.5px solid var(--border-default)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxHeight: 240,
            overflowY: "auto",
            zIndex: 100,
          }}
        >
          {suggestions.map((s, i) => (
            <div
              key={s.category + ":" + s.label}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
              onMouseEnter={() => setHighlighted(i)}
              style={{
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 12,
                cursor: "pointer",
                background: highlighted === i ? "var(--accent-glow)" : "transparent",
                color: highlighted === i ? "var(--accent-light)" : "var(--text-primary)",
                borderBottom: i < suggestions.length - 1 ? "0.5px solid rgba(255,255,255,0.04)" : "none",
              }}
            >
              <CategoryBadge category={s.category} />
              <span className="mono" style={{ flex: 1 }}>{s.label}</span>
              {s.detail && (
                <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{s.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryBadge({ category }: { category: Suggestion["category"] }) {
  const cfg: Record<Suggestion["category"], { label: string; bg: string; color: string }> = {
    auth:    { label: "auth",  bg: "rgba(31,210,255,0.15)",  color: "var(--accent-light)" },
    field:   { label: "field", bg: "rgba(255,255,255,0.06)", color: "var(--text-secondary)" },
    op:      { label: "op",    bg: "rgba(251,191,36,0.12)",  color: "#fcd34d" },
    literal: { label: "lit",   bg: "rgba(167,139,250,0.12)", color: "#c4b5fd" },
  };
  const c = cfg[category];
  return (
    <span
      style={{
        fontSize: 9.5,
        padding: "1px 5px",
        borderRadius: 3,
        fontFamily: "var(--font-mono)",
        background: c.bg,
        color: c.color,
        textTransform: "lowercase",
        minWidth: 32,
        textAlign: "center",
      }}
    >
      {c.label}
    </span>
  );
}
