// Exemplo (demo): two pills and a status line on start, all gone on stop. Only moduleApi, so the registry is enough.
import { beforeAll, describe, expect, it } from "vitest";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Compact } from "../../src/core/compact";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { demoModule } from "../../src/modules/demo";

beforeAll(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [demoModule], buildCatalog([{ id: "demo", label: "Exemplo", default: false, order: 90 }], true));
});

describe("demo module", () => {
  it("shows two pills and a status line while on, and clears them when off", () => {
    Registry.apply({ demo: true });
    expect(State.pills.filter((p) => p.owner === "demo").map((p) => p.id)).toEqual(["demo-alfa", "demo-beta"]);
    expect(Compact.resolve(0)?.text).toBe("Exemplo");
    Registry.apply({ demo: false });
    expect(State.pills.some((p) => p.owner === "demo")).toBe(false);
    expect(Compact.resolve(0)).toBeNull();
  });
});
