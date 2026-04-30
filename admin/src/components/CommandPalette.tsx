import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import Icon from "./Icon.tsx";
import { useCollections } from "../stores/collections.ts";

interface CmdItem {
  id: string;
  label: string;
  group: "Navigate" | "Collections" | "Actions";
  to?: string;
  shortcut?: string;
  run?: () => void;
  /** Tokens for fuzzy matching beyond the label. */
  hay?: string;
}

const NAV_ITEMS: CmdItem[] = [
  { id: "n-dash",    label: "Dashboard",   group: "Navigate", to: "/_/" },
  { id: "n-coll",    label: "Collections", group: "Navigate", to: "/_/collections" },
  { id: "n-logs",    label: "Logs",        group: "Navigate", to: "/_/logs" },
  { id: "n-api",     label: "API preview", group: "Navigate", to: "/_/api-preview" },
  { id: "n-hooks",   label: "Hooks",       group: "Navigate", to: "/_/hooks" },
  { id: "n-set",     label: "Settings",    group: "Navigate", to: "/_/settings" },
  { id: "n-su",      label: "Superusers",  group: "Navigate", to: "/_/users" },
];

function fuzzy(query: string, hay: string): number {
  // Simple subsequence-with-positions score. 0 = no match.
  if (!query) return 1;
  const q = query.toLowerCase();
  const h = hay.toLowerCase();
  if (h.includes(q)) return 1000 - h.indexOf(q);
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let i = 0; i < h.length && qi < q.length; i++) {
    if (h[i] === q[qi]) {
      score += lastMatch === i - 1 ? 5 : 1;
      lastMatch = i;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

export const CommandPalette: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const navigate = useNavigate();
  const collections = useCollections((s) => s.list);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setQ(""); setActive(0); return; }
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const items = useMemo<CmdItem[]>(() => {
    const collItems: CmdItem[] = collections.flatMap((c) => [
      { id: `c-${c.id}-rec`, label: `Records · ${c.name}`,       group: "Collections", to: `/_/collections/${c.id}/records`, hay: `${c.name} records` },
      { id: `c-${c.id}-sch`, label: `Schema · ${c.name}`,        group: "Collections", to: `/_/collections/${c.id}/edit`,    hay: `${c.name} schema fields` },
    ]);
    return [...NAV_ITEMS, ...collItems];
  }, [collections]);

  const filtered = useMemo<CmdItem[]>(() => {
    return items
      .map((it) => {
        const score = Math.max(
          fuzzy(q, it.label),
          it.hay ? fuzzy(q, it.hay) : 0,
        );
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map((x) => x.it);
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);

  function run(it: CmdItem) {
    onClose();
    if (it.run) it.run();
    else if (it.to) navigate(it.to);
  }

  if (!open) return null;

  const groups = filtered.reduce<Record<string, CmdItem[]>>((acc, it) => {
    (acc[it.group] ??= []).push(it);
    return acc;
  }, {});
  const flatOrder = filtered;

  return createPortal(
    <div
      className="cmd-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((a) => Math.min(a + 1, flatOrder.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const sel = flatOrder[active];
          if (sel) run(sel);
        }
      }}
    >
      <div className="cmd" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-head">
          <Icon name="search" size={14} style={{ color: "var(--text-muted)" }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search collections, pages, actions…"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, flatOrder.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const sel = flatOrder[active];
                if (sel) run(sel);
              }
            }}
          />
          <span className="kbd-key">esc</span>
        </div>
        <div className="cmd-body">
          {flatOrder.length === 0 ? (
            <div className="cmd-empty">No matches for "{q}"</div>
          ) : (
            (["Navigate", "Collections", "Actions"] as const).map((g) => {
              const list = groups[g];
              if (!list || list.length === 0) return null;
              return (
                <div className="cmd-group" key={g}>
                  <div className="cmd-group-label">{g}</div>
                  {list.map((it) => {
                    const idx = flatOrder.indexOf(it);
                    const on = idx === active;
                    return (
                      <div
                        key={it.id}
                        className={`cmd-item${on ? " on" : ""}`}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => run(it)}
                      >
                        <span className="lbl">{it.label}</span>
                        {on && <span className="kbd-key">⏎</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div className="cmd-foot">
          <span className="kbd-key">↑↓</span> navigate
          <span style={{ marginLeft: 12 }}><span className="kbd-key">⏎</span> select</span>
          <span style={{ marginLeft: "auto" }}>vaultbase ⌘K</span>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export function useCommandPalette(): { open: boolean; setOpen: (v: boolean) => void } {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
