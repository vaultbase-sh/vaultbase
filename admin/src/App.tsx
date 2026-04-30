import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import "./styles/globals.css";
import { api, type ApiResponse } from "./api.ts";
import { Sidebar } from "./components/Shell.tsx";
import { ToastHost } from "./components/UI.tsx";
import { ConfirmHost } from "./components/Confirm.tsx";
import { CommandPalette, useCommandPalette } from "./components/CommandPalette.tsx";
import { useAuth } from "./stores/auth.ts";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import NotFound from "./pages/NotFound.tsx";
import Collections from "./pages/Collections.tsx";
import Logs from "./pages/Logs.tsx";
import Settings from "./pages/Settings.tsx";
import Superusers from "./pages/Superusers.tsx";
import ApiPreview from "./pages/ApiPreview.tsx";

// Heavy pages — split into separate chunks (Monaco / Quill bundled inside)
const Records = lazy(() => import("./pages/Records.tsx"));
const CollectionEdit = lazy(() => import("./pages/CollectionEdit.tsx"));
const HooksPage = lazy(() => import("./pages/Hooks.tsx"));

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
 * Status endpoint is read-only (`GET /api/admin/setup/status`) so the probe
 * doesn't write to logs or trip rate limits.
 */
function SetupRedirect({ children }: { children: React.ReactNode }) {
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const isAuthed = useAuth((s) => s.isAuthed);
  const location = useLocation();
  const onSetup = location.pathname === "/_/setup";

  useEffect(() => {
    let cancelled = false;
    api.get<ApiResponse<{ has_admin: boolean }>>("/api/admin/setup/status")
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

function AppShell() {
  const palette = useCommandPalette();
  return (
    <div className="app">
      <Sidebar />
      <main className="app-main">
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
            <Route path="api-preview" element={<ApiPreview />} />
            <Route path="settings" element={<Settings />} />
            <Route path="users" element={<Superusers />} />
            <Route path="hooks" element={<HooksPage />} />
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
