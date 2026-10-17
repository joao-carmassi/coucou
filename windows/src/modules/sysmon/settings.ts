// The Sistema section of the settings window. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { SysmonBridge, type LhmInfo } from "./bridge";
import { bytes, clampInt, showOf, type Show } from "./logic";

type Cfg = { sysmonShow: unknown; sysmonAlerts: boolean; sysmonCpuMax: number; sysmonRamMax: number; sysmonDiskMax: number; sysmonTempMax: number; sysmonLhm: boolean; sysmonLhmPort: number };

function sysmonSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  const show = showOf(cfg.sysmonShow);
  const toggle = (on: boolean, change: (v: boolean) => void, name: string) => {
    const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": name });
    el.addEventListener("click", () => { on = !on; el.classList.toggle("on", on); el.setAttribute("aria-pressed", String(on)); change(on); });
    return el;
  };
  const row = (label: string, ...kids: Node[]) => h("div", { class: "row" }, h("label", { text: label }), ...kids);
  const shown = (k: keyof Show, label: string) => row(label, toggle(show[k], (v) => { show[k] = v; void ms.save({ sysmonShow: { ...show } }); }, label));
  const num = (label: string, key: keyof Cfg, lo: number, hi: number, dflt: number) => {
    const i = h("input", { type: "number", min: lo, max: hi, value: clampInt(cfg[key], lo, hi, dflt) }) as HTMLInputElement;
    i.addEventListener("change", () => {
      const n = clampInt(i.value, lo, hi, -1);
      if (n < 0) i.value = String(clampInt(ms.get<Cfg>()[key], lo, hi, dflt));
      else void ms.save({ [key]: n });
    });
    return row(label, i);
  };
  const lhmState = h("span", { class: "hint" });
  const paint = (i: LhmInfo) => {
    lhmState.textContent = i.installed ? `Instalado (v${i.version}) em ${i.dir}` : `Não instalado. Download opcional: v${i.version}, ${bytes(i.size)}, de github.com (LibreHardwareMonitor).`;
  };
  void SysmonBridge.lhmInfo().then(paint, () => {});
  return {
    el: h("section", { id: "sysmon" },
      h("h2", {}, h("span", { text: "Sistema" })),
      h("div", { class: "hint", text: "A leitura só acontece com a seção Sistema aberta. Nenhum dado sai do computador, exceto o teste de velocidade (ao clicar) e o download opcional." }),
      shown("cpu", "CPU"), shown("ram", "Memória"), shown("gpu", "GPU"), shown("disk", "Disco"), shown("net", "Rede"), shown("temp", "Temperaturas"),
      row("Alertas (avisos na ilha)", toggle(cfg.sysmonAlerts === true, (v) => void ms.save({ sysmonAlerts: v }), "Alertas")),
      num("CPU acima de (%)", "sysmonCpuMax", 10, 100, 90), num("Memória acima de (%)", "sysmonRamMax", 10, 100, 90),
      num("Disco do sistema acima de (%)", "sysmonDiskMax", 10, 100, 95), num("Temperatura acima de (°C)", "sysmonTempMax", 40, 120, 85),
      h("div", { class: "hint", text: "Um alerta exige 30 s acima do limite e não se repete por 10 min. O de temperatura usa a última leitura vista na seção Sistema." }),
      h("h3", {}, h("span", { text: "Temperatura da CPU (opcional)" })),
      h("div", { class: "hint", text: "A temperatura da CPU exige o LibreHardwareMonitor (programa de terceiros, driver próprio, pede administrador por conta dele). Nada é baixado sem você clicar em Baixar na seção Sistema." }),
      row("Ler do LibreHardwareMonitor", toggle(cfg.sysmonLhm === true, (v) => void ms.save({ sysmonLhm: v }), "Ler do LibreHardwareMonitor")),
      num("Porta do servidor web", "sysmonLhmPort", 1024, 65535, 8085),
      row("Estado", lhmState),
    ),
  };
}

export const settingsSections = { sysmon: sysmonSettingsSection };
