// The Calendário section of the settings window: ICS links (masked; the Credential Manager keeps them), reminder, days.
// Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { clear, h } from "../../kit/dom";
import { CalendarBridge, type Feed } from "./bridge";

type Cfg = { calendarRemindMin: number; calendarDaysAhead: number };

function calendarSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  const list = h("div", { class: "stack" });
  const note = h("div", { class: "hint" });
  const field = h("input", { type: "password", placeholder: "https://… (link secreto do iCal)", autocomplete: "off", spellcheck: "false", style: "flex:1 1 auto;min-width:0" }) as HTMLInputElement;
  const say = (t: string, bad = false) => { note.textContent = t; note.style.color = bad ? "var(--red)" : ""; };
  const err = (e: unknown) => say(typeof e === "string" ? e : "Algo deu errado.", true);

  const draw = (feeds: Feed[]) => {
    clear(list);
    if (!feeds.length) list.append(h("div", { class: "hint", text: "Nenhum calendário adicionado." }));
    for (const f of feeds) {
      list.append(h("div", { class: "row" }, h("label", { text: `${f.host}/••••••` }),
        h("button", { class: "danger", text: "Remover", onclick: () => void CalendarBridge.remove(f.slot).then(load, err) })));
    }
  };
  const load = () => CalendarBridge.list().then(draw, err);

  const add = () => {
    const v = field.value;
    if (!v.trim()) return;
    CalendarBridge.add(v).then(() => { field.value = ""; say("Calendário adicionado."); return load(); }, err);
  };
  field.addEventListener("keydown", (e) => e.key === "Enter" && add());

  const num = (label: string, key: keyof Cfg, lo: number, hi: number, hint: string) => {
    const i = h("input", { type: "number", min: lo, max: hi, value: cfg[key], title: hint }) as HTMLInputElement;
    i.addEventListener("change", () => {
      const n = Math.floor(Number(i.value));
      if (n >= lo && n <= hi) void ms.save({ [key]: n }); else i.value = String(cfg[key]);
    });
    return h("div", { class: "row" }, h("label", { text: label }), i);
  };

  void load();
  return {
    el: h("section", { id: "calendar" },
      h("h2", {}, h("span", { text: "Calendário" })),
      h("div", { class: "hint", text: "Cole o link secreto do seu calendário (Google: Configurações do calendário > Endereço secreto em formato iCal; Outlook: Publicar calendário > ICS). O link fica no Gerenciador de Credenciais do Windows, nunca em arquivo." }),
      list,
      h("div", { class: "row" }, field, h("button", { class: "primary", text: "Adicionar", onclick: add })),
      note,
      num("Avisar antes do evento (min, 0 = não avisar)", "calendarRemindMin", 0, 120, "0 a 120"),
      num("Mostrar os próximos (dias)", "calendarDaysAhead", 1, 30, "1 a 30")),
  };
}

export const settingsSections = { calendar: calendarSettingsSection };
