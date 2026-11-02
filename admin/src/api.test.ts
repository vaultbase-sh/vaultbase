import { afterEach, describe, expect, it } from "bun:test";
import { api, NETWORK_ERROR } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("admin api requests", () => {
  it("answer an unreachable server with the error shape instead of throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const res = await api.get<{ error?: string; code?: number }>("/api/v1/collections");
    expect(res).toEqual({ error: NETWORK_ERROR, code: 0 });
  });

  it("still normalise a non-JSON answer", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;
    const res = await api.get<{ error?: string; code?: number }>("/api/v1/collections");
    expect(res).toEqual({ error: "Bad Gateway", code: 502 });
  });
});
