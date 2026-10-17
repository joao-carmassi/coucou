// The board: the home tab ("Início") and the `overview` view. Pure TS, no Rust. It owns no pill and
// knows no module: the left card of a pill is asked of the module that owns it (services `board.*`,
// typed in api.ts). With only this module on, the home shows the pill list or an empty note.

import "./board.css";
import type { ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { startPrimary } from "./primary";
import { BOARD_H, buildBoard } from "./view";

const HOUSE = "M12 3.2 2.8 10.6V21h6.6v-5.4h5.2V21h6.6V10.6L12 3.2z";

export const board: ModuleDef = {
  id: "board",
  views: [
    { name: "overview", layout: { height: BOARD_H, botX: 68, botY: null, botDiameter: 58 }, build: buildBoard },
  ],
  tabs: [{ view: "overview", title: "Início", icon: () => svg(HOUSE, 13), order: 0, home: true }],
  start: (api) => {
    const offs = [
      api.provide("board.host", true),
      startPrimary(api),
    ];
    return () => offs.reverse().forEach((o) => o());
  },
};
