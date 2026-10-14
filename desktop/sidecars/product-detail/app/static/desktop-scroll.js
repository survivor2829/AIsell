// Only hand off a vertical wheel gesture when every inner scroll area is at its edge.
(() => {
  if (window.parent === window) return;
  document.addEventListener('wheel', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    for (let element = event.target instanceof Element ? event.target : null; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (!['auto', 'scroll'].includes(style.overflowY)) continue;
      const remaining = element.scrollHeight - element.clientHeight;
      if (remaining > 1 && (event.deltaY < 0 ? element.scrollTop > 1 : element.scrollTop < remaining - 1)) return;
    }
    // The desktop parent may have a file: origin. No business data crosses this message.
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    event.preventDefault();
    window.parent.postMessage({ type: 'xiaoxi:product-detail-scroll', deltaY: Math.max(-800, Math.min(800, pixels)) }, '*');
  }, { passive: false });
})();
