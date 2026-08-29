import { describe, expect, it } from "vitest";
import { encodeS2SGuidance } from "./s2s.js";

describe("KAME S2S control protocol", () => {
  it("encodes replacement guidance as one safe line", () => {
    expect(encodeS2SGuidance("First line\nsecond\tline")).toBe(
      "R\tFirst line second line\n",
    );
  });

  it("can append guidance without resetting queued tokens", () => {
    expect(encodeS2SGuidance("next", false)).toBe("A\tnext\n");
  });
});
