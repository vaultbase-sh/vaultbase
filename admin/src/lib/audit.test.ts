import { describe, expect, it } from "bun:test";
import { auditRecordRef, recordHistoryHref } from "./audit.ts";

describe("auditRecordRef", () => {
  it("reads the collection and id an MCP or restore entry names", () => {
    expect(auditRecordRef("collection=posts id=abc-123")).toEqual({ collection: "posts", id: "abc-123" });
    expect(auditRecordRef("collection=posts name=x id=r1")).toEqual({ collection: "posts", id: "r1" });
  });
  it("is null without both, or for look-alike keys", () => {
    expect(auditRecordRef(null)).toBeNull();
    expect(auditRecordRef("collection=posts")).toBeNull();
    expect(auditRecordRef("id=r1")).toBeNull();
    expect(auditRecordRef("subcollection=posts uid=r1")).toBeNull();
    expect(auditRecordRef("posts")).toBeNull();
  });
});

describe("recordHistoryHref", () => {
  it("links the records page with the history open, encoded", () => {
    expect(recordHistoryHref("posts", "a b")).toBe("/_/collections/posts/records?record=a%20b&history=1");
  });
});
