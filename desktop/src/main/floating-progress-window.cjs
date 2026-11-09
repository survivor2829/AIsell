const FLOATING_PROGRESS_WINDOW = Object.freeze({
  width: 292,
  height: 286,
  rightGap: 22
});

function floatingProgressPosition(workArea) {
  return {
    x: Math.round(Number(workArea?.x) || 0)
      + Math.round(Number(workArea?.width) || 0)
      - FLOATING_PROGRESS_WINDOW.width
      - FLOATING_PROGRESS_WINDOW.rightGap,
    y: Math.round(Number(workArea?.y) || 0)
      + Math.round(((Number(workArea?.height) || 0) - FLOATING_PROGRESS_WINDOW.height) / 2)
  };
}

// The mascot (user decisions 2026-11-08): a transparent always-on window, the pet at its right and its
// speech bubble to the left, standing on the bottom edge of the screen. Only its left-right place is kept.
const SPRITE_WINDOW = Object.freeze({ width: 400, height: 260, rightGap: 6 });

function spriteArea(workArea) {
  return { x: Math.round(Number(workArea?.x) || 0), y: Math.round(Number(workArea?.y) || 0), width: Math.round(Number(workArea?.width) || 0), height: Math.round(Number(workArea?.height) || 0) };
}
// 小玺 always lands where the whole of it can be seen (customer PC 2026-11-09: it fell behind a dark
// taskbar and was gone). Windows can report the space above the taskbar as the whole screen (an
// auto-hidden or misreported taskbar), so the floor also keeps a taskbar's height clear of the screen's
// bottom edge when no taskbar is reported there. Takes a display ({ bounds, workArea }) or, from older callers, just a work area.
const SPRITE_FLOOR_GAP = 64;
function spriteFloor(display) {
  const area = spriteArea(display?.workArea || display), bottom = area.y + area.height;
  if (!display?.bounds) return bottom;
  const screen = spriteArea(display.bounds);
  // Nothing taken off the bottom: an auto-hidden taskbar pops up there, so leave room for it.
  return bottom >= screen.y + screen.height ? screen.y + screen.height - SPRITE_FLOOR_GAP : bottom;
}
function spriteGround(display) {
  const area = spriteArea(display?.workArea || display);
  return Math.max(area.y, spriteFloor(display) - SPRITE_WINDOW.height);
}
function spritePosition(display, saved = null) {
  const area = spriteArea(display?.workArea || display), right = area.x + area.width - SPRITE_WINDOW.width - SPRITE_WINDOW.rightGap;
  const onScreen = Number.isFinite(saved?.x) && saved.x >= area.x && saved.x <= right;
  return { x: onScreen ? Math.round(saved.x) : right, y: spriteGround(display) };
}
// It strolls on the right half only: WeChat sits at the top left and its automation reads that part of the screen.
function spriteWalkRange(workArea, currentX) {
  const area = spriteArea(workArea);
  return { min: Math.min(Math.round(currentX), area.x + Math.round(area.width / 2)), max: area.x + area.width - SPRITE_WINDOW.width - SPRITE_WINDOW.rightGap };
}

module.exports = {
  FLOATING_PROGRESS_WINDOW,
  floatingProgressPosition,
  SPRITE_WINDOW,
  SPRITE_FLOOR_GAP,
  spriteGround,
  spritePosition,
  spriteWalkRange
};
