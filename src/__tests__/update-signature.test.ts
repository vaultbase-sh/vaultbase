/**
 * `vaultbase update` installed a release with no cosign signature without
 * a word when cosign was available: verification only ran if the .sig and
 * .pem assets were present. A release missing them is now refused unless
 * --no-verify is passed.
 */
import { describe, expect, it } from "bun:test";
import { signaturePlan } from "../scripts/update.ts";

describe("update signature policy", () => {
  it("refuses an unsigned release when cosign is available", () => {
    expect(signaturePlan({ skipVerify: false, hasSignature: false, hasCosign: true })).toBe("refuse");
  });

  it("verifies a signed release (legitimate path)", () => {
    expect(signaturePlan({ skipVerify: false, hasSignature: true, hasCosign: true })).toBe("verify");
  });

  it("--no-verify and a missing cosign stay explicit choices", () => {
    expect(signaturePlan({ skipVerify: true, hasSignature: false, hasCosign: true })).toBe("skip");
    expect(signaturePlan({ skipVerify: false, hasSignature: false, hasCosign: false })).toBe("no-cosign");
  });
});
