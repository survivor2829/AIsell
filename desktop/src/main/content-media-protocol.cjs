const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CONTENT_MEDIA_SCHEME = "xiaoxi-content";
const GENERATED_VIDEO_ID = /^generated_video_[a-f0-9]{32}$/;

function registerContentMediaScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: CONTENT_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }]);
}

function parseContentMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== `${CONTENT_MEDIA_SCHEME}:`
    || url.hostname !== "generated"
    || parts.length !== 2
    || !GENERATED_VIDEO_ID.test(parts[0])
    || !new Set(["video", "thumbnail"]).has(parts[1])) {
    return null;
  }
  return { candidateId: parts[0], variant: parts[1] };
}

function registerContentMediaProtocol({ protocol, net, controller }) {
  if (!protocol || !net || !controller) {
    throw new TypeError("content media protocol dependencies are required");
  }
  protocol.handle(CONTENT_MEDIA_SCHEME, async (request) => {
    const target = parseContentMediaUrl(request.url);
    if (!target) return new Response("Not found", { status: 404 });
    try {
      const result = await controller.resolveGeneratedVideoPath(
        target.candidateId,
        target.variant
      );
      if (result?.generated_video_id !== target.candidateId
        || result?.variant !== target.variant) {
        return new Response("Not found", { status: 404 });
      }
      const candidate = String(result.absolute_path || "");
      if (!path.isAbsolute(candidate)) return new Response("Not found", { status: 404 });
      const resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isFile()) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

module.exports = {
  CONTENT_MEDIA_SCHEME,
  parseContentMediaUrl,
  registerContentMediaProtocol,
  registerContentMediaScheme
};
