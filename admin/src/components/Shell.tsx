import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import Icon from "./Icon.tsx";
import { useAuth } from "../stores/auth.ts";

interface NavItem { to: string; label: string; icon: string }
interface NavSection { label: string; items: NavItem[] }

const SECTIONS: NavSection[] = [
  {
    label: "Data",
    items: [
      { to: "/_/collections",  label: "Collections",  icon: "database" },
      { to: "/_/logs",         label: "Logs",         icon: "scroll" },
      { to: "/_/api-preview",  label: "API preview",  icon: "play" },
    ],
  },
  {
    label: "Auth",
    items: [
      { to: "/_/tokens",       label: "API tokens",   icon: "key" },
      { to: "/_/hooks",        label: "Hooks",        icon: "webhook" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/_/users",        label: "Superusers",   icon: "users" },
      { to: "/_/settings",     label: "Settings",     icon: "settings" },
    ],
  },
];

export const Sidebar: React.FC = () => {
  const adminEmail = useAuth((s) => s.email);
  const navigate = useNavigate();
  const initials = adminEmail ? adminEmail[0]!.toUpperCase() : "A";

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-brand-mark" />
        <div className="sb-brand-name">vaultbase</div>
        <div className="sb-brand-version mono">v0.1.0</div>
      </div>
      {SECTIONS.map((sec) => (
        <div className="sb-section" key={sec.label}>
          <div className="sb-section-title">{sec.label}</div>
          <ul className="sb-nav">
            {sec.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    `sb-nav-item${isActive ? " active" : ""}`
                  }
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="sb-bottom">
        <div className="sb-admin-pill" onClick={() => navigate("/_/settings")}>
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
