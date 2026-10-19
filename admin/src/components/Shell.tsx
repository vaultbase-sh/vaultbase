import React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import Icon from "./Icon.tsx";
import { VaultbaseLogo, VaultbaseWordmark } from "./VaultbaseLogo.tsx";
import { useAuth } from "../stores/auth.ts";
import { useVersion } from "../stores/version.ts";
import { useSidebar } from "../stores/sidebar.ts";
import { NAV_SECTIONS, favoriteItems, isNavActive, isNavShown, type NavItem } from "../lib/nav.ts";
import { toast } from "../stores/toast.ts";
import "../styles/sidebar-next.css";

/* ── SIDEBAR EXPERIMENT ──────────────────────────────────────────────────────
 * Opt-in redesign of the nav, derived from the auth boards. Everything it
 * needs lives in styles/sidebar-next.css under `.sidebar--next`; the classic
 * `.sb-*` rules in globals.css are untouched and apply whenever that class is
 * absent.
 *
 *   ?sidebar=classic  → old design (persists)
 *   ?sidebar=next     → new design (persists)
 *
 * To remove the experiment entirely: delete styles/sidebar-next.css, this
 * block, the import above, and the sidebarNextClass() call in <aside>.
 * ──────────────────────────────────────────────────────────────────────────── */
const SIDEBAR_PREF_KEY = "vb_sidebar_next";

function sidebarNextClass(): string {
  let on = true; // default while we are trying it out
  try {
    const q = new URLSearchParams(window.location.search).get("sidebar");
    if (q === "classic" || q === "next") {
      on = q === "next";
      localStorage.setItem(SIDEBAR_PREF_KEY, on ? "1" : "0");
    } else {
      const saved = localStorage.getItem(SIDEBAR_PREF_KEY);
      if (saved !== null) on = saved === "1";
    }
  } catch {
    /* private mode or blocked storage — fall back to the default */
  }
  return on ? " sidebar--next" : "";
}

export const Sidebar: React.FC = () => {
  const adminEmail = useAuth((s) => s.email);
  const version = useVersion();
  const navigate = useNavigate();
  const initial = adminEmail ? adminEmail[0]!.toLowerCase() : "a";
  const truncatedEmail = adminEmail && adminEmail.length > 22
    ? adminEmail.slice(0, 19) + "…"
    : adminEmail ?? "";

  // Favorites go first. Optional pages (lib/nav.ts) appear once they're in
  // use, pinned, favorited or open; the rest wait under "More".
  const { pathname } = useLocation();
  const { pinned, inUse, favorites, loaded, load, refreshUsage, toggleFavorite } = useSidebar();
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  // Leaving an optional page: it may have gained (or lost) its first entry.
  const prevPath = React.useRef(pathname);
  React.useEffect(() => {
    const left = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.optional && i.usage && isNavActive(i, prevPath.current));
    prevPath.current = pathname;
    if (left && !isNavActive(left, pathname)) void refreshUsage(left.id);
  }, [pathname, refreshUsage]);
  const shown = (item: NavItem) => !loaded ? !item.optional || isNavActive(item, pathname) : isNavShown(item, { pinned, inUse, favorites, pathname });
  const hidden = loaded ? NAV_SECTIONS.flatMap((s) => s.items).filter((i) => !shown(i)) : [];
  const favs = loaded ? favoriteItems(favorites) : [];
  const isFav = (item: NavItem) => favorites.includes(item.id);
  const star = async (item: NavItem) => {
    const err = await toggleFavorite(item.id);
    if (err) toast(err, "info");
  };
  const link = (item: NavItem) => (
    <li key={item.to} className="sb-nav-row">
      <NavLink
        to={item.to}
        end={item.end}
        className={({ isActive }) =>
          `sb-nav-item${isActive ? " active" : ""}`
        }
      >
        <Icon name={item.icon} size={13} />
        <span>{item.label}</span>
      </NavLink>
      {loaded && (
        <button
          type="button"
          className={`sb-fav${isFav(item) ? " on" : ""}`}
          aria-pressed={isFav(item)}
          aria-label={isFav(item) ? `Remove ${item.label} from favorites` : `Add ${item.label} to favorites`}
          title={isFav(item) ? "Remove from favorites" : "Add to favorites"}
          onClick={() => void star(item)}
        >
          <Icon name="star" size={12} />
        </button>
      )}
    </li>
  );

  return (
    <aside className={"sidebar" + sidebarNextClass()}>
      <div className="sb-brand">
        <span className="sb-brand-mark">
          <VaultbaseLogo size={20} />
        </span>
        <VaultbaseWordmark height={15} className="sb-brand-name" />
        {version && <div className="sb-brand-version mono">v{version}</div>}
      </div>
      {favs.length > 0 && (
        <div className="sb-section">
          <div className="sb-section-title">Favorites</div>
          <ul className="sb-nav">{favs.map(link)}</ul>
        </div>
      )}
      {NAV_SECTIONS.map((sec) => {
        const items = sec.items.filter((i) => shown(i) && !isFav(i));
        if (items.length === 0) return null;
        return (
          <div className="sb-section" key={sec.label}>
            <div className="sb-section-title">{sec.label}</div>
            <ul className="sb-nav">{items.map(link)}</ul>
          </div>
        );
      })}
      {hidden.length > 0 && (
        <div className="sb-section">
          <ul className="sb-nav">
            <li>
              <button
                type="button"
                className="sb-nav-item sb-more"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((o) => !o)}
              >
                <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={13} />
                <span>{moreOpen ? "Less" : `More (${hidden.length})`}</span>
              </button>
            </li>
            {moreOpen && hidden.map(link)}
          </ul>
        </div>
      )}
      <div className="sb-bottom">
        <div
          className="sb-admin-pill"
          onClick={() => navigate("/_/settings")}
          title={adminEmail ?? ""}
        >
          <div className="sb-admin-avatar">{initial}</div>
          <div className="sb-admin-meta">
            <div className="sb-admin-name">{truncatedEmail}</div>
            <div className="sb-admin-role mono">superuser</div>
          </div>
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
