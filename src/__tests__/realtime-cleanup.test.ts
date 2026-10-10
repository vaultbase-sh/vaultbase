import { describe, expect, it, beforeEach } from "bun:test";
import {
  _reset, _topicCount, disconnectAll, listSubsFor, registerSSEClient, setSSESubscriptions,
  subscribe, unregisterSSEClient, unsubscribe,
} from "../realtime/manager.ts";

// Every `posts/<id>` subscription left an empty topic map behind forever, and
// disconnect / listSubsFor / setSSESubscriptions scanned every topic ever
// seen, so cost and memory grew with the number of distinct records watched.

function fakeWs(id: string) {
  return { data: { connId: id }, send() {} } as never;
}

beforeEach(() => _reset());

describe("realtime topic cleanup", () => {
  it("unsubscribing the last listener removes the topic", () => {
    const ws = fakeWs("c1");
    subscribe(ws, ["posts/a", "posts/b"]);
    expect(_topicCount()).toBe(2);
    unsubscribe(ws, ["posts/a"]);
    expect(_topicCount()).toBe(1);
    unsubscribe(ws, ["posts/b"]);
    expect(_topicCount()).toBe(0);
  });

  it("disconnect removes topics only this connection held, keeps shared ones", () => {
    const a = fakeWs("a");
    const b = fakeWs("b");
    subscribe(a, ["posts", "posts/1"]);
    subscribe(b, ["posts"]);
    disconnectAll(a);
    expect(_topicCount()).toBe(1);
    expect(listSubsFor(b)).toEqual(["posts"]);
    expect(listSubsFor(a)).toEqual([]);
  });

  it("SSE re-subscribe and unregister leave no empty topics", () => {
    const sse = fakeWs("sse-1");
    registerSSEClient("sse-1", sse);
    setSSESubscriptions("sse-1", ["posts/1", "posts/2"]);
    setSSESubscriptions("sse-1", ["posts/3"]);
    expect(_topicCount()).toBe(1);
    expect(listSubsFor(sse)).toEqual(["posts/3"]);
    unregisterSSEClient("sse-1");
    expect(_topicCount()).toBe(0);
  });
});

describe("dead sockets", () => {
  it("a socket whose send throws is dropped from every topic", async () => {
    const { broadcast } = await import("../realtime/manager.ts");
    const broken = { data: { connId: "dead" }, send() { throw new Error("closed"); } } as never;
    subscribe(broken, ["posts", "posts/1", "comments"]);
    broadcast("posts", { type: "delete", collection: "posts", id: "1" });
    expect(listSubsFor(broken)).toEqual([]);
    expect(_topicCount()).toBe(0);
  });
});
