// Three slaps → dizzy: the frame loop must keep drawing for the whole mood with no cursor events.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import "./setup";
import { Island } from "../../src/island/island";
import { State } from "../../src/core/state";

let island: Island;
beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  island.launch();
  vi.advanceTimersByTime(15_000);
});
afterAll(() => vi.useRealTimers());

it("dizzy keeps animating without mouse events", () => {
  island.open("overview");
  vi.advanceTimersByTime(1000);
  const eng = (island as unknown as { engine: { slap(): void; roll: number; state: string } }).engine;
  for (let i = 0; i < 3; i++) { eng.slap(); vi.advanceTimersByTime(100); }
  expect(eng.state).toBe("dizzy");
  const rolls = new Set<number>();
  for (let i = 0; i < 40; i++) { vi.advanceTimersByTime(16); rolls.add(eng.roll); }
  expect(rolls.size).toBeGreaterThan(10);
  expect(State.view).toBe("confused");
});
