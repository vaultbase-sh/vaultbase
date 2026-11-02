import { describe, expect, it } from "bun:test";
import { uploadInPieces } from "./chunked-upload.ts";

/** A fake server holding one upload; `dropFirstAnswer` loses the answer to the first PUT. */
function fakeServer(chunk: number, dropFirstAnswer = false) {
  let stored = new Uint8Array(0);
  let dropped = !dropFirstAnswer;
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (init.method === "POST") return Response.json({ data: { id: "u1", chunk_size: chunk } });
    const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
    if (offset !== stored.length) return Response.json({ error: "offset", size: stored.length }, { status: 409 });
    const piece = new Uint8Array(await (init.body as Blob).arrayBuffer());
    const next = new Uint8Array(stored.length + piece.length);
    next.set(stored); next.set(piece, stored.length); stored = next;
    if (!dropped) { dropped = true; throw new TypeError("network"); }
    return Response.json({ data: { size: stored.length } });
  }) as unknown as typeof fetch;
  return { fetchFn, stored: () => stored };
}

describe("uploadInPieces", () => {
  it("sends the file in pieces of the server's size", async () => {
    const data = new Uint8Array(250).map((_, i) => i);
    const server = fakeServer(100);
    const seen: number[] = [];
    const id = await uploadInPieces(new Blob([data]), { token: null, fetch: server.fetchFn, onProgress: (s) => seen.push(s) });
    expect(id).toBe("u1");
    expect([...server.stored()]).toEqual([...data]);
    expect(seen).toEqual([100, 200, 250]);
  });

  it("goes on from the server's size after a lost answer", async () => {
    const data = new Uint8Array(250).map((_, i) => i);
    const server = fakeServer(100, true);
    await uploadInPieces(new Blob([data]), { token: null, fetch: server.fetchFn });
    expect([...server.stored()]).toEqual([...data]);
  });
});
