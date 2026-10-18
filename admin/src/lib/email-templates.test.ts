/**
 * The admin's default email texts are what it shows (and saves) before an
 * admin edits a template. They must equal what the server sends when the
 * setting is empty, or "Restore default" restores something else.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_EMAIL_TEMPLATES } from "./email-templates.ts";
import { DEFAULT_TEMPLATES } from "../../../src/core/email.ts";

describe("email template defaults", () => {
  it("match the server's, for every template the server has", () => {
    expect(Object.keys(DEFAULT_EMAIL_TEMPLATES).sort()).toEqual(Object.keys(DEFAULT_TEMPLATES).sort());
    for (const kind of Object.keys(DEFAULT_TEMPLATES) as Array<keyof typeof DEFAULT_TEMPLATES>) {
      expect(DEFAULT_EMAIL_TEMPLATES[kind]).toEqual({ ...DEFAULT_TEMPLATES[kind] });
    }
  });
});
