import { describe, expect, it, beforeEach } from "bun:test";
import { subscribe, unsubscribe, disconnectAll, broadcast, _reset } from "../realtime/manager.ts";

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
});
