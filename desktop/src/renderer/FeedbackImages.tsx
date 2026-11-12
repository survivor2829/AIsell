import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { ClipboardPaste, ImagePlus, X } from "lucide-react";

// Screenshots in 吐槽 (user 2026-11-09): press Ctrl+V after taking a screenshot, or pick a picture.
// Each becomes a JPEG no wider or taller than 1600 px, so four of them stay small enough to send.
export const MAX_FEEDBACK_IMAGES = 4;
const LONG_SIDE = 1600, MAX_BYTES = 1024 * 1024;

async function toJpeg(file: Blob) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if ((url.length - 23) * 0.75 <= MAX_BYTES) return url;
  }
  throw new Error("这张图片太大了，请截小一点再试。");
}

// Pictures in the clipboard of a paste event; empty when the paste is only text.
export function pastedImages(event: ClipboardEvent) {
  return Array.from<DataTransferItem>(event.clipboardData?.items || []).filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
}

export function useFeedbackImages(images: string[], onChange: (next: string[]) => void) {
  const [note, setNote] = useState("");
  const latest = useRef(images);
  latest.current = images;
  async function add(files: Blob[]) {
    if (!files.length) return;
    if (latest.current.length >= MAX_FEEDBACK_IMAGES) { setNote(`最多 ${MAX_FEEDBACK_IMAGES} 张截图`); return; }
    try {
      const added = await Promise.all(files.slice(0, MAX_FEEDBACK_IMAGES).map(toJpeg));
      // Read the list again after converting: another paste or a delete may have happened meanwhile.
      const current = latest.current, next = [...current, ...added].slice(0, MAX_FEEDBACK_IMAGES);
      latest.current = next;
      onChange(next);
      setNote(current.length + added.length > MAX_FEEDBACK_IMAGES ? `最多 ${MAX_FEEDBACK_IMAGES} 张截图，多的没有加上` : "");
    } catch (reason) { setNote(String((reason as Error)?.message || "这张图片读不出来，请换一张。")); }
  }
  // Ctrl+V anywhere in the form: a picture is added, plain text pastes as usual.
  const onPaste = (event: ClipboardEvent) => {
    const files = pastedImages(event);
    if (!files.length) return;
    event.preventDefault();
    void add(files);
  };
  return { add, onPaste, note };
}

export function FeedbackImages({ images, onChange, disabled, add, note }: {
  images: string[]; onChange: (next: string[]) => void; disabled?: boolean; add: (files: Blob[]) => Promise<void>; note: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [clipboardNote, setClipboardNote] = useState("");
  const [pasting, setPasting] = useState(false);
  // A later picture or error replaces the clipboard hint.
  useEffect(() => setClipboardNote(""), [images.length, note]);
  // Customers rarely know Ctrl+V works, so a button reads the clipboard for them (user 2026-11-11).
  async function pasteFromClipboard() {
    if (pasting) return;
    setPasting(true); setClipboardNote("");
    try {
      const files: Blob[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((kind) => kind.startsWith("image/"));
        if (type) files.push(await item.getType(type));
      }
      if (!files.length) { setClipboardNote("剪贴板里没有截图，先用微信截个图（Alt+A），再点“粘贴截图”"); return; }
      await add(files);
    } catch { setClipboardNote("没读到剪贴板，请在这里按 Ctrl+V 试试"); }
    finally { setPasting(false); }
  }
  return <div className="feedback-images">
    <div className="feedback-images-row">
      {images.map((image, index) => <figure key={index} className="feedback-image">
        <img src={image} alt={`截图 ${index + 1}`} />
        <button type="button" aria-label={`删除截图 ${index + 1}`} disabled={disabled} onClick={() => onChange(images.filter((_, other) => other !== index))}><X size={14} /></button>
      </figure>)}
      {images.length < MAX_FEEDBACK_IMAGES && <button type="button" className="feedback-image-add" disabled={disabled} onClick={() => input.current?.click()}>
        <ImagePlus size={22} /><span>添加截图</span>
      </button>}
      {images.length < MAX_FEEDBACK_IMAGES && <button type="button" className="feedback-image-add" disabled={disabled || pasting} onClick={() => void pasteFromClipboard()}>
        <ClipboardPaste size={22} /><span>粘贴截图</span>
      </button>}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(event) => { void add(Array.from(event.target.files || [])); event.target.value = ""; }} />
    </div>
    <p className="feedback-images-hint">{clipboardNote || note || `截好图后点“粘贴截图”（或按 Ctrl+V）就能贴上，最多 ${MAX_FEEDBACK_IMAGES} 张`}</p>
  </div>;
}
