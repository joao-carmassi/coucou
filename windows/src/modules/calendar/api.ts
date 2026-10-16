// Types only. The calendar's one door for other modules: a module that has events of its own (bookings, deadlines)
// provides `calendar.source`; the calendar asks every provider on refresh (`api.useAll`), imports none of them.
export interface CalendarSourceEvent {
  id: string;
  title: string;
  /** Unix ms. */
  start: number;
  /** Unix ms; defaults to start + 30 min. */
  end?: number;
  /** An https link to join / open. */
  link?: string;
}
export type CalendarSource = () => Promise<readonly CalendarSourceEvent[]>;
export const CALENDAR_SERVICE = { source: "calendar.source" } as const;
