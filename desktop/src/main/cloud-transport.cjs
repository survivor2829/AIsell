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
  async function request(route, { body, maxBytes = 256 * 1024, destination, expected, onProgress } = {}) {
    const url = new URL(route, origin);
    if (url.origin !== origin.origin || !route.startsWith("/")) fail("cloud_origin_invalid");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        agent, method: data ? "POST" : "GET",
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}
      });
      requests.add(req);
      const totalTimer = setTimeout(() => req.destroy(new Error("cloud_timeout")), destination ? 30 * 60_000 : 30_000);
      req.setTimeout(30_000, () => req.destroy(new Error("cloud_timeout")));
      req.on("close", () => { clearTimeout(totalTimer); requests.delete(req); });
      req.on("error", reject);
      req.on("response", async (res) => {
        try {
          if (res.statusCode !== 200) { res.resume(); fail(`cloud_http_${res.statusCode}`); }
          if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); fail("cloud_response_too_large"); }
          let size = 0;
          const hash = crypto.createHash("sha256");
          const chunks = [];
          const meter = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > maxBytes) return callback(new Error("cloud_response_too_large"));
            hash.update(chunk);
            onProgress?.(size);
            callback(null, chunk);
          } });
          if (destination) {
            await pipeline(res, meter, fs.createWriteStream(destination, { flags: "wx" }));
            if (size !== expected.size || hash.digest("hex") !== expected.sha256) fail("cloud_download_invalid");
            resolve({ size });
          } else {
            for await (const chunk of res) {
              size += chunk.length;
              if (size > maxBytes) { res.destroy(); fail("cloud_response_too_large"); }
              chunks.push(chunk);
            }
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          }
        } catch (error) { reject(error); }
      });
      req.end(data);
    });
  }
  return { request, close() { for (const req of requests) req.destroy(new Error("cloud_stopped")); agent.destroy(); } };
}
module.exports = { createTransport };
