import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { _reset, broadcast, getSSEClient, setSSESubscriptions, unregisterSSEClient } from "../realtime/manager.ts";
import { openSSEStream } from "../realtime/sse.ts";

beforeEach(() => _reset());
afterEach(() => _reset());

/**
 * Drain whatever chunks are sitting in the stream. Reads in a tight loop, then
 * cancels the reader once a single read sits idle past `quietMs` — the cancel
 * resolves any in-flight read with `{ done: true }` so we never leave an
 * orphan that would swallow chunks meant for a later test step.
 *
 * Each test creates its own stream + reader, so cancelling here is safe.
 */
type AnyReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };

async function drain(reader: AnyReader, quietMs = 80): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  await new Promise((r) => setTimeout(r, 10)); // let sync enqueues land
  let cancelled = false;
  while (!cancelled) {
    let perReadTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ done: true }>((res) => {
      perReadTimer = setTimeout(() => { void reader.cancel(); res({ done: true }); }, quietMs);
    });
    const result = await Promise.race([reader.read(), timeout]);
    if (perReadTimer) clearTimeout(perReadTimer);
    if (result.done) { cancelled = true; break; }
    if (result.value) out += decoder.decode(result.value, { stream: true });
  }
  return out;
}

describe("SSE realtime", () => {
  it("opens a stream and sends a connect event with the clientId", async () => {
    const { response, clientId } = openSSEStream();
    expect(typeof clientId).toBe("string");
    expect(clientId.length).toBeGreaterThan(8);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const text = await drain(reader);
    expect(text).toContain("event: connect");
    expect(text).toContain(`"clientId":"${clientId}"`);
    reader.cancel();
  });

  it("registers the client so the manager can find it by id", () => {
    const { clientId } = openSSEStream();
    expect(getSSEClient(clientId)).toBeDefined();
    unregisterSSEClient(clientId);
    expect(getSSEClient(clientId)).toBeUndefined();
  });

  it("delivers broadcast events as SSE 'message' frames", async () => {
    const { response, clientId } = openSSEStream();
    setSSESubscriptions(clientId, ["posts"]);
    broadcast("posts", {
      type: "create",
      collection: "posts",
      record: {
        id: "p1", collectionId: "c", collectionName: "posts",
        created: 0, updated: 0, title: "hi",
      },
    });

    const text = await drain(response.body!.getReader());
    expect(text).toContain("event: connect");
    expect(text).toContain("event: message");
    expect(text).toContain('"type":"create"');
    expect(text).toContain('"id":"p1"');
  });

  it("setSSESubscriptions replaces the topic list (PUT semantics)", async () => {
    const { response, clientId } = openSSEStream();

    setSSESubscriptions(clientId, ["posts"]);
    setSSESubscriptions(clientId, ["users"]); // replace, drop "posts"

    broadcast("posts", { type: "delete", collection: "posts", id: "p1" });
    broadcast("users", { type: "delete", collection: "users", id: "u1" });

    const text = await drain(response.body!.getReader());
    expect(text).toContain('"collection":"users"');
    // The "posts" delete should NOT make it through. Match precisely: connect
    // frame won't contain the broadcast collection field.
    expect(text).not.toContain('"id":"p1"');
  });

  it("respects view_rule filtering via the same shouldSendTo path as WS", async () => {
    const { response, clientId } = openSSEStream();
    setSSESubscriptions(clientId, ["posts"]);
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: { id: "p1", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } },
      { viewRule: "", record: { id: "p1" } } // admin-only; this client has no auth
    );

    const text = await drain(response.body!.getReader());
    expect(text).toContain("event: connect"); // connect arrives as always
    expect(text).not.toContain('"type":"create"'); // filtered
  });

  it("unregister drops the client from subscriptions and the registry", () => {
    const { clientId } = openSSEStream();
    setSSESubscriptions(clientId, ["posts", "users"]);
    expect(getSSEClient(clientId)).toBeDefined();
    unregisterSSEClient(clientId);
    expect(getSSEClient(clientId)).toBeUndefined();
    // Broadcasting after unregister should not throw — the dropped client
    // is no longer in any topic set.
    expect(() => broadcast("posts", { type: "delete", collection: "posts", id: "p1" })).not.toThrow();
  });
});
