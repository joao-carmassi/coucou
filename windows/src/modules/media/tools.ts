// Media tools, pure part: which tools a file extension gets, as upload.dropAction entries.
// The running (bridge calls, notices) is in toolsRun.ts.

import { extOf, type DropAction } from "../upload/api";

export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"] as const;
export const VIDEO_EXT = ["mp4", "mkv", "mov", "webm", "avi"] as const;

export interface ToolSpec { id: string; label: string; op: string; arg?: string; accepts: readonly string[]; order: number; hideFor?: string; group?: "convert" }

export const TOOLS: readonly ToolSpec[] = [
  { id: "to-png", label: "Para PNG", op: "convert", arg: "png", accepts: IMAGE_EXT, order: 10, hideFor: "png", group: "convert" },
  { id: "to-jpg", label: "Para JPG", op: "convert", arg: "jpg", accepts: IMAGE_EXT, order: 11, hideFor: "jpg", group: "convert" },
  { id: "to-webp", label: "Para WebP", op: "convert", arg: "webp", accepts: IMAGE_EXT, order: 12, hideFor: "webp", group: "convert" },
  { id: "resize-50", label: "Reduzir 50%", op: "resize", arg: "50", accepts: IMAGE_EXT, order: 20, group: "convert" },
  { id: "resize-25", label: "Reduzir 25%", op: "resize", arg: "25", accepts: IMAGE_EXT, order: 21, group: "convert" },
  { id: "compress", label: "Comprimir", op: "compress", accepts: ["png", "jpg", "jpeg", "webp"], order: 30, group: "convert" },
  { id: "strip", label: "Sem metadados", op: "strip", accepts: ["png", "jpg", "jpeg", "webp"], order: 31, group: "convert" },
  { id: "clipboard", label: "Copiar imagem", op: "clipboard", accepts: IMAGE_EXT, order: 40 },
  { id: "ocr", label: "Extrair texto (OCR)", op: "ocr", accepts: IMAGE_EXT, order: 41 },
  { id: "gif", label: "Criar GIF", op: "gif", accepts: VIDEO_EXT, order: 10, group: "convert" },
  { id: "vcompress", label: "Comprimir vídeo", op: "vcompress", accepts: VIDEO_EXT, order: 11, group: "convert" },
  { id: "audio", label: "Extrair áudio", op: "audio", accepts: VIDEO_EXT, order: 12, group: "convert" },
  { id: "pdf-info", label: "Info do PDF", op: "info", accepts: ["pdf"], order: 10 },
];

/** "jpeg" counts as "jpg" when deciding whether a convert is a no-op. */
const norm = (e: string) => (e === "jpeg" ? "jpg" : e);

/** The tools that fit a file (what a menu or the drop card lists). */
export function toolsFor(path: string): ToolSpec[] {
  const e = extOf(path);
  return TOOLS.filter((t) => t.accepts.includes(e) && !(t.hideFor && t.hideFor === norm(e)));
}

/** The tools as drop actions; `run` is injected so this stays free of the bridge. */
export function dropActions(run: (t: ToolSpec, path: string) => void | Promise<void>): DropAction[] {
  return TOOLS.map((t) => ({
    id: `media.${t.id}`,
    label: t.label,
    accepts: t.accepts,
    order: t.order,
    test: (paths) => paths.length === 1 && !(t.hideFor && t.hideFor === norm(extOf(paths[0]))),
    run: (paths) => run(t, paths[0]),
  }));
}

/** Result line for the island notice. */
export function doneText(op: string, name: string, text?: string | null): string {
  if (op === "clipboard") return "Imagem copiada";
  if (op === "ocr") return `Texto salvo em ${name} (${(text ?? "").trim().length} caracteres)`;
  return `Pronto: ${name}`;
}
