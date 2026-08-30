import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretBox, secretHash } from "./remote-crypto.js";

describe("remote MCP secret storage", () => {
  it("authenticates ciphertext against its record context", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal("sensitive grant", "grant:one");
    expect(sealed).not.toContain("sensitive grant");
    expect(box.open(sealed, "grant:one")).toBe("sensitive grant");
    expect(() => box.open(sealed, "grant:two")).toThrow();
  });

  it("uses stable hashes without retaining plaintext", () => {
    expect(secretHash("token")).toBe(secretHash("token"));
    expect(secretHash("token")).not.toContain("token");
    expect(secretHash("different")).not.toBe(secretHash("token"));
  });
});
