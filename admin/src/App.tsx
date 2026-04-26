import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles/globals.css";
import { api, type ApiResponse } from "./api.ts";
import { Sidebar, type Route as AppRoute } from "./components/Shell.tsx";
import { ToastProvider, type ToastHandle } from "./components/UI.tsx";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
import Collections from "./pages/Collections.tsx";
import Records from "./pages/Records.tsx";
import CollectionEdit from "./pages/CollectionEdit.tsx";
import Logs from "./pages/Logs.tsx";
import Settings from "./pages/Settings.tsx";
import Superusers from "./pages/Superusers.tsx";
import ApiPreview from "./pages/ApiPreview.tsx";

function tokenValid(): boolean {
  const token = localStorage.getItem("vaultbase_admin_token");
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1]!));
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem("vaultbase_admin_token");
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!tokenValid()) return <Navigate to="/_/login" replace />;
  return <>{children}</>;
}

function RequireUnauth({ children }: { children: React.ReactNode }) {
  if (tokenValid()) return <Navigate to="/_/" replace />;
  return <>{children}</>;
}

function SetupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "needs-setup" | "exists">("loading");
  useEffect(() => {
    if (tokenValid()) { setState("exists"); return; }
    // POST setup with empty body — backend returns 400 if admin exists
    api.post<ApiResponse<{ id: string }>>("/api/admin/setup", {})
      .then((res) => setState(res.code === 400 ? "exists" : "needs-setup"))
      .catch(() => setState("needs-setup"));
  }, []);
  if (state === "loading") return null;
  if (state === "exists") return <Navigate to={tokenValid() ? "/_/" : "/_/login"} replace />;
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

function AppShell() {
  const toastRef = useRef<ToastHandle>(null);
  const [route, setRoute] = useState<AppRoute>({ page: "collections" });

  const adminEmail = (() => {
    const token = localStorage.getItem("vaultbase_admin_token");
    if (!token) return "";
    try {
      const payload = JSON.parse(atob(token.split(".")[1]!));
      return (payload.email as string) ?? "";
    } catch { return ""; }
  })();

  const toast = useCallback((text: string, _icon?: string) => {
    const severity = _icon === "trash" ? "warn" : "success";
    toastRef.current?.show(text, severity);
  }, []);

  let page: React.ReactNode;
  switch (route.page) {
    case "collections":
      page = <Collections setRoute={setRoute} toast={toast} />;
      break;
    case "records":
      page = <Records setRoute={setRoute} route={route} toast={toast} />;
      break;
    case "collection-edit":
      page = <CollectionEdit setRoute={setRoute} route={route} toast={toast} />;
      break;
    case "logs":
      page = <Logs />;
      break;
    case "api-preview":
      page = <ApiPreview />;
      break;
    case "settings":
      page = <Settings adminEmail={adminEmail} toast={toast} />;
      break;
    case "users":
      page = <Superusers adminEmail={adminEmail} toast={toast} />;
      break;
    case "tokens":
      page = <StubPage title="API tokens" hint="Scoped tokens for programmatic access. Coming in v2." />;
      break;
    case "hooks":
      page = <StubPage title="Hooks" hint="Event-driven webhooks for record mutations. Coming in v2." />;
      break;
    default:
      page = <Collections setRoute={setRoute} toast={toast} />;
  }

  return (
    <>
      <div className="app">
        <Sidebar route={route} setRoute={setRoute} adminEmail={adminEmail} />
        <main className="app-main">{page}</main>
      </div>
      <ToastProvider ref={toastRef} />
    </>
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
          path="/_/*"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/_/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
