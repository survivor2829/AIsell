const CONTENT_MEDIA_SCHEME = "xiaoxi-content";
// The stable bootstrap and selected application can load different module paths.
// Electron's protocol object is shared, so register its privileges only once.
const key = Symbol.for("xiaoxi.content-media.registered-protocols");
const registered = globalThis[key] ||= new WeakSet();

function registerContentMediaScheme(protocol) {
  if (registered.has(protocol)) return;
  protocol.registerSchemesAsPrivileged([{
    scheme: CONTENT_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }]);
  registered.add(protocol);
}

module.exports = { CONTENT_MEDIA_SCHEME, registerContentMediaScheme };
