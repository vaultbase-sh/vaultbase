import { useLocation, useNavigate } from "react-router-dom";
import { Topbar } from "../components/Shell.tsx";
import Icon from "../components/Icon.tsx";

export default function NotFound() {
  const navigate = useNavigate();
  const loc = useLocation();
  return (
    <>
      <Topbar crumbs={[{ label: "404" }]} />
      <div className="app-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="empty-state" style={{ maxWidth: 480 }}>
          <div className="ic"><Icon name="search" size={20} /></div>
          <h4>Route not found</h4>
          <p>
            <code className="mono" style={{ color: "var(--text-secondary)" }}>{loc.pathname}</code> doesn't
            map to anything in the admin. Try the dashboard or use{" "}
            <span className="kbd-key">⌘</span><span className="kbd-key">K</span>{" "}
            to jump.
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => navigate("/_/")}>
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
