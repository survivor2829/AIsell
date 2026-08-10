const MOMENTS_SURFACE_PROFILE = Object.freeze({
  renderPaneName: "MMUIRenderSubWindowHW",
  minimumWindowWidth: 300,
  minimumWindowHeight: 300,
  integratedSidebarWidthRatio: 0.38,
  integratedSidebarScanLogicalHeight: 300,
  integratedPrimaryRailScanLogicalBounds: Object.freeze({
    left: 8,
    top: 80,
    width: 44,
    height: 260
  }),
  modes: Object.freeze({
    standalone: Object.freeze({ title: "朋友圈", rootName: "朋友圈" }),
    integrated: Object.freeze({ title: "微信", rootName: "微信" })
  })
});

function normalizeExpectedMomentsSurface(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const surfaceMode = String(value.surfaceMode ?? "");
  const profile = MOMENTS_SURFACE_PROFILE.modes[surfaceMode];
  const pid = Number(value.pid);
  const hWnd = String(value.hWnd ?? "");
  const title = String(value.title ?? "");
  const className = String(value.className ?? "");
  if (!profile
    || title !== profile.title
    || !Number.isInteger(pid)
    || pid <= 0
    || !/^[1-9]\d*$/u.test(hWnd)
    || !className
    || className.length > 256) return null;
  return { surfaceMode, pid, hWnd, title, className };
}

function validMomentsSurfaceRoot(value) {
  const surfaceMode = String(value?.surfaceMode ?? "");
  const profile = MOMENTS_SURFACE_PROFILE.modes[surfaceMode];
  return Boolean(profile
    && value?.title === profile.title
    && value?.rootName === profile.rootName);
}

module.exports = {
  MOMENTS_SURFACE_PROFILE,
  normalizeExpectedMomentsSurface,
  validMomentsSurfaceRoot
};
