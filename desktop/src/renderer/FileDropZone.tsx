import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { UploadCloud } from "lucide-react";

// Files dragged in from another window (Explorer, WeChat, a download folder): the whole area lights
// up and dropping adds them (user request 2026-11-18). Only real file drags react; dragging a
// material card inside the page (application/x-xiaoxi-asset) passes straight through.
export const hasDraggedFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files");

export function FileDropZone({ disabled = false, onFiles, label = "松开即可添加视频或图片", className = "", children }: {
  disabled?: boolean; onFiles: (files: File[]) => void; label?: string; className?: string; children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child element; count them so the highlight does not flicker.
  const depth = useRef(0);
  const reset = () => { depth.current = 0; setOver(false); };
  return <div className={`file-drop-zone${over ? " is-over" : ""}${className ? ` ${className}` : ""}`}
    onDragEnter={(event) => { if (disabled || !hasDraggedFiles(event)) return; event.preventDefault(); depth.current += 1; setOver(true); }}
    onDragOver={(event) => { if (disabled || !hasDraggedFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={(event) => { if (!hasDraggedFiles(event)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
    onDrop={(event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      reset();
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length) onFiles(files);
    }}>
    {children}
    {over && <div className="file-drop-overlay" aria-hidden="true"><UploadCloud size={40} strokeWidth={1.6} /><strong>{label}</strong><span>也可以拖整个文件夹</span></div>}
  </div>;
}
