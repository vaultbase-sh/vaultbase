import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import "./styles/globals.css";
import { api, type ApiResponse } from "./api.ts";
import { Sidebar } from "./components/Shell.tsx";
import { ToastHost } from "./components/UI.tsx";
import { ConfirmHost } from "./components/Confirm.tsx";
import { useAuth } from "./stores/auth.ts";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
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
  if (!isAuthed) return <Navigate to="/_/login" replace />;
  return <>{children}</>;
}

function RequireUnauth({ children }: { children: React.ReactNode }) {
  const isAuthed = useAuth((s) => s.isAuthed);
  if (isAuthed) return <Navigate to="/_/" replace />;
  return <>{children}</>;
}

function SetupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "needs-setup" | "exists">("loading");
  const isAuthed = useAuth((s) => s.isAuthed);
  useEffect(() => {
    if (isAuthed) { setState("exists"); return; }
    api.post<ApiResponse<{ id: string }>>("/api/admin/setup", {})
      .then((res) => setState(res.code === 400 ? "exists" : "needs-setup"))
      .catch(() => setState("needs-setup"));
  }, [isAuthed]);
  if (state === "loading") return null;
  if (state === "exists") return <Navigate to={isAuthed ? "/_/" : "/_/login"} replace />;
  return <>{children}</>;
}

function StubPage({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ flex: 1, padding: 40, color: "var(--text-muted)", textAlign: "center" }}>
      <div style={{ fontSize: 14, marginBottom: 8, color: "var(--text-secondary)" }}>{title}</div>
      <div style={{ fontSize: 12 }}>{hint}</div>
    </div>
  );
}

function PageFallback() {
  return (
    <div style={{ flex: 1, padding: 40, color: "var(--text-muted)", textAlign: "center", fontSize: 12 }}>
      Loading…
    </div>
  );
}

function AppShell() {
  return (
    <div className="app">
      <Sidebar />
      <main className="app-main">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/_/setup"
          element={
            <SetupGate>
              <Setup />
            </SetupGate>
          }
        />
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
          <Route index element={<Navigate to="collections" replace />} />
          <Route path="collections" element={<Collections />} />
          <Route path="collections/:id/edit" element={<CollectionEdit />} />
          <Route path="collections/:id/records" element={<Records />} />
          <Route path="logs" element={<Logs />} />
          <Route path="api-preview" element={<ApiPreview />} />
          <Route path="settings" element={<Settings />} />
          <Route path="users" element={<Superusers />} />
          <Route path="hooks" element={<HooksPage />} />
          <Route
            path="tokens"
            element={<StubPage title="API tokens" hint="Scoped tokens for programmatic access. Coming in v2." />}
          />
        </Route>
        <Route path="*" element={<Navigate to="/_/" replace />} />
      </Routes>
      <ToastHost />
      <ConfirmHost />
    </BrowserRouter>
  );
}
