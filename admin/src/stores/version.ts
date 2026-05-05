import { useEffect, useState } from "react";

let cached: string | null = null;
let inflight: Promise<string> | null = null;

async function fetchVersion(): Promise<string> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetch("/api/health", { headers: { accept: "application/json" } })
    .then(async (r) => {
      const json = await r.json().catch(() => ({}));
      const v = json?.data?.version;
      cached = typeof v === "string" && v.length > 0 ? v : "";
      return cached;
    })
    .catch(() => {
      cached = "";
      return cached;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useVersion(): string {
  const [v, setV] = useState<string>(cached ?? "");
  useEffect(() => {
    if (cached) { if (v !== cached) setV(cached); return; }
    let alive = true;
    fetchVersion().then((value) => { if (alive) setV(value); });
    return () => { alive = false; };
  }, [v]);
  return v;
}
