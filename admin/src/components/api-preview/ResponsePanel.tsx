import { useState } from "react";
import Icon from "../Icon.tsx";
import { toast } from "../../stores/toast.ts";
import { curlSnippet, fetchSnippet, sdkSnippet, type ApiRequest } from "../../lib/api-client.ts";

export interface ApiResponseInfo {
  status: number;
  ms: number;
  size: number;
  contentType: string;
  /** Text bodies; binary ones are described instead. */
  body: string;
  binary: boolean;
  headers: Array<[string, string]>;
  /** Set when the request never reached the server (or was refused before). */
  error?: string;
}

type Tab = "body" | "headers" | "code";
type Lang = "curl" | "fetch" | "sdk";

function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pretty(r: ApiResponseInfo): string {
  if (r.contentType.includes("json")) {
    try { return JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* not JSON after all */ }
  }
  return r.body;
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`, "check"),
    () => toast("Couldn't copy to the clipboard", "info"),
  );
}

/** The response to the active request, and the request as code. */
export function ResponsePanel({
  req,
  res,
  sending,
  kinds,
}: {
  req: ApiRequest;
  res: ApiResponseInfo | null;
  sending: boolean;
  /** Collection name → type, so SDK code can use singletons. */
  kinds: Record<string, string>;
}) {
  const [tab, setTab] = useState<Tab>("body");
  const [raw, setRaw] = useState(false);
  const [lang, setLang] = useState<Lang>("sdk");
  const origin = window.location.origin;
  const code = lang === "curl" ? curlSnippet(req, origin) : lang === "fetch" ? fetchSnippet(req, origin) : sdkSnippet(req, origin, kinds);

  const tone = !res || res.error ? "danger" : res.status < 300 ? "success" : res.status < 400 ? "info" : res.status < 500 ? "warning" : "danger";

  return (
    <div className="ap-panel">
      <div className="ap-tabs" role="tablist">
        <button type="button" role="tab" className="ap-tab" aria-selected={tab === "body"} onClick={() => setTab("body")}>Response</button>
        <button type="button" role="tab" className="ap-tab" aria-selected={tab === "headers"} onClick={() => setTab("headers")}>
          Headers{res && !res.error && <span className="ap-count">{res.headers.length}</span>}
        </button>
        <button type="button" role="tab" className="ap-tab" aria-selected={tab === "code"} onClick={() => setTab("code")}>Code</button>
      </div>

      {tab === "code" && (
        <>
          <div className="ap-status">
            <div className="ap-seg" role="group" aria-label="Language">
              {(["sdk", "fetch", "curl"] as Lang[]).map((l) => (
                <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
                  {l === "sdk" ? "Vaultbase SDK" : l === "fetch" ? "fetch()" : "curl"}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <button className="btn-icon" title="Copy code" aria-label="Copy code" onClick={() => copy(code, "Code")}>
              <Icon name="copy" size={12} />
            </button>
          </div>
          <pre className="ap-pre">{code}</pre>
          <div className="ap-body"><div className="ap-hint">Tokens are shown as <code>&lt;token&gt;</code>; put your own in.</div></div>
        </>
      )}

      {tab !== "code" && !res && (
        <div className="ap-empty">{sending ? "Sending…" : <>Send the request to see its response. <kbd>⌘</kbd> <kbd>↵</kbd> sends too.</>}</div>
      )}

      {tab !== "code" && res && (
        <>
          <div className="ap-status">
            <span className={`badge ${tone}`} style={{ fontSize: 11 }}>{res.error ? "ERR" : res.status}</span>
            <span className="muted mono" style={{ fontSize: 11 }}>{res.ms} ms</span>
            {!res.error && <span className="muted mono" style={{ fontSize: 11 }}>{formatSize(res.size)}</span>}
            {res.contentType && <span className="muted mono" style={{ fontSize: 11 }}>{res.contentType.split(";")[0]}</span>}
            <span style={{ flex: 1 }} />
            {tab === "body" && !res.binary && !res.error && (
              <div className="ap-seg" role="group" aria-label="Format">
                <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>Pretty</button>
                <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
              </div>
            )}
            {tab === "body" && !res.binary && (
              <button className="btn-icon" title="Copy response" aria-label="Copy response" onClick={() => copy(res.error ?? res.body, "Response")}>
                <Icon name="copy" size={12} />
              </button>
            )}
          </div>
          {tab === "body" && (
            <pre className="ap-pre">
              {res.error
                ? res.error
                : res.binary
                  ? `Binary response, ${formatSize(res.size)} of ${res.contentType || "unknown type"}.`
                  : (raw ? res.body : pretty(res)) || "(empty)"}
            </pre>
          )}
          {tab === "headers" && (
            <table className="ap-headers">
              <tbody>
                {res.headers.map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{v}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
