// 省电 (customers, 2026-11-19: 「装了软件电脑就卡，一关就不卡」). Measured on the development machine,
// doing nothing: about a third of one core on the sign-in page and a quarter on the home page,
// mostly decorative motion (looping videos, typing text, the pet following the pointer) and polling.
// Two switches decide what may move:
// - a low-power computer (four cores or fewer, 4 GB memory or less, or Windows set to reduce
//   animations) gets still pictures instead of decorative video and typing;
// - decorative motion and status polling slow down whenever the window is not in use (hidden,
//   minimised or another program has the focus). The main window keeps background throttling off
//   so automatic tasks continue, so the page has to do this itself.
import { useEffect, useState } from "react";
import { isWindowShown, onWindowShownChange } from "./window-shown";

const memoryGb = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 0;
export const lowPowerDevice = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  || (navigator.hardwareConcurrency || 8) <= 4 || (memoryGb > 0 && memoryGb <= 4);

let focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
window.addEventListener("focus", () => { focused = true; notify(); });
window.addEventListener("blur", () => { focused = false; notify(); });
onWindowShownChange(notify);

// The floating windows (小玺, progress) are shown without taking the focus and let clicks through:
// for them being shown is being in use, or the pet's "working" dots would freeze for a whole task.
const floatingWindow = new URLSearchParams(location.search).has("floating");
export const isWindowActive = () => isWindowShown() && (floatingWindow || focused);
export function onWindowActiveChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useWindowActive() {
  const [active, setActive] = useState(isWindowActive);
  useEffect(() => onWindowActiveChange(() => setActive(isWindowActive())), []);
  return active;
}
