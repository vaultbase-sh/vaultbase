import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import "./styles/globals.css";
// ADMIN THEME: redesign token layer. Remove this line to revert the whole
// app to the previous look — see src/styles/theme-next.css.
import "./styles/theme-next.css";
import "./styles/overlays.css";
import { api, type ApiResponse } from "./api.ts";
import { Sidebar } from "./components/Shell.tsx";
import { ToastHost } from "./components/UI.tsx";
import { ConfirmHost } from "./components/Confirm.tsx";
import { CommandPalette, useCommandPalette } from "./components/CommandPalette.tsx";
import { useAuth } from "./stores/auth.ts";
import { useMaintenance } from "./stores/maintenance.ts";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import NotFound from "./pages/NotFound.tsx";
import Collections from "./pages/Collections.tsx";
import Logs from "./pages/Logs.tsx";
import AuditLog from "./pages/AuditLog.tsx";
import Settings from "./pages/Settings.tsx";
import Superusers from "./pages/Superusers.tsx";
import ApiPreview from "./pages/ApiPreview.tsx";

// Heavy pages — split into separate chunks (Monaco / Quill bundled inside)
const Records = lazy(() => import("./pages/Records.tsx"));
const CollectionEdit = lazy(() => import("./pages/CollectionEdit.tsx"));
const HooksPage = lazy(() => import("./pages/Hooks.tsx"));
const FlagsPage = lazy(() => import("./pages/Flags.tsx"));
const WebhooksPage = lazy(() => import("./pages/Webhooks.tsx"));
const ApiTokensPage = lazy(() => import("./pages/ApiTokens.tsx"));
const McpPage = lazy(() => import("./pages/Mcp.tsx"));
const SqlPage = lazy(() => import("./pages/Sql.tsx"));
const MonitoringPage = lazy(() => import("./pages/Monitoring.tsx"));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthed = useAuth((s) => s.isAuthed);
  const loaded = useAuth((s) => s.loaded);
  if (!loaded) return null;
  if (!isAuthed) return <Navigate to="/_/login" replace />;
  return <>{children}</>;
}

function RequireUnauth({ children }: { children: React.ReactNode }) {
  const isAuthed = useAuth((s) => s.isAuthed);
  const loaded = useAuth((s) => s.loaded);
  if (!loaded) return null;
  if (isAuthed) return <Navigate to="/_/" replace />;
  return <>{children}</>;
}

/**
 * Boot-time check: probe whether any admin exists. Runs once at app mount.
 *   - No admin yet  → force redirect to /_/setup (any other route bounces).
 *   - Admin exists  → /_/setup is closed; bounce to /_/login (or /_/ if authed).
 * Status endpoint is read-only (`GET /api/v1/admin/setup/status`) so the probe
 * doesn't write to logs or trip rate limits.
 */
function SetupRedirect({ children }: { children: React.ReactNode }) {
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const isAuthed = useAuth((s) => s.isAuthed);
  const location = useLocation();
  const onSetup = location.pathname === "/_/setup";

  useEffect(() => {
    let cancelled = false;
    api.get<ApiResponse<{ has_admin: boolean }>>("/api/v1/admin/setup/status")
      .then((res) => { if (!cancelled) setHasAdmin(res.data?.has_admin ?? true); })
      .catch(() => { if (!cancelled) setHasAdmin(true); });
    return () => { cancelled = true; };
  }, []);

  if (hasAdmin === null) return null;

  // Fresh install: nothing is reachable until setup completes.
  if (!hasAdmin && !onSetup) return <Navigate to="/_/setup" replace />;

  // Admin already exists: setup is sealed off.
  if (hasAdmin && onSetup) return <Navigate to={isAuthed ? "/_/" : "/_/login"} replace />;

  return <>{children}</>;
}

function PageFallback() {
  return (
    <div style={{ flex: 1, padding: 40, color: "var(--text-muted)", textAlign: "center", fontSize: 12 }}>
      Loading…
    </div>
  );
}

/** Shown on every page while maintenance mode is on, so it isn't left on by accident. */
function MaintenanceBanner() {
  const level = useMaintenance((s) => s.level);
  const refresh = useMaintenance((s) => s.refresh);
  useEffect(() => {
    void refresh();
    // Another admin (or MCP) may switch it.
    const t = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);
  if (!level) return null;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      padding: "8px 28px", fontSize: 12.5,
      background: "color-mix(in srgb, var(--vb-status-warning) 14%, transparent)",
      borderBottom: "1px solid color-mix(in srgb, var(--vb-status-warning) 40%, transparent)",
      color: "var(--vb-fg)",
    }}>
      <strong>Maintenance mode is on.</strong>
      <span style={{ color: "var(--vb-fg-2)" }}>
        {level === "read_only" ? "Clients can read but not write." : "Clients get 503; only admins can use the API."}
      </span>
      <Link to="/_/settings?tab=maintenance" style={{ marginLeft: "auto", color: "var(--vb-fg)" }}>Settings</Link>
    </div>
  );
}

function AppShell() {
  const palette = useCommandPalette();
  return (
    <div className="app">
      <Sidebar />
      <main className="app-main">
        <MaintenanceBanner />
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </div>
  );
}

export default function App() {
  // Probe /me once at boot so RequireAuth/RequireUnauth have a real answer
  // before rendering the routes.
  useEffect(() => { useAuth.getState().load().catch(() => {}); }, []);
  return (
    <BrowserRouter>
      <SetupRedirect>
        <Routes>
          <Route path="/_/setup" element={<Setup />} />
          <Route
            path="/_/login"
            element={
              <RequireUnauth>
                <Login />
              </RequireUnauth>
            }
          />
          <Route
            path="/_"
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="collections" element={<Collections />} />
            <Route path="collections/:id/edit" element={<CollectionEdit />} />
            <Route path="collections/:id/records" element={<Records />} />
            <Route path="logs" element={<Logs />} />
            <Route path="audit-log" element={<AuditLog />} />
            <Route path="api-preview" element={<ApiPreview />} />
            <Route path="settings" element={<Settings />} />
            <Route path="users" element={<Superusers />} />
            <Route path="hooks" element={<HooksPage />} />
            <Route path="flags" element={<FlagsPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="api-tokens" element={<ApiTokensPage />} />
            <Route path="mcp" element={<McpPage />} />
            <Route path="sql" element={<SqlPage />} />
            <Route path="monitoring" element={<MonitoringPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="*" element={<Navigate to="/_/" replace />} />
        </Routes>
      </SetupRedirect>
      <ToastHost />
      <ConfirmHost />
    </BrowserRouter>
  );
}
