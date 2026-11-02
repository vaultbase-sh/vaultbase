/**
 * Send a backup to the server in pieces (POST /admin/restore/uploads, then a
 * PUT per piece at its offset). A request body is capped at 128 MB, so a
 * larger backup can't go in one. A piece answered with 409 tells the size the
 * server has; sending goes on from there, so a lost answer costs nothing.
 * Returns the upload id to finish the restore with.
 */
export async function uploadInPieces(
  file: Blob,
  opts: { token: string | null; fetch?: typeof fetch; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
): Promise<string> {
  const f = opts.fetch ?? fetch;
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) });
  const start = await f("/api/v1/admin/restore/uploads", { method: "POST", credentials: "same-origin", headers: headers(), ...(opts.signal ? { signal: opts.signal } : {}) });
  const started = await start.json().catch(() => ({})) as { data?: { id: string; chunk_size: number }; error?: string };
  if (!start.ok || !started.data) throw new Error(started.error ?? `couldn't start the upload (${start.status})`);
  const { id, chunk_size: chunk } = started.data;
  let offset = 0;
  let tries = 0;
  while (offset < file.size) {
    const piece = file.slice(offset, Math.min(file.size, offset + chunk));
    const res = await f(`/api/v1/admin/restore/uploads/${encodeURIComponent(id)}?offset=${offset}`, {
      method: "PUT", credentials: "same-origin", headers: headers({ "Content-Type": "application/octet-stream" }), body: piece,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).catch((e: unknown) => { if (++tries > 3) throw e; return null; });
    if (!res) continue; // network error: send the piece again
    const json = await res.json().catch(() => ({})) as { data?: { size: number }; size?: number; error?: string };
    if (res.ok && json.data) { offset = json.data.size; tries = 0; }
    else if (res.status === 409 && typeof json.size === "number") offset = json.size;
    else throw new Error(json.error ?? `upload failed (${res.status})`);
    opts.onProgress?.(offset, file.size);
  }
  return id;
}
