/**
 * Realtime hardening (handoff Medium "Realtime auth / limits"):
 *  - auth was checked once, when set: an expired or signed-out token kept a
 *    connection receiving protected events for as long as it stayed open;
 *  - connections and topics per connection had no cap;
 *  - SSE queued events for a client that stopped reading, without bound.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  _reset, admitConnection, broadcast, getSSEClient, reverifyRealtimeAuth, setSSESubscriptions,
  setWSAuth, subscribe, unregisterSSEClient, MAX_CONNECTIONS_PER_IP, MAX_REALTIME_CONNECTIONS,
  MAX_TOPIC_LENGTH, MAX_TOPICS_PER_CONNECTION, type WSLike,
} from "../realtime/manager.ts";
import { openSSEStream } from "../realtime/sse.ts";

beforeEach(() => _reset());

function fakeWs(id: string): WSLike & { got: string[] } {
  const got: string[] = [];
  return { data: { connId: id }, got, send: (m: string) => { got.push(m); } } as unknown as WSLike & { got: string[] };
}

const ownerOnly = { viewRule: "owner = @request.auth.id", record: { id: "r1", owner: "u1" } };
const event = { type: "create" as const, collection: "notes", record: { id: "r1", collectionId: "c", collectionName: "notes", created: 0, updated: 0 } };

describe("realtime auth after subscribe", () => {
  it("an expired token stops receiving protected events", () => {
    const ws = fakeWs("c1");
    subscribe(ws, ["notes"]);
    setWSAuth(ws, { id: "u1", type: "user", exp: Math.floor(Date.now() / 1000) - 1 });
    broadcast("notes", event, ownerOnly);
    expect(ws.got).toHaveLength(0);
  });

  it("a token that no longer verifies is dropped on re-verification", async () => {
    const ws = fakeWs("c1");
    subscribe(ws, ["notes"]);
    setWSAuth(ws, { id: "u1", type: "user", token: "revoked-token" });
    broadcast("notes", event, ownerOnly);
    expect(ws.got).toHaveLength(1); // still valid: delivered (legitimate path)
    await reverifyRealtimeAuth(async () => null);
    expect(ws.got.some((m) => m.includes("auth_expired"))).toBe(true);
    const before = ws.got.length;
    broadcast("notes", event, ownerOnly);
    expect(ws.got).toHaveLength(before);
  });
});

describe("realtime limits", () => {
  it("caps topics per connection", () => {
    const ws = fakeWs("c1");
    const accepted = subscribe(ws, Array.from({ length: MAX_TOPICS_PER_CONNECTION + 50 }, (_, i) => `t${i}`));
    expect(accepted).toHaveLength(MAX_TOPICS_PER_CONNECTION);
  });

  it("caps open connections", () => {
    for (let i = 0; i < MAX_REALTIME_CONNECTIONS; i++) expect(admitConnection(`c${i}`)).toBe(true);
    expect(admitConnection("one-too-many")).toBe(false);
  });

  it("an SSE client that stops reading is disconnected instead of buffering forever", () => {
    const { clientId } = openSSEStream()!;
    setSSESubscriptions(clientId, ["notes"]);
    const big = { ...event, record: { ...event.record, blob: "x".repeat(200_000) } };
    for (let i = 0; i < 20 && getSSEClient(clientId); i++) broadcast("notes", big as typeof event, { viewRule: null });
    expect(getSSEClient(clientId)).toBeUndefined();
  });
});

describe("review 11 follow-ups", () => {
  const listOnlyMine = { viewRule: null, listRule: "owner = @request.auth.id", record: { id: "r1", owner: "u1" } };

  it("a collection subscription follows the list rule", () => {
    const ws = fakeWs("c1");
    subscribe(ws, ["notes"]);
    setWSAuth(ws, { id: "someone-else", type: "user" });
    broadcast("notes", event, listOnlyMine);
    expect(ws.got).toHaveLength(0);
  });

  it("a per-record subscription needs only the view rule (legitimate path)", () => {
    const ws = fakeWs("c1");
    subscribe(ws, ["notes/r1"]);
    setWSAuth(ws, { id: "someone-else", type: "user" });
    broadcast("notes", event, listOnlyMine);
    expect(ws.got).toHaveLength(1);
  });

  it("over-long topics are refused", () => {
    const ws = fakeWs("c1");
    expect(subscribe(ws, ["x".repeat(MAX_TOPIC_LENGTH + 1), "notes"])).toEqual(["notes"]);
  });

  it("one address can't take every connection", () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) expect(admitConnection(`a${i}`, "203.0.113.9")).toBe(true);
    expect(admitConnection("one-more", "203.0.113.9")).toBe(false);
    expect(admitConnection("someone-else", "198.51.100.1")).toBe(true);
  });

  it("unregistering an SSE client closes its stream", async () => {
    const { clientId, response } = openSSEStream()!;
    const reader = response.body!.getReader();
    await reader.read(); // greeting
    unregisterSSEClient(clientId);
    expect((await reader.read()).done).toBe(true);
  });
});

describe("realtime sees the same auth props as HTTP (review 16 F-2)", () => {
  const exp = () => Math.floor(Date.now() / 1000) + 3600;
  const rec = { id: "r1", owner: "u1" };

  it("a guest session doesn't get events a guest-excluding rule refuses", () => {
    const ws = fakeWs("g1");
    subscribe(ws, ["notes"]);
    setWSAuth(ws, { id: "u1", type: "user", exp: exp(), collection: "users", anonymous: true });
    broadcast("notes", event, { viewRule: "@request.auth.anonymous = false", listRule: null, record: rec } as never);
    expect(ws.got.filter((m) => m.includes('"create"'))).toHaveLength(0);
  });

  it("another auth collection's user doesn't either", () => {
    const ws = fakeWs("c2");
    subscribe(ws, ["notes"]);
    setWSAuth(ws, { id: "u1", type: "user", exp: exp(), collection: "customers" });
    broadcast("notes", event, { viewRule: '@request.auth.collectionName = "staff"', listRule: null, record: rec } as never);
    expect(ws.got.filter((m) => m.includes('"create"'))).toHaveLength(0);
  });

  it("a matching account still does (legitimate path)", () => {
    const ws = fakeWs("s1");
    subscribe(ws, ["notes"]);
    setWSAuth(ws, { id: "u1", type: "user", exp: exp(), collection: "staff", verified: true });
    broadcast("notes", event, { viewRule: '@request.auth.collectionName = "staff" && @request.auth.verified = true', listRule: null, record: rec } as never);
    expect(ws.got.filter((m) => m.includes('"create"'))).toHaveLength(1);
  });
});

describe("re-verify refreshes auth flags (review 17 F-6)", () => {
  it("an account that lost verification stops passing verified rules", async () => {
    const ws = fakeWs("v1");
    subscribe(ws, ["notes"]);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    setWSAuth(ws, { id: "u1", type: "user", exp, token: "t", collection: "users", verified: true });
    await reverifyRealtimeAuth(async () => ({ id: "u1", type: "user", exp, token: "t", collection: "users" }));
    broadcast("notes", event, { viewRule: "@request.auth.verified = true", listRule: null, record: { id: "r1" } } as never);
    expect(ws.got.filter((m) => m.includes('"create"'))).toHaveLength(0);
  });
});
