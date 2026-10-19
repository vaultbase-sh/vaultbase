import { useState } from "react";
import { CodeEditor } from "../LazyCodeEditor.tsx";
import Icon from "../Icon.tsx";
import { VbBtn } from "../Vb.tsx";
import { KvTable } from "./KvTable.tsx";
import {
  hasBody, pathParamNames,
  type ApiRequest, type AuthMode, type BodyMode, type FormField, type KV,
} from "../../lib/api-client.ts";

type Tab = "params" | "headers" | "auth" | "body";

export interface UserSession { collection: string; email: string; token: string }

const kv = (key: string, value: string): KV => ({ key, value, on: true });
const formRow = (key: string, value: string): FormField => ({ key, value, on: true, file: null });

/** Params, Headers, Auth and Body for one open request. */
export function RequestPanel({
  req,
  onChange,
  authCollections,
  sessions,
  onSignIn,
}: {
  req: ApiRequest;
  onChange: (next: ApiRequest) => void;
  /** Auth collection names, for signing in as a user. */
  authCollections: string[];
  /** Users signed in this page load (tokens are kept in memory only). */
  sessions: UserSession[];
  onSignIn: (collection: string, email: string, password: string) => Promise<string | null>;
}) {
  const [tab, setTab] = useState<Tab>(hasBody(req.method) ? "body" : "params");
  const set = (patch: Partial<ApiRequest>) => onChange({ ...req, ...patch });
  const pathNames = pathParamNames(req.path);
  const enabled = (rows: { on: boolean; key: string }[]) => rows.filter((r) => r.on && r.key).length;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "params", label: "Params", count: enabled(req.params) + pathNames.length },
    { id: "headers", label: "Headers", count: enabled(req.headers) },
    { id: "auth", label: "Auth" },
    { id: "body", label: "Body" },
  ];

  return (
    <div className="ap-panel">
      <div className="ap-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" className="ap-tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {!!t.count && <span className="ap-count">{t.count}</span>}
            {t.id === "auth" && <span className="ap-count">{AUTH_LABEL[req.auth.mode]}</span>}
            {t.id === "body" && hasBody(req.method) && req.bodyMode !== "none" && <span className="ap-count">{req.bodyMode === "json" ? "JSON" : "form"}</span>}
          </button>
        ))}
      </div>

      <div className="ap-body">
        {tab === "params" && (
          <>
            {pathNames.length > 0 && (
              <>
                <div className="ap-hint">Path values</div>
                <table className="ap-kv">
                  <tbody>
                    {pathNames.map((name) => (
                      <tr key={name}>
                        <td />
                        <td><input className="input mono" value={name} readOnly aria-label="Path value name" /></td>
                        <td>
                          <input
                            className="input mono"
                            value={req.pathValues[name] ?? ""}
                            placeholder={`{${name}}`}
                            aria-label={`Value for ${name}`}
                            onChange={(e) => set({ pathValues: { ...req.pathValues, [name]: e.target.value } })}
                          />
                        </td>
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="ap-hint">Query params</div>
              </>
            )}
            <KvTable rows={req.params} onChange={(params) => set({ params })} make={kv} keyPlaceholder="perPage" valuePlaceholder="10" />
            <div className="ap-hint">
              Lists take <code>page</code>, <code>perPage</code>, <code>filter</code>, <code>sort</code>, <code>expand</code>, <code>fields</code>, <code>search</code> and <code>skipTotal</code>.
            </div>
          </>
        )}

        {tab === "headers" && (
          <>
            <KvTable rows={req.headers} onChange={(headers) => set({ headers })} make={kv} keyPlaceholder="X-Header" />
            <div className="ap-hint">
              <code>Authorization</code> comes from the Auth tab, and <code>Content-Type</code> from the body, unless you set them here.
            </div>
          </>
        )}

        {tab === "auth" && (
          <AuthTab req={req} set={set} authCollections={authCollections} sessions={sessions} onSignIn={onSignIn} />
        )}

        {tab === "body" && (
          hasBody(req.method) ? (
            <>
              <div className="ap-seg" role="group" aria-label="Body type">
                {(["none", "json", "form"] as BodyMode[]).map((m) => (
                  <button key={m} type="button" aria-pressed={req.bodyMode === m} onClick={() => set({ bodyMode: m })}>
                    {m === "none" ? "None" : m === "json" ? "JSON" : "Form data"}
                  </button>
                ))}
              </div>
              {req.bodyMode === "json" && (
                <CodeEditor value={req.body} onChange={(body) => set({ body })} language="json" height={220} />
              )}
              {req.bodyMode === "form" && (
                <>
                  <KvTable
                    rows={req.form}
                    onChange={(form) => set({ form })}
                    make={formRow}
                    keyPlaceholder="field"
                    renderValue={(row, patch) => (
                      <div className="ap-row" style={{ flexWrap: "nowrap" }}>
                        {row.file
                          ? <span className="mono" style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{row.file.name}</span>
                          : <input className="input mono" value={row.value} placeholder="value" aria-label="Value" onChange={(e) => patch({ value: e.target.value })} />}
                        {row.file ? (
                          <button type="button" className="btn-icon" title="Use text instead" aria-label="Remove the file" onClick={() => patch({ file: null })}>
                            <Icon name="x" size={12} />
                          </button>
                        ) : (
                          <label className="btn-icon" title="Attach a file" style={{ cursor: "pointer" }}>
                            <Icon name="upload" size={12} />
                            <input type="file" style={{ display: "none" }} onChange={(e) => patch({ file: e.target.files?.[0] ?? null })} />
                          </label>
                        )}
                      </div>
                    )}
                  />
                  <div className="ap-hint">Sent as <code>multipart/form-data</code>; attach files to upload them to a file field.</div>
                </>
              )}
            </>
          ) : (
            <div className="ap-hint">{req.method} requests have no body.</div>
          )
        )}
      </div>
    </div>
  );
}

const AUTH_LABEL: Record<AuthMode, string> = { none: "none", admin: "admin", bearer: "token", user: "user" };

function AuthTab({
  req, set, authCollections, sessions, onSignIn,
}: {
  req: ApiRequest;
  set: (patch: Partial<ApiRequest>) => void;
  authCollections: string[];
  sessions: UserSession[];
  onSignIn: (collection: string, email: string, password: string) => Promise<string | null>;
}) {
  const [collection, setCollection] = useState(req.auth.collection ?? authCollections[0] ?? "");
  const [email, setEmail] = useState(req.auth.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setAuth = (patch: Partial<ApiRequest["auth"]>) => set({ auth: { ...req.auth, ...patch } });
  const active = sessions.find((s) => s.collection === req.auth.collection && s.email === req.auth.email);

  async function signIn() {
    setBusy(true);
    setError(null);
    const err = await onSignIn(collection, email, password);
    setBusy(false);
    if (err) { setError(err); return; }
    setPassword("");
    setAuth({ mode: "user", collection, email });
  }

  return (
    <>
      <div className="ap-seg" role="group" aria-label="Send as">
        {(["admin", "user", "bearer", "none"] as AuthMode[]).map((m) => (
          <button key={m} type="button" aria-pressed={req.auth.mode === m} onClick={() => setAuth({ mode: m })}>
            {m === "admin" ? "Admin" : m === "user" ? "A user" : m === "bearer" ? "Token" : "No auth"}
          </button>
        ))}
      </div>

      {req.auth.mode === "admin" && (
        <div className="ap-hint">Sent with your admin session. Admins pass every rule, so use <b>A user</b> or <b>No auth</b> to see what others get.</div>
      )}
      {req.auth.mode === "none" && (
        <div className="ap-hint">Sent with no credentials, as a signed-out visitor.</div>
      )}
      {req.auth.mode === "bearer" && (
        <>
          <input
            className="input mono"
            value={req.auth.token ?? ""}
            onChange={(e) => setAuth({ token: e.target.value })}
            placeholder="Token"
            aria-label="Bearer token"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ap-hint">Sent as <code>Authorization: Bearer …</code>. Kept with this tab only, never saved.</div>
        </>
      )}
      {req.auth.mode === "user" && (
        authCollections.length === 0 ? (
          <div className="ap-hint">There are no auth collections yet. Create one to sign in as its users here.</div>
        ) : (
          <>
            {active && (
              <div className="ap-hint">Sending as <b>{active.email}</b> from <code>{active.collection}</code>.</div>
            )}
            {sessions.length > 0 && (
              <div className="ap-row">
                {sessions.map((s) => (
                  <VbBtn
                    key={`${s.collection}:${s.email}`}
                    kind={s === active ? "soft" : "ghost"}
                    size="sm"
                    icon={s === active ? "check" : "user"}
                    onClick={() => setAuth({ mode: "user", collection: s.collection, email: s.email })}
                  >
                    {s.email} · {s.collection}
                  </VbBtn>
                ))}
              </div>
            )}
            <form className="ap-row" onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
              <select className="input" value={collection} onChange={(e) => setCollection(e.target.value)} aria-label="Auth collection" style={{ width: 140 }}>
                {authCollections.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" autoComplete="off" style={{ flex: 1, minWidth: 160 }} />
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" autoComplete="new-password" style={{ flex: 1, minWidth: 120 }} />
              <VbBtn kind="primary" size="sm" type="submit" disabled={busy || !collection || !email || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </VbBtn>
            </form>
            {error && <div className="ap-hint" style={{ color: "var(--danger, #ff7b7b)" }}>{error}</div>}
            <div className="ap-hint">Signs in through <code>/api/v1/auth/&lt;collection&gt;/login</code>. The token stays in this page's memory and is gone on reload.</div>
          </>
        )
      )}
    </>
  );
}
