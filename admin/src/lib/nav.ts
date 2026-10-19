/**
 * The admin's pages, as the sidebar, the command palette and Settings →
 * Sidebar list them.
 *
 * `optional` pages stay out of the sidebar until they're in use (`usage`
 * returns a non-empty list), pinned in Settings → Sidebar, or open. They
 * keep working either way: the sidebar's "More" list and ⌘K reach them.
 */
export interface NavItem {
  id: string;
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  optional?: boolean;
  /** Admin endpoint listing what the page manages; any entry means in use. */
  usage?: string;
  /** Extra words for ⌘K matching. */
  hay?: string;
}

export interface NavSection { label: string; items: NavItem[] }

// Sidebar groupings — semantic, not feature-alphabetical. Per the
// Notifications redesign handoff (vaultbase/project/shell.jsx).
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Data",
    items: [
      { id: "dashboard",   to: "/_/",            label: "Dashboard",     icon: "grid", end: true },
      { id: "collections", to: "/_/collections", label: "Collections",   icon: "stack" },
      { id: "logs",        to: "/_/logs",        label: "Logs",          icon: "scroll" },
      { id: "monitoring",  to: "/_/monitoring",  label: "Monitoring",    icon: "activity", optional: true, hay: "monitoring metrics performance rps latency" },
    ],
  },
  {
    label: "Logic",
    items: [
      { id: "hooks",       to: "/_/hooks",       label: "Hooks",         icon: "zap", hay: "hooks routes cron jobs queues workers" },
      { id: "flags",       to: "/_/flags",       label: "Feature flags", icon: "flag", optional: true, usage: "/api/v1/admin/flags" },
      { id: "webhooks",    to: "/_/webhooks",    label: "Webhooks",      icon: "arrowUp", optional: true, usage: "/api/v1/admin/webhooks" },
      { id: "api-tokens",  to: "/_/api-tokens",  label: "API tokens",    icon: "key", optional: true, usage: "/api/v1/admin/api-tokens" },
    ],
  },
  {
    label: "Tools",
    items: [
      { id: "api-preview", to: "/_/api-preview", label: "API preview",   icon: "play", optional: true },
      { id: "sql",         to: "/_/sql",         label: "SQL",           icon: "database", optional: true, hay: "sql console query" },
      { id: "mcp",         to: "/_/mcp",         label: "MCP",           icon: "zap", hay: "mcp ai agents tokens" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "users",       to: "/_/users",       label: "Superusers",    icon: "users", hay: "superusers admins" },
      { id: "audit-log",   to: "/_/audit-log",   label: "Audit log",     icon: "scroll", optional: true },
      { id: "settings",    to: "/_/settings",    label: "Settings",      icon: "settings" },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
export const OPTIONAL_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((i) => i.optional);

/** Setting holding the optional pages pinned to the sidebar, comma-separated ids. */
export const SIDEBAR_PINNED_KEY = "admin.sidebar.pinned";

export function parsePinned(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function isNavActive(item: NavItem, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  const to = item.to.replace(/\/+$/, "") || "/";
  return item.end ? path === to : path === to || path.startsWith(to + "/");
}

/** Whether an item belongs in the sidebar right now. */
export function isNavShown(item: NavItem, s: { pinned: string[]; inUse: string[]; pathname: string }): boolean {
  if (!item.optional) return true;
  return s.pinned.includes(item.id) || s.inUse.includes(item.id) || isNavActive(item, s.pathname);
}
