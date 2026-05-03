import { describe, expect, it, beforeEach } from "bun:test";
import { subscribe, unsubscribe, disconnectAll, broadcast, normalizeTopic, _reset } from "../realtime/manager.ts";

interface MockWS {
  sent: string[];
  send(data: string): void;
}

function mockWs(): MockWS {
  const ws: MockWS = { sent: [], send(data) { this.sent.push(data); } };
  return ws;
}

describe("RealtimeManager", () => {
  beforeEach(() => _reset());

  it("subscribe then broadcast delivers event", () => {
    const ws = mockWs();
    subscribe(ws, ["posts"]);
    broadcast("posts", { type: "create", collection: "posts", record: { id: "1", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } });
    expect(ws.sent).toHaveLength(1);
    const event = JSON.parse(ws.sent[0]!);
    expect(event.type).toBe("create");
    expect(event.collection).toBe("posts");
  });

  it("unsubscribe stops delivery", () => {
    const ws = mockWs();
    subscribe(ws, ["posts"]);
    unsubscribe(ws, ["posts"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    expect(ws.sent).toHaveLength(0);
  });

  it("disconnectAll removes from all subscriptions", () => {
    const ws = mockWs();
    subscribe(ws, ["posts", "users"]);
    disconnectAll(ws);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    broadcast("users", { type: "delete", collection: "users", id: "2" });
    expect(ws.sent).toHaveLength(0);
  });

  it("broadcast to collection with no subscribers is a no-op", () => {
    expect(() =>
      broadcast("empty", { type: "delete", collection: "empty", id: "x" })
    ).not.toThrow();
  });

  it("dead socket removed from set on send error", () => {
    const dead: MockWS = {
      sent: [],
      send() { throw new Error("WebSocket is closed"); },
    };
    subscribe(dead, ["posts"]);
    expect(() =>
      broadcast("posts", { type: "delete", collection: "posts", id: "1" })
    ).not.toThrow();
    expect(() =>
      broadcast("posts", { type: "delete", collection: "posts", id: "2" })
    ).not.toThrow();
  });

  it("multiple subscribers all receive event", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    subscribe(ws1, ["posts"]);
    subscribe(ws2, ["posts"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    expect(ws1.sent).toHaveLength(1);
    expect(ws2.sent).toHaveLength(1);
  });

  it("subscribe to specific record only receives events for that record", () => {
    const ws = mockWs();
    subscribe(ws, ["posts/abc"]);
    broadcast("posts", { type: "create", collection: "posts", record: { id: "abc", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } });
    broadcast("posts", { type: "create", collection: "posts", record: { id: "xyz", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!).record.id).toBe("abc");
  });

  it("delete event reaches the per-record subscriber", () => {
    const ws = mockWs();
    subscribe(ws, ["posts/abc"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "abc" });
    broadcast("posts", { type: "delete", collection: "posts", id: "xyz" });
    expect(ws.sent).toHaveLength(1);
  });

  it("wildcard '*' receives every event across collections", () => {
    const ws = mockWs();
    subscribe(ws, ["*"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    broadcast("users", { type: "delete", collection: "users", id: "2" });
    broadcast("comments", { type: "delete", collection: "comments", id: "3" });
    expect(ws.sent).toHaveLength(3);
  });

  it("a ws subscribed to BOTH collection and record gets a single event (deduped)", () => {
    const ws = mockWs();
    subscribe(ws, ["posts", "posts/abc", "*"]);
    broadcast("posts", { type: "create", collection: "posts", record: { id: "abc", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } });
    expect(ws.sent).toHaveLength(1);
  });

  it("collection sub doesn't receive events from a different collection", () => {
    const ws = mockWs();
    subscribe(ws, ["posts"]);
    broadcast("users", { type: "delete", collection: "users", id: "1" });
    expect(ws.sent).toHaveLength(0);
  });

  it("collection sub still receives events for any record in that collection", () => {
    const ws = mockWs();
    subscribe(ws, ["posts"]);
    broadcast("posts", { type: "create", collection: "posts", record: { id: "a", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } });
    broadcast("posts", { type: "create", collection: "posts", record: { id: "b", collectionId: "c", collectionName: "posts", created: 0, updated: 0 } });
    expect(ws.sent).toHaveLength(2);
  });

  // ── topic normalisation ──────────────────────────────────────────────

  describe("normalizeTopic", () => {
    it("strips .* and /* trailing wildcard", () => {
      expect(normalizeTopic("posts.*")).toBe("posts");
      expect(normalizeTopic("posts/*")).toBe("posts");
    });
    it("preserves canonical forms", () => {
      expect(normalizeTopic("posts")).toBe("posts");
      expect(normalizeTopic("posts/abc123")).toBe("posts/abc123");
      expect(normalizeTopic("*")).toBe("*");
    });
    it("rejects empty / whitespace-only", () => {
      expect(normalizeTopic("")).toBeNull();
      expect(normalizeTopic("   ")).toBeNull();
    });
    it("trims whitespace", () => {
      expect(normalizeTopic("  posts  ")).toBe("posts");
    });
  });

  it("subscribe then unsubscribe with .* wildcard form removes the same key", () => {
    const ws = mockWs();
    // Canonical subscribe.
    subscribe(ws, ["posts"]);
    // Unsub with the wildcard variant — should still hit `posts`.
    const removed = unsubscribe(ws, ["posts.*"]);
    expect(removed).toEqual(["posts"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    expect(ws.sent).toHaveLength(0);
  });

  it("subscribe with .* form is reachable via canonical broadcast", () => {
    const ws = mockWs();
    subscribe(ws, ["posts.*"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    expect(ws.sent).toHaveLength(1);
  });

  it("subscribe returns the canonical accepted topics", () => {
    const ws = mockWs();
    const accepted = subscribe(ws, ["posts.*", "users/*", "*", "  ", ""]);
    expect(accepted).toEqual(["posts", "users", "*"]);
  });

  it("unsubscribe returns only the topics that actually had this socket", () => {
    const ws = mockWs();
    subscribe(ws, ["posts"]);
    const removed = unsubscribe(ws, ["posts.*", "users.*"]);
    expect(removed).toEqual(["posts"]);
  });
});
