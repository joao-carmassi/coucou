// The Claude cards: the session's board card (the session at a glance), approval, question, error, finished.
// Ported from views/views.ts at m3-ok. Every card works on the module's store, never on State.

import { h, svg, clear, dot, replay } from "../../../kit/dom";
import { card, view } from "../../../kit/card";
import { tile } from "../../../kit/tile";
import type { ViewContext, ViewHost } from "../../../core/moduleApi";
import { App } from "../../../kit/app";
import { ClaudeBridge } from "../bridge";
import type { Pill } from "../../../core/state";
import { hasTarget, type Claude } from "../claude";
import { claudeSettings } from "../store";
import { askPill } from "../../../kit/ask";
import type { BoardCardOf, BoardNewsOf } from "../../board/api";
import { ICONS } from "../icons";
import { COLOR } from "../../../kit/palette";
import { CARD_AIR_MIN, fittedHeight } from "../fit";
import { CLAUDE_ID, TURN_DONE, turnSteps, type ClaudeSession, type SessionStep } from "../types";
import { paneCodeLead } from "../../../kit/panel";
import { diffBlock, diffHunk, diffLine, fileKind, plusMinus, readPatch } from "../../../kit/code";
import { markdown } from "./markdown";
import { sessionName, sessionsChip } from "./session";
import { hasPreview, stepIcon, stepName, stepPreview } from "./step";

/** Lines of a step's preview the overview has room for. */
const NOW_LINES = 3;
/**
 * A session's card holds a line more than the board's layout was cut for — the
 * step, then three lines of what it did: the island is this much taller for
 * it, so the card keeps the same air under its last line as above its first.
 */
const SESSION_CARD_ROOM = 12;

