const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic, writeJsonAtomic } = require("./atomic-file.cjs");

const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_ID = /^[a-f0-9]{64}$/;

function normalizeTouchLink(value) {
  const link = String(value || "").trim();
  if (!link) return "";
  try {
    const url = new URL(link);
    if (link.length > 2048 || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new Error("请填写完整的 http:// 或 https:// 网址。"); }
  return link;
}

function createTouchMediaStore({ dataDir, nativeImage }) {
  const root = path.join(dataDir, "message-images");
  function file(id, extension) {
    if (!IMAGE_ID.test(String(id || ""))) throw new Error("图片记录无效，请重新添加图片。");
    return path.join(root, `${id}.${extension}`);
  }
  function resolve(id) {
    const imagePath = file(id, "png");
    try {
      const stat = fs.statSync(imagePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw new Error();
      const bytes = fs.readFileSync(imagePath);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== id) throw new Error();
      const meta = JSON.parse(fs.readFileSync(file(id, "json"), "utf8"));
      return { id, path: imagePath, sha256: id, name: String(meta.name || "图片"), size: bytes.length };
    } catch { throw new Error("已保存的触达图片缺失或发生变化，请重新添加图片。"); }
  }
  function describe(id) {
    const image = resolve(id);
    const thumbnail = nativeImage.createFromPath(image.path).resize({ width: 160, quality: "good" });
    return { id, name: image.name, size: image.size, preview: thumbnail.toDataURL() };
  }
  function importFiles(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_IMAGES) throw new Error(`每次最多添加 ${MAX_IMAGES} 张图片。`);
    // Decode and validate the complete selection before storing anything.
    const images = paths.map((source) => {
      if (!/\.(png|jpe?g)$/i.test(source)) throw new Error("请选择 PNG 或 JPG 图片。");
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw new Error("单张图片需在 20 MB 以内。");
      const decoded = nativeImage.createFromPath(source);
      const size = decoded.getSize();
      if (decoded.isEmpty() || size.width * size.height > 40_000_000) throw new Error("图片无法读取或尺寸过大，请换一张图片。");
      const bytes = decoded.toPNG();
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("图片展开后超过 20 MB，请缩小图片后添加。");
      return { id: crypto.createHash("sha256").update(bytes).digest("hex"), bytes, name: path.basename(source) };
    });
    fs.mkdirSync(root, { recursive: true });
    for (const image of images) {
      if (!fs.existsSync(file(image.id, "png"))) writeFileAtomic(file(image.id, "png"), image.bytes);
      if (!fs.existsSync(file(image.id, "json"))) writeJsonAtomic(file(image.id, "json"), { name: image.name });
    }
    return [...new Set(images.map((image) => image.id))].map(describe);
  }
  function validateIds(value = []) {
    if (!Array.isArray(value) || value.length > MAX_IMAGES || new Set(value).size !== value.length) throw new Error(`请最多添加 ${MAX_IMAGES} 张不同图片。`);
    return value.map((id) => resolve(id).id);
  }
  return { importFiles, resolve, describe, validateIds };
}

module.exports = { createTouchMediaStore, normalizeTouchLink, MAX_IMAGES };
