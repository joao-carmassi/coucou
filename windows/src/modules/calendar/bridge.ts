import { commandOrThrow } from "../../kit/tauri";

/** A subscribed feed as the webview sees it: the slot and the host. The URL stays in the Credential Manager. */
export interface Feed { slot: number; host: string }
export interface Fetched { notModified: boolean; body: string }

export const CalendarBridge = {
  list: () => commandOrThrow<Feed[]>("calendar_list"),
  add: (url: string) => commandOrThrow<Feed>("calendar_add", { url }),
  remove: (slot: number) => commandOrThrow<void>("calendar_remove", { slot }),
  /** `have`: the caller still holds the last text, so "not modified" is an acceptable answer. */
  fetch: (slot: number, have: boolean) => commandOrThrow<Fetched>("calendar_fetch", { slot, have }),
};
