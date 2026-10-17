import { startCompanion } from "../companion/companion";

const canvas = document.getElementById("c");
if (canvas instanceof HTMLCanvasElement) startCompanion(canvas);
