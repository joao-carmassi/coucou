// Voice assistant (F41): which registered action did the user ask for? Pure: no DOM, no timers.
// Only actions that modules registered can match; nothing outside that list is ever run.

import type { ActionInfo } from "../../core/moduleApi";

const FILLER = ["por favor", "ok coucou", "oi coucou", "coucou", "pfv"];
const STOP = new Set(["a", "o", "as", "os", "um", "uma", "de", "da", "do", "das", "dos", "para", "pra", "pro", "e", "no", "na", "em", "me", "que", "the", "to", "please"]);

export const THRESHOLD = 0.6;
export const MARGIN = 0.15;

export const normalize = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const words = (s: string): string[] => normalize(s).split(" ").filter(Boolean);

/** Words of what was said, without politeness filler and glue words. */
export function spoken(text: string): string[] {
  let t = ` ${normalize(text)} `;
  for (const f of FILLER) t = t.split(` ${f} `).join(" ");
  return t.split(" ").filter((w) => w && !STOP.has(w));
}

/** Share of the spoken words found in the action's title + keywords. */
function score(said: string[], a: ActionInfo): number {
  if (!said.length) return 0;
  const have = new Set([...words(a.title), ...(a.keywords ?? []).flatMap(words)]);
  return said.filter((w) => have.has(w)).length / said.length;
}

/** The action to run, or null: best score >= THRESHOLD and ahead of the runner-up by MARGIN (a tie runs nothing). */
export function match(text: string, actions: readonly ActionInfo[]): { key: string; score: number; title: string } | null {
  const said = spoken(text);
  const ranked = actions.map((a) => ({ a, s: score(said, a) })).sort((x, y) => y.s - x.s);
  const [best, next] = ranked;
  if (!best || best.s < THRESHOLD) return null;
  if (next && best.s - next.s < MARGIN) return null;
  return { key: best.a.key, score: best.s, title: best.a.title };
}
