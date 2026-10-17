// Boot sequence (entry file: boot/island.ts): boot the bridge, wire the island, start the greeting.

import "./style";
import { Bridge, IS_TAURI, onEvent, type Presence } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import type { ModuleDef, ModuleInfo } from "./core/moduleApi";
import { Registry } from "./core/registry";
import { Island } from "./island/island";

export async function startIsland(modules: ModuleDef[], catalog: ModuleInfo[]) {
  const root = document.getElementById("root");
  if (!root) return;

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  Registry.init(island, modules, catalog);
  Registry.apply(boot?.modules ?? Registry.defaults(State.settings.modulesEnabled));
  if (boot?.safeMode) island.note("Modo seguro: o Coucou não fechou bem nas últimas inicializações.");
  await onEvent<Record<string, boolean>>("modules-changed", Registry.apply);
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number; down: boolean }>("cursor", ({ x, y, down }) =>
    island.onCursor(x, y, down));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.setPaused(on)) void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.open("settings");
        break;
      case "open":
        setPaused(false);
        island.open(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<Presence>("presence", (p) => island.applyPresence(p));
  await onEvent<null>("palette", () => island.openFromHotkey());
  await onEvent<{ name: string; error: string }>("hotkey-error", (p) => {
    if (p.name === "palette" && p.error) island.error(`Atalho para abrir a ilha indisponível: ${p.error}`);
  });

  await onEvent<"moved" | "still" | "aborted">("island-drag-end", (end) => island.dragEnded(end));
  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // A hidden page gets no animation frames: the island would be heard but not seen.
  document.addEventListener("visibilitychange", () =>
    void Bridge.log(`ui  visibility ${document.visibilityState}`));

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
  });


  await onEvent<null>("companion-ready", () => island.companionReady());

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}
