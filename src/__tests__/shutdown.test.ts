/**
 * SIGTERM exited as soon as logs were flushed, dropping requests in flight.
 * shutdownGracefully() stops the listener, lets in-flight requests finish
 * (bounded), then runs cleanup.
 */
import { describe, expect, it } from "bun:test";
import { shutdownGracefully } from "../core/shutdown.ts";

describe("graceful shutdown", () => {
  it("lets an in-flight request finish before cleanup runs", async () => {
    const order: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await Bun.sleep(300);
        order.push("request done");
        return new Response("ok");
      },
    });
    const inFlight = fetch(`http://127.0.0.1:${server.port}/`);
    await Bun.sleep(50);
    const outcome = await shutdownGracefully({
      stopServer: () => server.stop(false),
      cleanup: [() => { order.push("cleanup"); }],
      timeoutMs: 5000,
    });
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(outcome).toBe("drained");
    expect(order).toEqual(["request done", "cleanup"]);
  });

  it("gives up waiting after the timeout and still cleans up", async () => {
    const order: string[] = [];
    const outcome = await shutdownGracefully({
      stopServer: () => new Promise(() => { /* never drains */ }),
      cleanup: [() => { throw new Error("boom"); }, () => { order.push("cleanup"); }],
      timeoutMs: 50,
    });
    expect(outcome).toBe("timeout");
    expect(order).toEqual(["cleanup"]);
  });
});
