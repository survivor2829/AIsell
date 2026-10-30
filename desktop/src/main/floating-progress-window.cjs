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

// 小玺, the small transparent sprite in the bottom-right corner that shows automation running outside
// the app (WeChat, Chrome) instead of the old progress card (user decision 2026-10-30).
const SPRITE_WINDOW = Object.freeze({ width: 248, height: 236, rightGap: 14, bottomGap: 14 });

function spritePosition(workArea) {
  return {
    x: Math.round(Number(workArea?.x) || 0) + Math.round(Number(workArea?.width) || 0) - SPRITE_WINDOW.width - SPRITE_WINDOW.rightGap,
    y: Math.round(Number(workArea?.y) || 0) + Math.round(Number(workArea?.height) || 0) - SPRITE_WINDOW.height - SPRITE_WINDOW.bottomGap
  };
}

module.exports = {
  FLOATING_PROGRESS_WINDOW,
  floatingProgressPosition,
  SPRITE_WINDOW,
  spritePosition
};
