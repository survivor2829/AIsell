const PREFERRED_SIZE = { width: 1440, height: 900 };
const MINIMUM_SIZE = { width: 1180, height: 760 };

function windowLayout(workArea, previous) {
  const minWidth = Math.min(MINIMUM_SIZE.width, workArea.width);
  const minHeight = Math.min(MINIMUM_SIZE.height, workArea.height);
  const width = Math.min(workArea.width, Math.max(minWidth, previous?.width || PREFERRED_SIZE.width));
  const height = Math.min(workArea.height, Math.max(minHeight, previous?.height || PREFERRED_SIZE.height));
  const x = previous?.x ?? workArea.x + Math.floor((workArea.width - width) / 2);
  const y = previous?.y ?? workArea.y + Math.floor((workArea.height - height) / 2);
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width, height, minWidth, minHeight
  };
}

function keepWindowInWorkArea(window, screen) {
  let fitting = false;
  const fit = () => {
    if (fitting || window.isDestroyed() || window.isMinimized()) return;
    fitting = true;
    try {
      const bounds = window.getBounds();
      const next = windowLayout(screen.getDisplayMatching(bounds).workArea, bounds);
      const [minimumWidth, minimumHeight] = window.getMinimumSize();
      if (minimumWidth !== next.minWidth || minimumHeight !== next.minHeight) window.setMinimumSize(next.minWidth, next.minHeight);
      if (window.isMaximized() || window.isFullScreen()) return;
      const { x, y, width, height } = next;
      if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) window.setBounds({ x, y, width, height });
    } finally { fitting = false; }
  };
  // Wait until the user finishes dragging, so moving to another display is not prevented.
  for (const event of ["moved", "resized", "unmaximize", "restore", "leave-full-screen"]) window.on(event, fit);
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(event, fit);
  window.once("closed", () => {
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.removeListener(event, fit);
  });
}

module.exports = { windowLayout, keepWindowInWorkArea };
