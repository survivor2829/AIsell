const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { fail } = require("../shared/cloud-contract.cjs");

function createTransport(config) {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") fail("cloud_origin_invalid");
  const agent = new https.Agent({ ca: config.caPem || undefined, keepAlive: true, maxSockets: 3 });
  const requests = new Set();
  async function request(route, { body, maxBytes = 256 * 1024, destination, expected, onProgress, resume = false } = {}) {
    const url = new URL(route, origin);
    if (url.origin !== origin.origin || !route.startsWith("/")) fail("cloud_origin_invalid");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let offset = 0;
    if (destination && resume) {
      try {
        const stat = await fs.promises.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) fail("cloud_download_path_invalid");
        offset = stat.size;
        if (offset >= expected.size) {
          const hash = crypto.createHash("sha256");
          if (offset === expected.size) for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
          if (offset === expected.size && hash.digest("hex") === expected.sha256) { onProgress?.(offset); return { size: offset, resumedBytes: offset }; }
          await fs.promises.truncate(destination, 0); offset = 0;
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return new Promise((resolve, reject) => {
      let response;
      const req = https.request(url, {
        agent, method: data ? "POST" : "GET",
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : offset ? { Range: `bytes=${offset}-` } : {}
      });
      requests.add(req);
      const totalTimer = setTimeout(() => req.destroy(new Error("cloud_timeout")), destination ? 30 * 60_000 : 30_000);
      req.setTimeout(30_000, () => req.destroy(new Error("cloud_timeout")));
      req.on("close", () => { clearTimeout(totalTimer); requests.delete(req); });
      req.on("error", error => { if (response) response.destroy(error); else reject(error); });
      req.on("response", async (res) => {
        response = res;
        try {
          let start = 0;
          if (res.statusCode === 206 && destination && resume && offset) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers["content-range"] || "");
            if (!range || Number(range[1]) !== offset || Number(range[2]) !== expected.size - 1
                || Number(range[3]) !== expected.size || Number(res.headers["content-length"]) !== expected.size - offset) {
              res.destroy(); fail("cloud_range_invalid");
            }
            start = offset;
          } else if (res.statusCode !== 200) { res.resume(); fail(`cloud_http_${res.statusCode}`); }
          if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); fail("cloud_response_too_large"); }
          let size = start;
          const hash = crypto.createHash("sha256");
          if (start) for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
          const chunks = [];
          const meter = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > maxBytes) return callback(new Error("cloud_response_too_large"));
            hash.update(chunk);
            onProgress?.(size);
            callback(null, chunk);
          } });
          if (destination) {
            onProgress?.(start);
            await pipeline(res, meter, fs.createWriteStream(destination, { flags: resume ? start ? "a" : "w" : "wx" }));
            if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
              if (resume) await fs.promises.truncate(destination, 0);
              fail("cloud_download_invalid");
            }
            resolve({ size, resumedBytes: start });
          } else {
            for await (const chunk of res) {
              size += chunk.length;
              if (size > maxBytes) { res.destroy(); fail("cloud_response_too_large"); }
              chunks.push(chunk);
            }
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          }
        } catch (error) { res.destroy(); reject(error); }
      });
      req.end(data);
    });
  }
  return { request, close() { for (const req of requests) req.destroy(new Error("cloud_stopped")); agent.destroy(); } };
}
module.exports = { createTransport };
