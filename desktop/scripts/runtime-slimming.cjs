// Files the packaged browsers never use. The app is Chinese (simplified, or
// traditional on such systems) with an English fallback, so the other interface
// languages are dead weight (about 90 MB over Electron and the Remotion
// Chromium); the Chromium download also carries an installer and test programs
// that nothing launches.
const KEPT_LOCALES = new Set(["en-US.pak", "zh-CN.pak", "zh-TW.pak"]);
const UNUSED_BROWSER_PROGRAMS = new Set(["setup.exe", "interactive_ui_tests.exe", "elevated_tracing_service.exe"]);

// `relative` uses forward slashes, relative to the runtime root.
function keepsLocale(relative) {
  const match = /^locales\/([^/]+)$/.exec(relative);
  return !match || !match[1].endsWith(".pak") || KEPT_LOCALES.has(match[1]);
}

function keepsBrowserFile(relative) {
  return keepsLocale(relative) && !UNUSED_BROWSER_PROGRAMS.has(relative);
}

module.exports = { KEPT_LOCALES, keepsLocale, keepsBrowserFile };
