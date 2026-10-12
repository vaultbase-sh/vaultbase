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
  setWSAuth, subscribe, MAX_REALTIME_CONNECTIONS, MAX_TOPICS_PER_CONNECTION, type WSLike,
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
