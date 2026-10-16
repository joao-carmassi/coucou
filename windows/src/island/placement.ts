// Alt-drag placement of the compact island (pure, so the rule is testable headless).

/**
 * What an Alt-drag commits on release: the logical dx to add to the stored placement,
 * or null when nothing is committed (no Alt, never moved, or moved under 1 px).
 * Alt-drag: `offset` is the pointer's screen delta since the press (the window follows it
 * live) and `limit` is Infinity: the host clamps with `place_x`. Otherwise `offset` is the
 * island's sideways offset in its window and `limit` how far the window lets it go.
 */
export function commitDx(alt: boolean, moved: boolean, offset: number, limit: number): number | null {
  if (!alt || !moved) return null;
  const dx = Math.max(-limit, Math.min(limit, offset));
  return Math.abs(dx) < 1 ? null : dx;
}
