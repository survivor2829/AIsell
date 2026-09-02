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

module.exports = {
  FLOATING_PROGRESS_WINDOW,
  floatingProgressPosition
};
