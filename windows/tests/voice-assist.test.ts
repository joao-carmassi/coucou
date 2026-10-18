import test from "node:test";
import assert from "node:assert/strict";
import { match, spoken } from "../src/modules/voice/logic.ts";

const A = (key: string, title: string, keywords?: string[]) => ({ key, title, owner: key.split(".")[0], keywords });
const ACTIONS = [
  A("nowplaying.next", "Próxima faixa", ["pular", "avançar"]),
  A("nowplaying.prev", "Faixa anterior", ["voltar"]),
  A("timer.start", "Iniciar timer", ["cronômetro"]),
];

test("spoken: accents, case, filler and glue words are dropped", () => {
  assert.deepEqual(spoken("Ok Coucou, pula para a PRÓXIMA faixa, por favor!"), ["pula", "proxima", "faixa"]);
});

test("match: title with accents and filler", () => {
  assert.equal(match("ok coucou próxima faixa por favor", ACTIONS)?.key, "nowplaying.next");
  assert.equal(match("PROXIMA FAIXA", ACTIONS)?.key, "nowplaying.next");
});

test("match: keywords carry synonyms", () => {
  assert.equal(match("pular faixa", ACTIONS)?.key, "nowplaying.next");
  assert.equal(match("voltar faixa", ACTIONS)?.key, "nowplaying.prev");
  assert.equal(match("cronômetro", ACTIONS)?.key, "timer.start");
});

test("match: below the threshold is null", () => {
  assert.equal(match("abrir o navegador", ACTIONS), null);
  assert.equal(match("próxima música do disco", ACTIONS), null);
  assert.equal(match("", ACTIONS), null);
  assert.equal(match("próxima faixa", []), null);
});

test("match: a tie is null (no guess between two actions)", () => {
  assert.equal(match("faixa", ACTIONS), null);
  assert.equal(match("timer", [A("a.one", "Timer um"), A("b.two", "Timer dois")]), null);
});
