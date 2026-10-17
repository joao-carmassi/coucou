import { expect, it } from "vitest";
import { compactWidth } from "../../src/core/layout";

it("compactWidth hysteresis: a still line flapping by one digit keeps the wider width", () => {
  const wide = compactWidth(0, 100, 16);
  const flap = compactWidth(0, 93, 16);
  expect(flap).toBeLessThan(wide); // precondition: the plain snap would jump
  expect(compactWidth(0, 93, 16, wide)).toBe(wide);
  expect(compactWidth(0, 100, 16, flap)).toBe(wide); // growing is immediate
  expect(compactWidth(0, 40, 16, wide)).toBe(compactWidth(0, 40, 16)); // real shrink follows
  expect(compactWidth(0, 93, 16, 0)).toBe(flap); // no previous width: plain
});
