// Drop zone, upload progress and the "what do you want to do with it" card —
// ports of UploadView / UploadingView / ChooseView from IslandViewContent.swift.
//
// `choose` offers the one action the spec asks for: open the file in Claude Code.

import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { Up } from "./state";
import { CLAUDE_SERVICE, type LaunchFile } from "../claude/api";
import type { IslandApi, ViewContext, ViewHost } from "../../core/moduleApi";

/** Dashed rounded rect drawn as SVG so the dashes can march like on macOS. */
function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "20");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

/** Hands the dropped file to a new Claude Code session (ingested already unless the copy is still running). */
export function ask(api: IslandApi) {
  if (!Up.droppedFile) return;
  // Wait for the background copy (if any), then launch the copy; ingest only if it never landed.
  void (Up.ingest ?? Promise.resolve())
    .catch(() => {})
    .then(() => api.use<LaunchFile>(CLAUDE_SERVICE.launchFile)?.(Up.droppedFile!.path, !Up.ingested));
}

export function buildUpload(): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title", text: "Solte seus arquivos aqui" });
  const tags = h(
    "div",
    { class: "drop-tags" },
    ...["PDF", "Imagens", "Código", "Docs"].map((t) => h("span", { text: t })),
  );
  const dropCard = card(
    { cls: "drop-card" },
    frame,
    h("div", { class: "drop-body" }, title, tags),
  );
  const el = view(dropCard);

  return {
    el,
    sync() {
      dropCard.classList.toggle("over", Up.dragOver);
    },
  };
}

export function buildUploading(): ViewHost {
  const label = h("span", { class: "up-name" });
  const percent = h("span", { class: "up-pct" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  const upCard = card(
    { cls: "up-card" },
    h("div", { class: "up-row" }, label, percent),
    h("div", { class: "up-track" }, fill, glow),
  );
  const el = view(upCard);

  return {
    el,
    sync() {
      const done = Up.progress >= 0.999;
      const pct = Math.round(Up.progress * 100);
      label.textContent = done
        ? `✓  ${Up.droppedFile?.name ?? "Arquivo"}`
        : `Enviando ${Up.droppedFile?.name ?? "arquivo"}`;
      label.classList.toggle("done", done);
      percent.textContent = done ? "" : `${pct} %`;
      const w = Up.progress * 526;
      fill.style.width = `${w}px`;
      glow.style.transform = `translateX(${Math.max(0, w - 14)}px)`;
      glow.style.opacity = Up.progress > 0.01 ? "1" : "0";
      upCard.classList.toggle("done", done);
    },
  };
}

export function buildChoose(ctx: ViewContext, cancel: () => void): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub", text: "O que você quer fazer com ele?" });
  const row = h(
    "div",
    { class: "actions" },
    h("button", {
      class: "btn primary",
      text: "Abrir no Claude Code",
      onclick: () => ask(ctx.api),
    }),
    h("button", {
      class: "btn secondary",
      text: "Cancelar",
      onclick: cancel,
    }),
  );
  const el = view(
    card(
      null,
      h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title, sub, row),
    ),
  );

  return {
    el,
    sync() {
      clear(title);
      title.append(
        h("b", { text: Up.droppedFile?.name ?? "arquivo" }),
        document.createTextNode(" está pronto."),
      );
    },
  };
}
