/** The status a request was answered with, as the request log and metrics record it. */
import { describe, expect, it } from "bun:test";
import { status } from "elysia";
import { answeredStatus, thrownStatus } from "../core/http-status.ts";

describe("answeredStatus", () => {
  it("reads status(code, …), which leaves set.status alone", () => {
    expect(answeredStatus(status(401, { error: "Unauthorized" }), undefined)).toBe(401);
    expect(answeredStatus(status(409, {}), 200)).toBe(409);
  });

  it("takes a Response's status unless one was set explicitly", () => {
    expect(answeredStatus(new Response("x", { status: 206 }), undefined)).toBe(206);
    expect(answeredStatus(new Response("x"), 404)).toBe(404);
    expect(answeredStatus(new Response("x", { status: 302 }), 200)).toBe(302);
  });

  it("falls back to set.status, then 200", () => {
    expect(answeredStatus({ data: 1 }, 422)).toBe(422);
    expect(answeredStatus({ data: 1 }, undefined)).toBe(200);
  });
});

describe("thrownStatus", () => {
  it("reads a thrown status(code) and an error's own status", () => {
    expect(thrownStatus(status(409, {}))).toBe(409);
    expect(thrownStatus(Object.assign(new Error("x"), { status: 413 }))).toBe(413);
    expect(thrownStatus(new Error("x"))).toBeNull();
  });
});
