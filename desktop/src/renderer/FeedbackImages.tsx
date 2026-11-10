import { useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, X } from "lucide-react";

// Screenshots in 吐槽 (user 2026-11-09): press Ctrl+V after taking a screenshot, or pick a picture.
// Each becomes a JPEG no wider or taller than 1600 px, so four of them stay small enough to send.
export const MAX_FEEDBACK_IMAGES = 4;
const LONG_SIDE = 1600, MAX_BYTES = 2 * 1024 * 1024;

async function toJpeg(file: Blob) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55]) {
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
  async function add(files: Blob[]) {
    if (!files.length) return;
    const room = MAX_FEEDBACK_IMAGES - images.length;
    if (room <= 0) { setNote(`最多 ${MAX_FEEDBACK_IMAGES} 张截图`); return; }
    try {
      const added = await Promise.all(files.slice(0, room).map(toJpeg));
      onChange([...images, ...added]);
      setNote(files.length > room ? `最多 ${MAX_FEEDBACK_IMAGES} 张截图，多的没有加上` : "");
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
  return <div className="feedback-images">
    <div className="feedback-images-row">
      {images.map((image, index) => <figure key={index} className="feedback-image">
        <img src={image} alt={`截图 ${index + 1}`} />
        <button type="button" aria-label={`删除截图 ${index + 1}`} disabled={disabled} onClick={() => onChange(images.filter((_, other) => other !== index))}><X size={14} /></button>
      </figure>)}
      {images.length < MAX_FEEDBACK_IMAGES && <button type="button" className="feedback-image-add" disabled={disabled} onClick={() => input.current?.click()}>
        <ImagePlus size={22} /><span>添加截图</span>
      </button>}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(event) => { void add(Array.from(event.target.files || [])); event.target.value = ""; }} />
    </div>
    <p className="feedback-images-hint">{note || `截图后在这里按 Ctrl+V 就能贴上，最多 ${MAX_FEEDBACK_IMAGES} 张`}</p>
  </div>;
}
