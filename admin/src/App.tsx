import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Collections from "./pages/Collections.tsx";
import Records from "./pages/Records.tsx";
import Settings from "./pages/Settings.tsx";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("vaultbase_admin_token");
  if (!token) return <Navigate to="/_/login" replace />;
  return <>{children}</>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const links = [
    { label: "Dashboard", href: "/_/" },
    { label: "Collections", href: "/_/collections" },
    { label: "Settings", href: "/_/settings" },
  ];
  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 220, background: "#18181b", color: "#e4e4e7", padding: "24px 0", flexShrink: 0 }}>
        <div style={{ padding: "0 20px 24px", fontWeight: 700, fontSize: 18, color: "#fff" }}>
          Vaultbase
        </div>
        {links.map(({ label, href }) => (
          <a
            key={href}
            href={href}
            style={{ display: "block", padding: "10px 20px", color: "#a1a1aa", textDecoration: "none" }}
          >
            {label}
          </a>
        ))}
      </nav>
      <main style={{ flex: 1, padding: 32, background: "#fff" }}>{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/_/login" element={<Login />} />
        <Route
          path="/_/"
          element={
            <RequireAuth>
              <Layout>
                <Dashboard />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/_/collections"
          element={
            <RequireAuth>
              <Layout>
                <Collections />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/_/collections/:id/records"
          element={
            <RequireAuth>
              <Layout>
                <Records />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/_/settings"
          element={
            <RequireAuth>
              <Layout>
                <Settings />
              </Layout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/_/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
