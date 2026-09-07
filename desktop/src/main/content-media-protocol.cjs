const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const CONTENT_MEDIA_SCHEME = "xiaoxi-content";
const GENERATED_VIDEO_ID = /^generated_video_[a-f0-9]{32}$/;
const GUIDED_SUPPLEMENTAL_IMAGE_ID = /^guided_auto_mix_supplemental_image_[a-f0-9]{32}$/;

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
  if (url.protocol !== `${CONTENT_MEDIA_SCHEME}:` || parts.length !== 2) {
    return null;
  }
  if (url.hostname === "generated"
    && GENERATED_VIDEO_ID.test(parts[0])
    && new Set(["video", "thumbnail"]).has(parts[1])) {
    return { candidateId: parts[0], variant: parts[1] };
  }
  if (url.hostname === "asset" && /^asset_[a-f0-9]{32}$/.test(parts[0])
    && ["thumbnail", "preview"].includes(parts[1])) {
    return { assetId: parts[0], variant: parts[1] };
  }
  if (url.hostname === "supplemental"
    && GUIDED_SUPPLEMENTAL_IMAGE_ID.test(parts[0])
    && parts[1] === "image") {
    return { operationId: parts[0], variant: "image" };
  }
  return null;
}

function parseMediaRange(value, size) {
  if (typeof value !== "string" || !Number.isSafeInteger(size) || size < 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size === 0 || (match[1] === "" && match[2] === "")) {
    return null;
  }
  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size || start > end) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function mediaHeaders({ mimeType, size, start, end, partial }) {
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "Content-Length": String(end - start + 1),
    "Content-Type": mimeType
  };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return headers;
}

function registerContentMediaProtocol({ protocol, net, controller }) {
  if (!protocol || !net || !controller) {
    throw new TypeError("content media protocol dependencies are required");
  }
  protocol.handle(CONTENT_MEDIA_SCHEME, async (request) => {
    const target = parseContentMediaUrl(request.url);
    if (!target) return new Response("Not found", { status: 404 });
    try {
      const supplemental = Boolean(target.operationId);
      const result = target.assetId
        ? await controller.resolveAssetPreview(target.assetId, target.variant)
        : supplemental
        ? await controller.resolveGuidedAutoMixSupplementalImagePath(target.operationId)
        : await controller.resolveGeneratedVideoPath(target.candidateId, target.variant);
      if (target.assetId) {
        if (result?.asset_id !== target.assetId || result?.variant !== target.variant) {
          return new Response("Not found", { status: 404 });
        }
      } else if (supplemental) {
        if (result?.operation_id !== target.operationId || result?.variant !== target.variant) {
          return new Response("Not found", { status: 404 });
        }
      } else if (result?.generated_video_id !== target.candidateId
        || result?.variant !== target.variant) {
        return new Response("Not found", { status: 404 });
      }
      const candidate = String(result.absolute_path || "");
      if (!path.isAbsolute(candidate)) return new Response("Not found", { status: 404 });
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return new Response("Not found", { status: 404 });
      const size = stat.size;
      const method = String(request.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      const rangeValue = request.headers?.get("range") || "";
      const partial = Boolean(rangeValue);
      const range = partial ? parseMediaRange(rangeValue, size) : null;
      if (partial && !range) {
        return new Response(null, {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${size}`
          }
        });
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : Math.max(0, size - 1);
      const mimeType = target.assetId
        ? ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"].includes(result?.mime_type)
          ? result.mime_type : "application/octet-stream"
        : supplemental
        ? new Set(["image/png", "image/jpeg", "image/webp"]).has(String(result?.mime_type || ""))
          ? result.mime_type
          : "image/png"
        : target.variant === "thumbnail" ? "image/jpeg" : "video/mp4";
      const headers = mediaHeaders({ mimeType, size, start, end, partial });
      if (method === "HEAD" || size === 0) {
        return new Response(null, { status: partial ? 206 : 200, headers });
      }
      const body = Readable.toWeb(fs.createReadStream(resolved, { start, end }));
      return new Response(body, { status: partial ? 206 : 200, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

module.exports = {
  CONTENT_MEDIA_SCHEME,
  parseMediaRange,
  parseContentMediaUrl,
  registerContentMediaProtocol,
  registerContentMediaScheme
};
