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

// 小玺 (user decisions 2026-10-30): a transparent always-on window, 小玺 on its right and its speech
// bubble to the left, at the vertical middle of the screen's right edge until the user drags it.
const SPRITE_WINDOW = Object.freeze({ width: 360, height: 230, rightGap: 6 });

function spritePosition(workArea, saved = null) {
  const area = { x: Math.round(Number(workArea?.x) || 0), y: Math.round(Number(workArea?.y) || 0), width: Math.round(Number(workArea?.width) || 0), height: Math.round(Number(workArea?.height) || 0) };
  // A saved place is kept while 小玺 would still be fully on this screen.
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)
    && saved.x >= area.x && saved.y >= area.y && saved.x + SPRITE_WINDOW.width <= area.x + area.width && saved.y + SPRITE_WINDOW.height <= area.y + area.height) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return { x: area.x + area.width - SPRITE_WINDOW.width - SPRITE_WINDOW.rightGap, y: area.y + Math.round((area.height - SPRITE_WINDOW.height) / 2) };
}

module.exports = {
  FLOATING_PROGRESS_WINDOW,
  floatingProgressPosition,
  SPRITE_WINDOW,
  spritePosition
};
