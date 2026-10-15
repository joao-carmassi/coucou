import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionList, fold } from "../src/core/actions.ts";

const mk = (id: string, title: string, extra: object = {}) => ({ id, title, run() {}, ...extra });
const titles = (l: ActionList, q: string) => l.search(q).map((e) => e.title);

test("stamps owner.id and the disposer removes", () => {
  const l = new ActionList();
  const off = l.add("m", mk("a", "Alpha"));
  assert.deepEqual(l.all().map((a) => a.key), ["m.a"]);
  off();
  assert.equal(l.all().length, 0);
});

test("duplicate key warns and the first keeps it", () => {
  const l = new ActionList();
  const warns: string[] = [];
  l.onWarn = (m) => warns.push(m);
  l.add("m", mk("a", "A", { key: "f" }));
  l.add("n", mk("b", "B", { key: "f" }));
  assert.equal(warns.length, 1);
  assert.equal(l.byKey("f")?.key, "m.a");
  l.add("n", mk("c", "C", { key: "ab" }));
  assert.equal(warns.length, 2);
});

test("when() hides from all, search and byKey", () => {
  const l = new ActionList();
  let on = false;
  l.add("m", mk("a", "Alpha", { key: "a", when: () => on }));
  assert.equal(l.all().length, 0);
  assert.equal(l.byKey("a"), null);
  on = true;
  assert.equal(l.byKey("a")?.key, "m.a");
  assert.equal(l.run("m.a", () => {}), true);
});

test("search: prefix > word start > substring, accents folded", () => {
  const l = new ActionList();
  l.add("m", mk("1", "Abrir configuração"));
  l.add("m", mk("2", "Iniciar foco"));
  l.add("m", mk("3", "Ir ao foco"));
  l.add("m", mk("4", "Desfocar"));
  assert.deepEqual(titles(l, "foc"), ["Iniciar foco", "Ir ao foco", "Desfocar"]);
  assert.deepEqual(titles(l, "ir"), ["Ir ao foco", "Abrir configuração"]);
  assert.deepEqual(titles(l, "CONFIGURACAO"), ["Abrir configuração"]);
  assert.equal(fold("Ção"), "cao");
  assert.deepEqual(titles(l, "zzz"), []);
});

test("keywords match after titles; extra entries are searched too", () => {
  const l = new ActionList();
  l.add("m", mk("1", "Zeta", { keywords: ["pomodoro"] }));
  const out = l.search("po", [{ key: "#t", title: "Ir para Portas", run() {} }]);
  assert.deepEqual(out.map((e) => e.title), ["Ir para Portas", "Zeta"]);
  assert.equal(l.search("").length, 1);
});

test("run: a throw or a rejection reaches onError", async () => {
  const l = new ActionList();
  const errs: unknown[] = [];
  l.add("m", mk("t", "T", { run() { throw new Error("boom"); } }));
  l.add("m", mk("r", "R", { run: () => Promise.reject(new Error("no")) }));
  l.run("m.t", (e) => errs.push(e));
  l.run("m.r", (e) => errs.push(e));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(errs.length, 2);
  assert.equal(l.run("m.zzz", () => {}), false);
});
