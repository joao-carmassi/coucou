// Per-id services (one provider per module, each answering only for what it owns): ask them all.

/** The first non-null answer of the providers of a per-id service (a throwing provider is skipped). */
export function askPill<T>(providers: ((id: string) => T | null)[], id: string): T | undefined {
  for (const p of providers) {
    try { const r = p(id); if (r) return r; } catch (err) { console.error("[coucou] pill service failed", err); }
  }
  return undefined;
}
