// One shared heartbeat for every "still working" cue (live dots, waiting steps, carets, 小玺's dots).
// It flips <html data-beat> once a second; CSS shows the cue on "1". An endless CSS animation instead
// kept the whole window redrawing at the display rate: on a 200% / 120 Hz laptop the login page took a
// third of the graphics card (user report 2026-11-16). Two repaints a second keep the cue alive for as
// long as the work lasts at almost no cost. It rests while the window is hidden and never runs when
// Windows' "turn off animations" setting is on.
import { isWindowActive, onWindowActiveChange } from "./power-saving";

const root = document.documentElement;
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
let timer = 0;

function stop() {
  window.clearInterval(timer);
  timer = 0;
  root.dataset.beat = "0";
}

function sync() {
  // Rests while the window is not in use (another program has the focus), not only when hidden.
  if (!isWindowActive() || reduced?.matches) { stop(); return; }
  if (timer) return;
  timer = window.setInterval(() => { root.dataset.beat = root.dataset.beat === "1" ? "0" : "1"; }, 1000);
}

root.dataset.beat = "0";
sync();
onWindowActiveChange(sync);
reduced?.addEventListener?.("change", sync);

/** The shared beat, for components that step something themselves (小玺's three dots). */
export function onBeat(listener: (on: boolean) => void) {
  const observer = new MutationObserver(() => listener(root.dataset.beat === "1"));
  observer.observe(root, { attributes: true, attributeFilter: ["data-beat"] });
  return () => observer.disconnect();
}
