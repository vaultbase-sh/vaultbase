/**
 * A read worker that speaks the pool's protocol without a database, for the
 * pool's failure tests. STUB_MODE=slow answers one request at a time, each
 * after STUB_DELAY_MS; STUB_MODE=stuck starts and never answers.
 */
declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, transfer?: ArrayBuffer[]): void };

const mode = process.env["STUB_MODE"] ?? "slow";
const delay = Number(process.env["STUB_DELAY_MS"] ?? 100);
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number };
  if (m.type === "start") { self.postMessage({ type: "ready" }); return; }
  if (m.type !== "request" || mode === "stuck") return;
  queue = queue.then(async () => {
    await Bun.sleep(delay);
    const body = new TextEncoder().encode(JSON.stringify({ id: m.id })).buffer as ArrayBuffer;
    self.postMessage({ type: "reply", id: m.id, status: 200, headers: [["content-type", "application/json"]], body }, [body]);
  });
};
