// What the Upload module offers other modules (services, via api.provide / api.use). Types and a pure matcher only.
// A module provides one `upload.dropAction` per action; upload shows the ones that fit as chips on the dropped-file card.

export interface DropAction {
  id: string;
  label: string;
  /** Lowercase extensions without the dot; ["*"] accepts any file. */
  accepts: readonly string[];
  /** Extra check on the dropped paths (e.g. hide "to PNG" for a PNG). */
  test?(paths: readonly string[]): boolean;
  run(paths: readonly string[]): void | Promise<void>;
  order?: number;
}

export const UPLOAD_SERVICE = { dropAction: "upload.dropAction" } as const;

export function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf("."); // the name only: a dotted folder does not count
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** The actions that accept every dropped path, in `order` then label order. */
export function matchDropActions(all: readonly DropAction[], paths: readonly string[]): DropAction[] {
  if (!paths.length) return [];
  return all
    .filter((a) => paths.every((p) => a.accepts.includes("*") || a.accepts.includes(extOf(p))) && (a.test?.(paths) ?? true))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
}
