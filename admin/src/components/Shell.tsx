import React from "react";
import Icon from "./Icon.tsx";

export type Page =
  | "collections" | "records" | "collection-edit"
  | "logs" | "users" | "tokens" | "hooks" | "settings";

export interface Route { page: Page; coll?: string }

// Sidebar
export const Sidebar: React.FC<{
  route: Route;
  setRoute: (r: Route) => void;
  adminEmail: string;
}> = ({ route, setRoute, adminEmail }) => {
  const sections = [
    {
      label: "Data",
      items: [
        { id: "collections" as Page, label: "Collections", icon: "database" },
        { id: "logs" as Page, label: "Logs", icon: "scroll" },
      ],
    },
    {
      label: "Auth",
      items: [
        { id: "users" as Page, label: "Users", icon: "users" },
        { id: "tokens" as Page, label: "API tokens", icon: "key" },
        { id: "hooks" as Page, label: "Hooks", icon: "webhook" },
      ],
    },
    {
      label: "System",
      items: [
        { id: "settings" as Page, label: "Settings", icon: "settings" },
      ],
    },
  ];

  const initials = adminEmail ? adminEmail[0]!.toUpperCase() : "A";

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-brand-mark" />
        <div className="sb-brand-name">vaultbase</div>
        <div className="sb-brand-version mono">v0.1.0</div>
      </div>
      {sections.map((sec) => (
        <div className="sb-section" key={sec.label}>
          <div className="sb-section-title">{sec.label}</div>
          <ul className="sb-nav">
            {sec.items.map((item) => {
              const active =
                route.page === item.id ||
                (item.id === "collections" &&
                  (route.page === "collection-edit" || route.page === "records"));
              return (
                <li
                  key={item.id}
                  className={`sb-nav-item${active ? " active" : ""}`}
                  onClick={() => setRoute({ page: item.id })}
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="sb-bottom">
        <div className="sb-admin-pill" onClick={() => setRoute({ page: "settings" })}>
          <div className="sb-admin-avatar">{initials}</div>
          <div className="sb-admin-meta">
            <div className="sb-admin-name">{adminEmail}</div>
            <div className="sb-admin-role mono">superuser</div>
          </div>
          <Icon name="logout" size={13} style={{ color: "rgba(255,255,255,0.35)" }} />
        </div>
      </div>
    </aside>
  );
};

// Topbar
export const Topbar: React.FC<{
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
  onBack?: () => void;
}> = ({ title, subtitle, actions, onBack }) => (
  <div className="topbar">
    {onBack && (
      <button className="btn-icon" onClick={onBack} title="Back">
        <Icon name="chevronLeft" size={14} />
      </button>
    )}
    <div className="topbar-title">
      <h1>{title}</h1>
      {subtitle && <div className="sub">{subtitle}</div>}
    </div>
    <div className="topbar-actions">{actions}</div>
  </div>
);
