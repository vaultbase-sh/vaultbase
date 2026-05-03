import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import Icon from "./Icon.tsx";
import { VaultbaseLogo } from "./VaultbaseLogo.tsx";
import { useAuth } from "../stores/auth.ts";

interface NavItem { to: string; label: string; icon: string; end?: boolean }
interface NavSection { label: string; items: NavItem[] }

const SECTIONS: NavSection[] = [
  {
    label: "Data",
    items: [
      { to: "/_/",             label: "Dashboard",    icon: "table", end: true },
      { to: "/_/collections",  label: "Collections",  icon: "database" },
      { to: "/_/logs",         label: "Logs",         icon: "scroll" },
      { to: "/_/api-preview",  label: "API preview",  icon: "play" },
    ],
  },
  {
    label: "Logic",
    items: [
      { to: "/_/hooks",        label: "Hooks",        icon: "webhook" },
      { to: "/_/flags",        label: "Feature flags", icon: "zap" },
      { to: "/_/webhooks",     label: "Webhooks",     icon: "upload" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/_/users",        label: "Superusers",   icon: "users" },
      { to: "/_/audit-log",    label: "Audit log",    icon: "shield" },
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
        <span className="sb-brand-mark">
          <VaultbaseLogo size={22} />
        </span>
        <div className="sb-brand-name">vaultbase</div>
        <div className="sb-brand-version mono">v0.7.1</div>
      </div>
      {SECTIONS.map((sec) => (
        <div className="sb-section" key={sec.label}>
          <div className="sb-section-title">{sec.label}</div>
          <ul className="sb-nav">
            {sec.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
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
//
// Two render modes:
//   - title (legacy): bold page title sits in the topbar.
//   - crumbs (per admin redesign v1.0): breadcrumb chain in the topbar; the
//     real page H1 lives inside the body via <PageHeader/> so scroll
//     consumes it.
export interface Crumb { label: React.ReactNode; to?: string }

export const Topbar: React.FC<{
  title?: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
  onBack?: () => void;
  crumbs?: Crumb[];
}> = ({ title, subtitle, actions, onBack, crumbs }) => (
  <div className="topbar">
    {onBack && (
      <button className="btn-icon" onClick={onBack} title="Back">
        <Icon name="chevronLeft" size={14} />
      </button>
    )}
    {crumbs && crumbs.length > 0 ? (
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <React.Fragment key={i}>
              {last ? (
                <span className="here">{c.label}</span>
              ) : c.to ? (
                <NavLink to={c.to}>{c.label}</NavLink>
              ) : (
                <span>{c.label}</span>
              )}
              {!last && <span className="sep">/</span>}
            </React.Fragment>
          );
        })}
      </nav>
    ) : (
      <div className="topbar-title">
        {title !== undefined && <h1>{title}</h1>}
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
    )}
    <div className="topbar-actions">{actions}</div>
  </div>
);

// PageHeader — body-level page heading per admin redesign v1.0.
// Use alongside <Topbar crumbs={...} /> for the new pattern; or skip and
// use Topbar's title prop for the legacy in-bar heading.
export const PageHeader: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, subtitle, actions }) => (
  <div className="page-h">
    <h1>{title}</h1>
    {subtitle && <div className="sub">{subtitle}</div>}
    {actions && <div className="actz">{actions}</div>}
  </div>
);
