// The pin button a module view embeds: pins this module's one-line source on the compact island, or releases it.
// Shows its state; call sync() from the view's sync(). The core keeps one pinned line at a time (pinning another replaces it).
import type { IslandApi } from "../core/moduleApi";
import { h, svg } from "./dom";
import { ICONS } from "./icons";

export const PIN_TITLE = { off: "Fixar na ilha", on: "Soltar" } as const;
export const pinTitle = (on: boolean) => (on ? PIN_TITLE.on : PIN_TITLE.off);

export function pinButton(api: IslandApi, key: string): { el: HTMLButtonElement; sync(): void } {
  const el = h("button", { class: "pin-btn", type: "button" }, svg(ICONS.pin, 14));
  const sync = () => {
    const on = api.status.pinned(key);
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", String(on));
    el.title = pinTitle(on);
    el.setAttribute("aria-label", pinTitle(on));
  };
  el.addEventListener("click", () => {
    api.status.pin(key, !api.status.pinned(key));
    sync();
  });
  sync();
  return { el, sync };
}
