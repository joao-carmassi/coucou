import { describe, expect, it } from "vitest";
import { finalWidth } from "../../src/modules/claude/fit";

describe("finalWidth", () => {
  it("adds the island's growth to the lines, chrome held constant", () => {
    expect(finalWidth(400, 300, 640)).toBe(540);
  });
  it("is undefined without layout or when already wide", () => {
    expect(finalWidth(0, 0, 640)).toBeUndefined();
    expect(finalWidth(640, 540, 640)).toBeUndefined();
  });
});
