import { describe, expect, it, beforeEach } from "bun:test";
import { subscribe, broadcast, setWSAuth, _reset } from "../realtime/manager.ts";

interface MockWS {
  sent: string[];
  send(data: string): void;
  data: { connId: string };
}

let _mockId = 0;
function mockWs(): MockWS {
  return {
    sent: [],
    send(data) { this.sent.push(data); },
    data: { connId: `rules-${++_mockId}` },
  };
}

function rec(extra: Record<string, unknown> = {}): { record: Parameters<typeof broadcast>[1] extends infer E ? (E extends { record: infer R } ? R : never) : never; raw: Record<string, unknown> } {
  const raw = { id: "rec1", owner: "u1", title: "hi", ...extra };
  const record = {
    collectionId: "c1",
    collectionName: "posts",
    created: 0,
    updated: 0,
    ...raw,
  };
  return { record: record as never, raw };
}

describe("realtime per-record rule filtering", () => {
  beforeEach(() => _reset());

  it("no opts → legacy behavior, all subscribers receive", () => {
    const a = mockWs(); const b = mockWs();
    subscribe(a, ["posts"]); subscribe(b, ["posts"]);
    setWSAuth(a, { id: "u1", type: "user" });
    // b has no auth at all
    const r = rec();
    broadcast("posts", { type: "create", collection: "posts", record: r.record });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("public viewRule (null) → everyone receives", () => {
    const a = mockWs(); const b = mockWs();
    subscribe(a, ["posts"]); subscribe(b, ["posts"]);
    setWSAuth(a, { id: "u1", type: "user" });
    const r = rec();
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: null, record: r.raw }
    );
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("admin-only viewRule (\"\") → admin receives, user skipped", () => {
    const userWs = mockWs(); const adminWs = mockWs();
    subscribe(userWs, ["posts"]); subscribe(adminWs, ["posts"]);
    setWSAuth(userWs, { id: "u1", type: "user" });
    setWSAuth(adminWs, { id: "a1", type: "admin" });
    const r = rec();
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: "", record: r.raw }
    );
    expect(userWs.sent).toHaveLength(0);
    expect(adminWs.sent).toHaveLength(1);
  });

  it("expression viewRule → owner sees, stranger skipped", () => {
    const owner = mockWs(); const stranger = mockWs();
    subscribe(owner, ["posts"]); subscribe(stranger, ["posts"]);
    setWSAuth(owner, { id: "u1", type: "user" });
    setWSAuth(stranger, { id: "u2", type: "user" });
    const r = rec();
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: "owner = @request.auth.id", record: r.raw }
    );
    expect(owner.sent).toHaveLength(1);
    expect(stranger.sent).toHaveLength(0);
  });

  it("admin always passes regardless of expression", () => {
    const admin = mockWs();
    subscribe(admin, ["posts"]);
    setWSAuth(admin, { id: "a1", type: "admin" });
    const r = rec();
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: "owner = @request.auth.id", record: r.raw }  // owner=u1, not a1
    );
    expect(admin.sent).toHaveLength(1);
  });

  it("delete event filters using the just-deleted snapshot", () => {
    const owner = mockWs(); const stranger = mockWs();
    subscribe(owner, ["posts"]); subscribe(stranger, ["posts"]);
    setWSAuth(owner, { id: "u1", type: "user" });
    setWSAuth(stranger, { id: "u2", type: "user" });
    const r = rec();
    broadcast(
      "posts",
      { type: "delete", collection: "posts", id: r.raw["id"] as string },
      { viewRule: "owner = @request.auth.id", record: r.raw }
    );
    expect(owner.sent).toHaveLength(1);
    expect(stranger.sent).toHaveLength(0);
  });

  it("unauthenticated subscriber on @request.auth rule → skipped", () => {
    const guest = mockWs();
    subscribe(guest, ["posts"]);
    // no setWSAuth for guest
    const r = rec();
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: '@request.auth.id != ""', record: r.raw }
    );
    expect(guest.sent).toHaveLength(0);
  });

  it("wildcard topic still respects view_rule", () => {
    const owner = mockWs(); const stranger = mockWs();
    subscribe(owner, ["*"]); subscribe(stranger, ["*"]);
    setWSAuth(owner, { id: "u1", type: "user" });
    setWSAuth(stranger, { id: "u2", type: "user" });
    const r = rec();
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: "owner = @request.auth.id", record: r.raw }
    );
    expect(owner.sent).toHaveLength(1);
    expect(stranger.sent).toHaveLength(0);
  });
});