/** A reply's first line as plain words: what marks it as bold, a heading or code goes. */
function firstWords(text: string | null): string | null {
  return text?.split("\n").find((line) => line.trim())?.replace(/^#{1,6}\s+|\*\*|`/g, "").trim() ?? null;
}

/** A reply as plain words, for a few lines of it: what marks headings, bold, code and lists goes. */
function plainWords(text: string | null): string | null {
  const words = text
    ?.split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+|\*\*|`/g, "").trim())
    .filter((line) => line && !/^\|?[\s:|-]+\|?$/.test(line))
    .join(" ");
  return words || null;
}

/**
 * What a session is doing now, in the two lines the overview gives it: the
 * step by its icon and its name with what it is at, and a look at what it did
 * — or, the turn over, "Done" and the first lines of what Claude replied.
 */
interface Now {
  icon: Element;
  label: string;
  detail: string;
  /** The colour the label takes when it says more than a tool's name. */
  color: string | null;
  /** The step whose preview fills the box, or the words that do. */
  step: SessionStep | null;
  words: string | null;
}

function nowOf(session: ClaudeSession): Now {
  const steps = turnSteps(session);
  const last = steps.at(-1) ?? null;
  const shown = [...steps].reverse().find(hasPreview) ?? null;
  const oneLine = (text: string | null) => text?.split("\n")[0] ?? "";

  if (session.question || session.approval) {
    return {
      icon: svg(ICONS.bang, 12), label: "Aguardando", color: session.question ? COLOR.cyan : COLOR.amber,
      detail: session.question ? "sua resposta" : "sua permissão", step: shown, words: null,
    };
  }
  if (session.state === "error") {
    return { icon: svg(ICONS.xmark, 11), label: "Parou", color: COLOR.red, detail: "com um erro", step: shown, words: session.lines.at(-1) ?? null };
  }
  // The turn is over when the journal's last line is Claude's reply — a word
  // from Claude Code after it (a notification that it is waiting, a subagent
  // winding down) does not put the session back to work.
  const ended = [...session.steps].reverse().find((step) => step.kind !== "note")?.tool === TURN_DONE;
  if (ended || session.state === "done") {
    // What matters then is that Claude is done and has answered: its words
    // take the place of the last thing it ran. With no words, that stays.
    const said = plainWords(session.answer);
    return {
      icon: svg(ICONS.check, 12, { stroke: 3 }), label: "Pronto", color: COLOR.green,
      detail: said ? "Claude respondeu" : "", step: said ? null : shown, words: said,
    };
  }
  if (last) {
    return { icon: stepIcon(last), label: stepName(last), color: null, detail: oneLine(last.target), step: hasPreview(last) ? last : shown, words: null };
  }
  if (session.state === "thinking") {
    return { icon: svg(ICONS.bubble, 12), label: "Pensando", color: null, detail: "", step: null, words: session.asked };
  }
  return { icon: svg(ICONS.bubble, 12), label: "Aberta", color: null, detail: "esperando um pedido", step: null, words: null };
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

export function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** The two buttons of a card that tells a module's news instead of a session's result. */
function newsActions(c: Claude): HTMLElement {
  return h("div", { class: "actions" },
    btn("Abrir", "primary", () => void c.api.call("avatarClick")),
    // OK only folds the island: the news stays on the pill until it is opened or gets old.
    btn("OK", "secondary", () => c.api.island.close()),
  );
}

/**
 * What a pill's news (service `board.news`) puts on a result card: who and what kind of news, the news
 * itself, the facts that go with it. Returns false, and leaves the card to its session, when the
 * front pill has none; `hidden` are the parts of the session's version.
 */
function tellNews(
  c: Claude, task: Pill | null, who: HTMLElement, title: HTMLElement, facts: HTMLElement,
  hidden: HTMLElement[], newsRow: HTMLElement,
): boolean {
  const news = task ? askPill(c.api.useAll<BoardNewsOf>("board.news"), task.id) : undefined;
  for (const el of hidden) el.style.display = news ? "none" : "";
  newsRow.style.display = news ? "" : "none";
  facts.style.display = news ? "" : "none";
  if (!news) return false;
  who.replaceChildren(agentWho(task, news.says));
  title.textContent = news.title;
  facts.replaceChildren(...news.facts);
  return true;
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: Pill | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.label }));
  }
  row.append(h("span", { text: label }));
  return row;
}

/**
 * Whose card this is, for a card about a Claude Code session: the conversation
 * by its name — with several open, the project alone would not say which —
 * and, when other sessions are waiting for an answer behind it, how many.
 */
function sessionWho(c: Claude, label: string): HTMLElement {
  const task = c.api.pills.get(CLAUDE_ID) ?? c.api.pills.front();
  const session = c.store.session;
  const row = h("div", { class: "who-row" });
  if (task) row.append(dot(task.color, 8), h("span", { class: "n", text: session.id ? sessionName(session) : task.label }));
  row.append(h("span", { text: label }));
  const waiting = c.store.waiting.length;
  if (waiting > 0) row.append(h("span", { class: "who-waiting", text: `+${waiting} esperando`, title: "Outras sessões esperando uma resposta" }));
  return row;
}

export function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

/**
 * Keeps a card whose lines vary from filling up to its edges: measures what
 * its stack holds and asks the island for the height that leaves the least
 * air a card keeps. A card with room to spare is left as tall as it always was.
 */
function airy(lines: HTMLElement, onResize: () => void): { fit(): void; readonly height: number | undefined } {
  let height: number | undefined;
  const fit = () => {
    const parts = [...lines.children].map((child) => (child as HTMLElement).offsetHeight).filter((h) => h > 0);
    const gap = parseFloat(getComputedStyle(lines).rowGap) || 0;
    const content = parts.reduce((sum, part) => sum + part, 0) + gap * Math.max(0, parts.length - 1);
    // Not on screen yet: nothing to measure, the layout's own height stands.
    const next = parts.length > 0 ? fittedHeight(content, CARD_AIR_MIN) : undefined;
    if (next === height) return;
    height = next;
    onResize();
  };
  // Measured again when the card's width changes: while the island is still
  // opening it is narrow, its lines wrap, and it looks taller than it is.
  new ResizeObserver(fit).observe(lines);
  return {
    fit,
    get height() {
      return height;
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/** Third-party agents and the integrations other modules add: their pill's last words. */
function otherCard(c: Claude, task: Pill): HTMLElement {
  const steps = c.store.agentSteps.get(task.id);
  return tile({ title: task.label, sub: steps ? "Agente" : "Integração", dot: task.color, status: steps?.at(-1) ?? "" });
}

/**
 * The board's left card for the pills Claude owns (service `board.card`): the session at a glance for
 * Claude's pill, its idle card with no session, the last words of a third-party agent. The session
 * card keeps one DOM across redraws; `sync` updates it. Everything else is drawn by the pill's owner.
 */
function boardCardOf(c: Claude): BoardCardOf {
  const store = c.store;
  const who = h("div", { class: "who" });
  // What the session is doing: the step, and under it a look at what it did.
  const nowLine = h("div", { class: "now-line" });
  const nowBox = h("div", { class: "now-box" });
  // With several sessions followed: how many, and the way to the list of them.
  let blip = () => {};
  const sessionsBtn = sessionsChip(c.api, store, () => {
    blip();
    c.openSessions();
  });
  const sessionBody = h("div", { class: "card-body sess-card" }, who, nowLine, nowBox);
  let lineKey = "";
  let boxKey = "";

  /** The session's two lines, redrawn only when what they show has changed. */
  function syncNow(session: ClaudeSession) {
    const now = nowOf(session);
    const step = now.step;
    // The line and the box each come in when what they show changes — and
    // only then: a step that goes from one file to the next moves the line,
    // not the box still showing the last result.
    const nextLine = [session.id, now.label, now.detail].join("~");
    if (nextLine !== lineKey) {
      lineKey = nextLine;
      clear(nowLine);
      const label = h("b", { text: now.label });
      const icon = h("i", {}, now.icon);
      if (now.color) {
        label.style.color = now.color;
        icon.style.color = now.color;
      }
      nowLine.append(icon, label, h("span", { class: now.color ? "said" : "at", text: now.detail, title: now.detail }));
      replay(nowLine, "now-in");
    }
    const nextBox = [
      session.id, step?.tool, step?.target, step?.at, step?.state,
      step?.result?.text.length, step?.patch?.length, step ? "" : now.words,
    ].join("~");
    if (nextBox === boxKey) return;
    boxKey = nextBox;
    clear(nowBox);
    const preview = step ? stepPreview(step, NOW_LINES) : null;
    if (preview) nowBox.append(preview);
    else if (now.words) nowBox.append(h("div", { class: "now-words", text: now.words.trim() }));
    nowBox.style.display = nowBox.firstChild ? "" : "none";
    if (nowBox.firstElementChild) replay(nowBox.firstElementChild as HTMLElement, "now-in");
  }

  function syncSession(task: Pill, session: ClaudeSession) {
    clear(who);
    who.append(
      dot(task.color, 7),
      // A conversation that has a title goes by it, as it does in Claude
      // Code, with its project after; untitled, the project is its name.
      h("span", { class: "name", text: session.title ?? task.label, title: session.title ?? "" }),
      h("span", { class: "tool", text: session.title ? task.label : "Claude Code" }),
    );
    sessionsBtn.sync();
    who.append(sessionsBtn.el);
    // What the session has written so far: the lines added and removed —
    // when the chip is not there: the title keeps the room, and the panel has them.
    const files = store.sessions.length > 1 ? [] : store.sessionFiles;
    if (files.length > 0) {
      const size = plusMinus(files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0));
      size.classList.add("count");
      size.title = files.length === 1 ? "1 arquivo alterado" : `${files.length} arquivos alterados`;
      who.append(size);
    }
    syncNow(session);
  }

  return (taskId) => {
    const task = c.api.pills.get(taskId);
    if (!task) return null;
    // The Claude pill with a session to show has the session's card.
    if (taskId === CLAUDE_ID && store.session.id) {
      return {
        key: "session",
        build: (actions) => ((blip = () => actions.blip()), sessionBody),
        sync: () => syncSession(task, store.session),
        open: () => c.openSession(),
        hint: "Ver a sessão",
        room: SESSION_CARD_ROOM,
        target: true,
      };
    }
    const steps = store.agentSteps.get(taskId);
    if (taskId !== CLAUDE_ID && !steps) return null;
    const key = [
      task.id, task.mood, steps?.join("|"),
      // The idle Claude card's button follows Settings ("Idle button opens").
      store.clientName, claudeSettings(c.api).hooksInstalled, claudeSettings(c.api).idleOpen, store.session.client,
    ].join("~");
    return { key, build: () => (taskId === CLAUDE_ID ? idleCard(c, task) : otherCard(c, task)), target: taskId === CLAUDE_ID };
  };
}

/** The Claude card with no session to show: whether the hooks are in, and a way to open Claude. */
function idleCard(c: Claude, task: Pill): HTMLElement {
  const store = c.store;
  const configured = claudeSettings(c.api).hooksInstalled;
  const label = configured ? "Conectado · carregando…" : "Hooks não instalados";
  const statusColor = configured ? "#22C55E" : "#F4505E";
  const desktop = store.session.client === "desktop";
  const terminal = !desktop && claudeSettings(c.api).idleOpen === "terminal";
  const actions = [
    h("button", {
      class: "link-btn",
      style: `color:${task.color}b3`,
      // The app the last session ran in; otherwise what Settings picked
      // (Visual Studio Code, or Claude Code in a new terminal).
      text: desktop ? "Abrir Claude" : terminal ? "Abrir terminal" : "Abrir Visual Studio Code",
      onclick: () =>
        void (desktop
          ? ClaudeBridge.openClaudeApp()
          : terminal
            // No Claude Code to start: the click still opens something.
            ? ClaudeBridge.startClaudeTerminal().then((ok) => ok || ClaudeBridge.openInVSCode(store.session.cwd, store.session.wslDistro))
            : ClaudeBridge.openInVSCode(store.session.cwd, store.session.wslDistro)),
    }),
  ];
  if (!configured) {
    actions.push(h("button", { class: "link-btn", style: "color:#8e939c", text: "Configurações…", onclick: () => void App.openSettingsWindow() }));
  }
  return tile({ title: store.clientName, sub: "Integração", dot: task.color, status: [dot(statusColor, 5), h("span", { text: label })], actions });
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(c: Claude, ctx: ViewContext): ViewHost {
  const { onResize } = ctx;
  const who = h("div");
  const code = h("div", { class: "code" });
  // For an edit: the diff it would make, between what is asked and the answer.
  const proposed = paneCodeLead("proposed");
  const row = h("div", { class: "actions" });
  const lines = stack(116, 16, who, code, proposed, row);
  const el = view(card("amber", lines));
  const air = airy(lines, onResize);
  let rowKey = "";
  let proposedKey = "";
  return {
    el,
    // With a diff the island is as tall as the window allows, and the diff takes what is left.
    get height() {
      const approval = c.store.pendingApproval;
      return approval?.proposal || approval?.plan ? undefined : air.height;
    },
    sync() {
      const approval = c.store.pendingApproval;
      const proposal = approval?.proposal ?? null;
      const plan = approval?.plan ?? null;
      clear(who);
      const asking = sessionWho(c, "precisa de permissão");
      if (proposal) asking.append(plusMinus(proposal.additions, proposal.deletions));
      who.append(asking);
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = plan != null
        ? "Plano pronto para revisão"
        : proposal
          ? `${approval?.tool} · ${proposal.path}${proposal.created ? " · novo arquivo" : ""}`
          : approval?.command || approval?.tool || "…";
      // What that edit would do, line by line, before it is allowed. Drawn once
      // per request: a list redrawn under the mouse would lose its scroll.
      proposed.style.display = proposal || plan ? "" : "none";
      // A diff takes all the room it is given: the card keeps the air a
      // card has above its first line and under its buttons.
      lines.classList.toggle("airy", proposal != null || !!plan);
      const nextProposed = proposal || plan ? (approval?.requestId ?? "") : "";
      if (nextProposed !== proposedKey) {
        proposedKey = nextProposed;
        clear(proposed);
        // A plan waiting to be approved: read here, as it reads in Claude Code.
        if (plan) {
          proposed.append(markdown(plan));
          proposed.scrollTop = 0;
        } else if (proposal) {
          const kind = fileKind(proposal.path);
          const diff = diffBlock();
          for (const line of readPatch(proposal.patch)) {
            if (!("hunk" in line)) diff.append(diffLine(line.new ?? line.old, line.sign, line.text, kind));
          }
          if (proposal.truncated) {
            diff.append(diffHunk("O resto desta edição está no Claude Code"));
          }
          proposed.append(diff);
          // Open on the first line that changes, a line of context above it.
          const first = diff.querySelector<HTMLElement>(".add, .del");
          proposed.scrollTop = first ? Math.max(0, first.offsetTop - diff.offsetTop - first.offsetHeight) : 0;
        }
      }
      // The buttons, built once per kind of request. Rebuilding them between a
      // mouse-down and a mouse-up would swallow the click. "Always" is gone
      // until the remembered-rules list exists to back it.
      const kind = plan != null ? "plan" : "tool";
      if (rowKey !== kind) {
        rowKey = kind;
        clear(row);
        if (kind === "plan") {
          // What Claude Code offers at the end of plan mode, minus the typed feedback.
          row.append(
            btn("Aguardar", "secondary", () => c.deferAlert()),
            btn("Continuar planejando", "secondary", () => c.decide("plan-keep"), "N"),
            btn("Manual", "secondary", () => c.decide("plan-manual")),
            btn("Modo auto", "primary", () => c.decide("plan-auto"), "Y"),
          );
        } else {
          row.append(
            btn("Aguardar", "secondary", () => c.deferAlert()),
            btn("Negar", "secondary", () => c.decide("deny"), "N"),
            btn("Aprovar", "primary", () => c.decide("allow"), "Y"),
          );
        }
      }
      air.fit();
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

/** Several options picked for one question go back as one answer, as Claude Code writes them. */
const ANSWER_JOIN = ", ";
/** A click in the field asks the window for the keyboard; this long later it has it. */
const FOCUS_MS = 120;

/**
 * A question Claude asks with its question tool, answered here: one question
 * at a time, each option with what it means beside it.
 * "Other…" takes a typed answer. The last answer sends them all — and the
 * session, wherever it runs, goes on as if they had been picked there.
 */
function buildQuestion(c: Claude, ctx: ViewContext): ViewHost {
  const { actions, onResize } = ctx;
  const who = h("div");
  const title = h("div", { class: "title q-title" });
  const row = h("div", { class: "actions q-options" });
  const hint = h("span", { class: "q-hint" });
  const back = h("button", { class: "link-btn text-link", text: "‹ Anterior" });
  const pass = h("button", { class: "link-btn text-link", onclick: () => c.passQuestion() });
  const skip = h("button", { class: "btn secondary q-skip", text: "Aguardar", title: "Fechar a ilha e responder depois", onclick: () => c.deferAlert() });
  // Under a list of options: "Other…", and Send when several can be picked.
  const tail = h("div", { class: "q-tail" });
  const foot = h("div", { class: "q-foot" }, tail, hint, h("div", { class: "grow" }), back, pass, skip);
  const field = h("input", {
    class: "island-field", type: "text", maxlength: "2000", autocomplete: "off", spellcheck: "false",
    placeholder: "Sua resposta",
  }) as HTMLInputElement;
  const lines = stack(116, 16, who, title, row, foot);
  // A question with more options than the window is tall for fills its card:
  // the list of options scrolls, and the card keeps its least air around it.
  lines.style.paddingTop = lines.style.paddingBottom = `${CARD_AIR_MIN}px`;
  // The ↗ of the overview: the way to the session, to read the conversation there.
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Abrir a conversa", onclick: () => c.openClient() },
    svg(ICONS.arrowUpRight, 8),
  );
  // The who line runs under the ↗: it keeps clear of it.
  who.style.paddingRight = "14px";
  const el = view(card("cyan", lines, jump));

  /** The request all of this is about: a new one starts from the first question. */
  let request = "";
  let at = 0;
  /** One answer per question answered so far. */
  let answers: string[] = [];
  /** A question that takes several: the labels picked so far. */
  let picked = new Set<string>();
  let typing = false;
  let key = "";
  /** The island's height for what the card holds now; unset until it has been measured. */
  let height: number | undefined;

  /** Asks the island for the room the card's content takes, no more. */
  function fit() {
    // The card's lines, and the gap the stack leaves between each two of them.
    const parts = [who.offsetHeight, title.offsetHeight, row.scrollHeight, foot.offsetHeight];
    const gap = parseFloat(getComputedStyle(lines).rowGap) || 0;
    const content = parts.reduce((sum, part) => sum + part, 0) + gap * (parts.length - 1);
    // Not on screen yet: nothing to measure, the layout's own height stands.
    const next = who.offsetHeight > 0 ? fittedHeight(content) : undefined;
    if (next === height) return;
    height = next;
    onResize();
  }

  // Measured again whenever the card's width changes: while the island is still
  // opening it is narrow, the lines wrap, and the content looks taller than it is.
  new ResizeObserver(() => fit()).observe(el);

  function settle(value: string) {
    const info = c.store.pendingQuestion;
    if (!info || !value) return;
    answers[at] = value;
    stopTyping();
    picked = new Set();
    if (at + 1 < info.questions.length) {
      at++;
      actions.blip();
      c.store.changed();
      return;
    }
    const out: Record<string, string> = {};
    info.questions.forEach((q, i) => (out[q.question] = answers[i] ?? ""));
    c.answer(out);
  }

  function stopTyping() {
    typing = false;
    field.value = "";
    field.blur();
  }

  field.addEventListener("blur", () => void App.focusWindow(false));
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") settle(field.value.trim());
    else if (e.key === "Escape") {
      stopTyping();
      c.store.changed();
    }
  });
  back.addEventListener("click", () => {
    if (at === 0) return;
    at--;
    stopTyping();
    picked = new Set();
    actions.blip();
    c.store.changed();
  });

  function draw() {
    const info = c.store.pendingQuestion;
    if ((info?.requestId ?? "") !== request) {
      request = info?.requestId ?? "";
      at = 0;
      answers = [];
      picked = new Set();
      typing = false;
      key = "";
    }
    // Rebuilding the buttons between a mouse-down and its mouse-up would
    // swallow the click, so only rebuild when what they show has changed.
    const next = [request, at, typing, [...picked].join("|"), c.store.clientName, c.store.waiting.length].join("~");
    if (next === key) return;
    key = next;

    const q = info?.questions[at];
    clear(who);
    clear(row);
    clear(tail);
    pass.textContent = `Responder no ${c.store.clientName}`;
    back.style.display = at > 0 ? "" : "none";
    if (!info || !q) {
      who.append(sessionWho(c, "está perguntando"));
      title.textContent = c.store.session.lines.at(-1) ?? "Claude precisa de uma resposta.";
      hint.textContent = "";
      pass.style.display = "none";
      skip.style.display = "none";
      return;
    }
    pass.style.display = "";
    skip.style.display = "";

    const asking = sessionWho(c, "está perguntando");
    if (q.header) asking.append(h("span", { class: "q-chip", text: q.header }));
    if (info.questions.length > 1) asking.append(h("span", { class: "q-count", text: `${at + 1}/${info.questions.length}` }));
    who.append(asking);
    title.textContent = q.question;
    title.title = q.question;

    const rest = q.multiSelect ? "Escolha uma ou mais, depois envie." : "";
    hint.textContent = rest;

    if (typing) {
      row.classList.remove("q-list");
      row.append(
        field,
        btn(at + 1 < info.questions.length ? "Próxima" : "Enviar", "primary", () => settle(field.value.trim())),
        btn("Voltar", "secondary", () => {
          stopTyping();
          c.store.changed();
        }),
      );
      return;
    }

    // Options that explain themselves are read before they are picked: each
    // on a line of its own, what it means beside its name. Bare labels stay
    // the row of buttons of the prototype.
    const explained = q.options.some((o) => o.description);
    row.classList.toggle("q-list", explained);
    for (const option of q.options) {
      const on = picked.has(option.label);
      const el = explained
        ? h(
            "button",
            { class: on ? "q-row on" : "q-row" },
            h("b", { text: option.label }),
            h("span", { text: option.description ?? "", title: option.description ?? "" }),
          )
        : h("button", { class: on ? "btn secondary q-opt on" : "btn secondary q-opt" }, h("span", { text: option.label }));
      el.addEventListener("click", () => {
        if (!q.multiSelect) return settle(option.label);
        if (!picked.delete(option.label)) picked.add(option.label);
        c.store.changed();
      });
      row.append(el);
    }
    // After the options: in the row of buttons, or under the list, at its foot.
    const after = explained ? tail : row;
    after.append(
      h("button", {
        class: "btn secondary q-opt other",
        text: "Outra…",
        onclick: () => {
          typing = true;
          c.store.changed();
          void App.focusWindow(true);
          c.api.timeout(() => field.focus(), FOCUS_MS);
        },
      }),
    );
    if (q.multiSelect) {
      after.append(
        btn(at + 1 < info.questions.length ? "Próxima" : "Enviar", "primary", () =>
          // In the order the options are listed, not the order they were clicked.
          settle(q.options.filter((o) => picked.has(o.label)).map((o) => o.label).join(ANSWER_JOIN)),
        ),
      );
    }
  }

  return {
    el,
    get height() {
      return height;
    },
    sync() {
      draw();
      fit();
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(c: Claude, ctx: ViewContext): ViewHost {
  const { onResize } = ctx;
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow parou." });
  const detail = h("div", { class: "detail" });
  // Where what stopped runs: the Claude app, a terminal — the pill's own way out.
  const openLabel = h("span");
  const openBtn = h("button", { class: "btn primary", onclick: () => c.openClient() }, openLabel);
  // Nothing here can run it again: OK folds the island, as on the finished card.
  const row = h("div", { class: "actions" }, openBtn, btn("OK", "secondary", () => c.api.island.close()));
  const facts = h("div", { class: "nfs news-facts" });
  const newsRow = newsActions(c);
  const lines = stack(116, 16, who, title, detail, facts, row, newsRow);
  const el = view(card("red", lines));
  const air = airy(lines, onResize);
  return {
    el,
    get height() {
      return air.height;
    },
    sync() {
      const task = c.api.pills.front();
      const claude = task?.id === CLAUDE_ID;
      // A module's pill with news to tell (integrations) puts it here in place of a session's result.
      if (tellNews(c, task, who, title, facts, [row, detail], newsRow)) {
        air.fit();
        return;
      }
      // A Claude Code session is named by its conversation; a third-party agent's pill by its own name.
      who.replaceChildren(claude ? sessionWho(c, "Claude Code") : agentWho(task, "parou"));
      title.textContent = "Sessão parou com um erro.";
      detail.textContent = (claude ? c.store.session.lines.at(-1) : task && c.store.agentSteps.get(task.id)?.at(-1)) ?? "Sem detalhes.";
      openBtn.style.display = hasTarget(task?.id) ? "" : "none";
      openLabel.textContent = !claude ? "Abrir" : c.store.session.client === "desktop" ? "Abrir Claude" : "Abrir terminal";
      air.fit();
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(c: Claude, ctx: ViewContext): ViewHost {
  const { onResize } = ctx;
  const who = h("div");
  const title = h("div", { class: "title" });
  // Built once, like every button of a card: only its words follow the session.
  const openLabel = h("span");
  const openBtn = h("button", { class: "btn primary", onclick: () => c.openClient() }, openLabel);
  const changesLabel = h("span");
  const changesBtn = h("button", { class: "btn secondary", onclick: () => c.openSession(true) }, changesLabel);
  // What Claude said, in full: the card only has room for its first words.
  const readBtn = h("button", { class: "btn primary", onclick: () => c.openSession() }, h("span", { text: "Ler resposta" }));
  const row = h("div", { class: "actions" },
    readBtn,
    openBtn,
    changesBtn,
    btn("OK", "secondary", () => c.api.island.close()),
  );
  const facts = h("div", { class: "nfs news-facts" });
  const newsRow = newsActions(c);
  const lines = stack(116, 16, who, title, facts, row, newsRow);
  const el = view(card("green", lines));
  const air = airy(lines, onResize);
  return {
    el,
    get height() {
      return air.height;
    },
    sync() {
      const task = c.api.pills.front();
      if (tellNews(c, task, who, title, facts, [row], newsRow)) {
        title.classList.remove("said");
        air.fit();
        return;
      }
      // A third-party agent's pill has no session behind it: its name, its last step, and OK.
      const claude = task?.id === CLAUDE_ID;
      who.replaceChildren(claude ? sessionWho(c, "terminou") : agentWho(task, "terminou"));
      // What Claude said to end its turn, its first line; its last step otherwise.
      const answer = claude ? firstWords(c.store.session.answer) : null;
      title.textContent = answer ?? (claude ? c.store.session.lines.at(-1) : task && c.store.agentSteps.get(task.id)?.at(-1)) ?? "Sessão concluída";
      // An answer is a sentence, not a step: smaller, and two lines at most.
      title.classList.toggle("said", answer != null);
      readBtn.style.display = answer ? "" : "none";
      openBtn.className = answer ? "btn secondary" : "btn primary";
      // Where the session runs, and what it left behind: the way to its diffs.
      const files = claude ? c.store.sessionFiles.length : 0;
      openBtn.style.display = claude ? "" : "none";
      openLabel.textContent = c.store.session.client === "desktop" ? "Abrir Claude" : "Abrir terminal";
      changesBtn.style.display = files > 0 ? "" : "none";
      changesLabel.textContent = files === 1 ? "1 arquivo alterado" : `${files} arquivos alterados`;
      air.fit();
    },
  };
}

/** The views of the card family, laid out as in docs/SPEC.md. */
export const CARDS = { boardCardOf, buildApproval, buildQuestion, buildError, buildFinished };
