// 主窗口是否显示着（没有最小化、没有隐藏）。
// 主窗口开了 backgroundThrottling: false（自动任务要在后台继续跑），这时 document.hidden 永远是 false，
// 最小化了也不变，所以动画和解码要不要暂停得问主进程。
let shown = true;
const listeners = new Set<() => void>();
window.xiaoxiWindowChrome?.onShownChange?.((value) => {
  shown = value;
  listeners.forEach((listener) => listener());
});

export const isWindowShown = () => shown;
export function onWindowShownChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
