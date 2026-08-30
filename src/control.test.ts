import { describe, expect, it } from "vitest";
import {
  isCancelCommand,
  sanitizeForSpeech,
  shouldAdaptForSpeech,
} from "./control.js";

describe("spoken control", () => {
  it("accepts only clear standalone cancellation phrases", () => {
    expect(isCancelCommand("Cancel that!")).toBe(true);
    expect(isCancelCommand("stop")).toBe(true);
    expect(isCancelCommand("don't stop working")).toBe(false);
    expect(isCancelCommand("stop and tell me why")).toBe(false);
  });

  it("sanitizes rich output for local fallback speech", () => {
    const result = sanitizeForSpeech(
      "# Result\n- Read [the docs](https://example.test).\n```ts\nsecret();\n```",
    );
    expect(result).not.toContain("https://");
    expect(result).not.toContain("```");
    expect(result).toContain("Read the docs");
  });

  it("adapts only output that benefits from a speech rewrite", () => {
    expect(shouldAdaptForSpeech("Done. The service is healthy.")).toBe(false);
    expect(shouldAdaptForSpeech("# Result\n- one\n- two")).toBe(true);
  });
});
