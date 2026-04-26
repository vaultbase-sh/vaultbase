import { useCallback, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import "./styles/globals.css";
import { Sidebar, type Route as AppRoute } from "./components/Shell.tsx";
import { ToastHost, type Toast } from "./components/UI.tsx";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
import Collections from "./pages/Collections.tsx";
import Records from "./pages/Records.tsx";
import CollectionEdit from "./pages/CollectionEdit.tsx";
import Logs from "./pages/Logs.tsx";
import Settings from "./pages/Settings.tsx";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("vaultbase_admin_token");
  if (!token) return <Navigate to="/_/login" replace />;
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
  const navigate = useNavigate();
  const [route, setRoute] = useState<AppRoute>({ page: "collections" });
  const [toasts, setToasts] = useState<Toast[]>([]);

  const adminEmail = (() => {
    const token = localStorage.getItem("vaultbase_admin_token");
    if (!token) return "";
    try {
      const payload = JSON.parse(atob(token.split(".")[1]!));
      return payload.email as string ?? "";
    } catch { return ""; }
  })();

  const toast = useCallback((text: string, icon?: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
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
    case "settings":
      page = <Settings adminEmail={adminEmail} toast={toast} />;
      break;
    case "users":
      page = <StubPage title="Users" hint="Manage auth collection users from Data → Collections." />;
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
      <ToastHost toasts={toasts} />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/_/setup" element={<Setup />} />
        <Route path="/_/login" element={<Login />} />
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
