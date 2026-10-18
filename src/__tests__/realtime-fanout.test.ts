/**
 * Realtime fan-out can't hold the server. One event to many subscribers was
 * one synchronous loop with a rule check per subscriber; past ~100k messages a
 * second it held the main thread and HTTP waited (a 10,000-subscriber load
 * test stalled the event loop for 30 s). Now the decision is made once per
 * event where it can be (public, admin-only, once per distinct auth for an
 * expression), large fan-outs go out in time slices through one ordered
 * queue, and a queue that falls too far behind sheds its waiting connections.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  _reset, _setFanoutMaxBacklog, broadcast, broadcastSystem, realtimeStats, setWSAuth, subscribe,
  FANOUT_INLINE_MAX, type WSLike,
} from "../realtime/manager.ts";

beforeEach(() => _reset());
afterEach(() => { _setFanoutMaxBacklog(null); _reset(); });

interface Fake { ws: WSLike; got: string[]; terminated: () => boolean }
function fake(id: string, cost = 0): Fake {
  const got: string[] = [];
  let term = false;
  const raw = { getBufferedAmount: () => 0, terminate: () => { term = true; } };
  const ws = {
    data: { connId: id }, raw,
    send: (m: string) => {
      if (cost) { const t = performance.now() + cost; while (performance.now() < t) { /* simulated send cost */ } }
      got.push(m);
    },
  } as unknown as WSLike;
  return { ws, got, terminated: () => term };
}
const many = (n: number, topic = "notes", cost = 0) => Array.from({ length: n }, (_, i) => {
  const f = fake(`c${i}`, cost);
  subscribe(f.ws, [topic]);
  return f;
});
const rec = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "create" as const, collection: "notes", record: { id, collectionId: "c", collectionName: "notes", created: 0, updated: 0, ...extra } });
const drained = async () => { for (let i = 0; i < 2000 && realtimeStats().queuedDeliveries > 0; i++) await new Promise((r) => setImmediate(r)); };

describe("who receives an event", () => {
  it("a public collection reaches every subscriber, signed in or not", () => {
    const subs = many(10);
    setWSAuth(subs[0]!.ws, { id: "u1", type: "user" });
    broadcast("notes", rec("r1"), { viewRule: null, listRule: null, record: { id: "r1" } });
    expect(subs.every((s) => s.got.length === 1)).toBe(true);
  });

  it("admin-only reaches admins only", () => {
    const [a, u, anon] = many(3);
    setWSAuth(a!.ws, { id: "a1", type: "admin" });
    setWSAuth(u!.ws, { id: "u1", type: "user" });
    broadcast("notes", rec("r1"), { viewRule: "", record: { id: "r1" } });
    expect([a!.got.length, u!.got.length, anon!.got.length]).toEqual([1, 0, 0]);
  });

  it("an owner rule is decided per identity, not shared across users", () => {
    const subs = many(6);
    subs.forEach((s, i) => { if (i < 4) setWSAuth(s.ws, { id: `u${i % 2}`, type: "user", collection: "users" }); });
    // u0 owns it: subscribers 0 and 2 are u0, 1 and 3 are u1, 4 and 5 anonymous.
    broadcast("notes", rec("r1", { owner: "u0" }), { viewRule: "owner = @request.auth.id", record: { id: "r1", owner: "u0" } });
    expect(subs.map((s) => s.got.length)).toEqual([1, 0, 1, 0, 0, 0]);
  });

  it("the list rule still applies on collection-wide topics, not per-record ones", () => {
    const wide = fake("wide"); subscribe(wide.ws, ["notes"]);
    const one = fake("one"); subscribe(one.ws, ["notes/r1"]);
    broadcast("notes", rec("r1"), { viewRule: null, listRule: "", record: { id: "r1" } });
    expect([wide.got.length, one.got.length]).toEqual([0, 1]);
  });

  it("a connection on two matching topics gets the event once", () => {
    const f = fake("both"); subscribe(f.ws, ["notes", "*"]);
    broadcast("notes", rec("r1"), { viewRule: null, record: { id: "r1" } });
    expect(f.got).toHaveLength(1);
  });
});

describe("large fan-outs", () => {
  it("a small fan-out is delivered at once", () => {
    const subs = many(FANOUT_INLINE_MAX);
    broadcast("notes", rec("r1"));
    expect(subs.every((s) => s.got.length === 1)).toBe(true);
  });

  it("a large one is queued and arrives complete and in order", async () => {
    const subs = many(FANOUT_INLINE_MAX * 3);
    for (let k = 0; k < 3; k++) broadcast("notes", rec(`r${k}`));
    expect(realtimeStats().queuedDeliveries).toBeGreaterThan(0);
    await drained();
    for (const s of subs) expect(s.got.map((m) => JSON.parse(m).record.id)).toEqual(["r0", "r1", "r2"]);
  });

  it("lets other work run while it sends", async () => {
    many(8_000, "notes", 0.005); // ~5 µs a send: ~40 ms for one event
    let ranAfter = -1;
    broadcast("notes", rec("r1"));
    setTimeout(() => { ranAfter = realtimeStats().queuedDeliveries; }, 0);
    await drained();
    await Bun.sleep(5);
    // The timer ran while deliveries were still queued, not after the whole loop.
    expect(ranAfter).toBeGreaterThan(0);
  });

  it("a system message sent behind a queued event arrives after it", async () => {
    const subs = many(FANOUT_INLINE_MAX + 10);
    const sys = fake("sys"); subscribe(sys.ws, ["notes", "__flags"]);
    broadcast("notes", rec("r1"));
    broadcastSystem("__flags", { type: "flags" });
    await drained();
    expect(sys.got.map((m) => JSON.parse(m).type)).toEqual(["create", "flags"]);
    expect(subs.at(-1)!.got).toHaveLength(1);
  });

  it("sheds the waiting connections when the queue falls too far behind", async () => {
    _setFanoutMaxBacklog(FANOUT_INLINE_MAX * 3);
    const subs = many(FANOUT_INLINE_MAX * 2);
    for (let k = 0; k < 3; k++) broadcast("notes", rec(`r${k}`));
    expect(realtimeStats().shedConnections).toBe(subs.length);
    expect(subs.every((s) => s.terminated())).toBe(true);
    await drained();
    expect(realtimeStats().queuedDeliveries).toBe(0);
    // Shed connections left their topics: nothing more is sent to them.
    const before = subs[0]!.got.length;
    broadcast("notes", rec("r9"));
    await drained();
    expect(subs[0]!.got.length).toBe(before);
  });
});
