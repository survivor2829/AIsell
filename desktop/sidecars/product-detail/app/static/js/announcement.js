(function () {
  'use strict';

  var SEEN_KEY = 'xx_ai_seen_announcement_version';
  var SOURCE_URL = '/static/changelog.json';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getSeen() {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch (e) { return ''; }
  }
  function markSeen(version) {
    try { localStorage.setItem(SEEN_KEY, version); } catch (e) { /* private mode etc. */ }
  }

  function buildBell() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xx-ann-bell';
    btn.setAttribute('aria-label', '更新公告');
    btn.title = '更新公告';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
        '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>' +
      '</svg>' +
      '<span class="xx-ann-dot" hidden></span>';
    return btn;
  }

  function renderEntry(e) {
    var items = (e.highlights || []).map(function (h) {
      return '<li>' + escapeHtml(h) + '</li>';
    }).join('');
    return (
      '<article class="xx-ann-entry">' +
        '<header>' +
          '<span class="xx-ann-version">v' + escapeHtml(e.version) + '</span>' +
          '<time>' + escapeHtml(e.date || '') + '</time>' +
        '</header>' +
        '<h3>' + escapeHtml(e.title || '') + '</h3>' +
        (items ? '<ul>' + items + '</ul>' : '') +
      '</article>'
    );
  }

  function buildPanel(data) {
    var panel = document.createElement('div');
    panel.className = 'xx-ann-panel';
    panel.hidden = true;
    var entriesHtml = (data.entries || []).slice(0, 5).map(renderEntry).join('') ||
      '<p class="xx-ann-empty">暂无更新公告</p>';
    panel.innerHTML =
      '<div class="xx-ann-panel-head">' +
        '<strong>更新公告</strong>' +
        '<button type="button" class="xx-ann-close" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="xx-ann-panel-body">' + entriesHtml + '</div>' +
      '<div class="xx-ann-panel-foot">' +
        '<button type="button" class="xx-ann-ack">我知道了</button>' +
      '</div>';
    return panel;
  }

  function init() {
    var mount = document.querySelector('.topbar-right');
    if (!mount) return;

    var bell = buildBell();
    mount.insertBefore(bell, mount.firstChild);

    fetch(SOURCE_URL + '?t=' + Date.now(), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.entries || !data.entries.length) return;
        var latest = data.latest_version || data.entries[0].version || '';

        var panel = buildPanel(data);
        document.body.appendChild(panel);

        var dot = bell.querySelector('.xx-ann-dot');
        if (latest && getSeen() !== latest) dot.hidden = false;

        function place() {
          var rect = bell.getBoundingClientRect();
          panel.style.top = (rect.bottom + 8) + 'px';
          panel.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
        }
        function open() {
          place();
          panel.hidden = false;
          requestAnimationFrame(function () { panel.classList.add('xx-ann-open'); });
        }
        function close() {
          panel.classList.remove('xx-ann-open');
          setTimeout(function () { panel.hidden = true; }, 180);
          if (latest) markSeen(latest);
          dot.hidden = true;
        }

        bell.addEventListener('click', function (e) {
          e.stopPropagation();
          panel.hidden ? open() : close();
        });
        panel.addEventListener('click', function (e) { e.stopPropagation(); });
        panel.querySelector('.xx-ann-close').addEventListener('click', close);
        panel.querySelector('.xx-ann-ack').addEventListener('click', close);
        document.addEventListener('click', function () {
          if (!panel.hidden) close();
        });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && !panel.hidden) close();
        });
        window.addEventListener('resize', function () {
          if (!panel.hidden) place();
        });
      })
      .catch(function () { /* network 错误就静默不显示, 不影响主流程 */ });
  }

  ready(init);
})();
