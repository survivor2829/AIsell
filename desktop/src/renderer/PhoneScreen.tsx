import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// One phone's live screen: the H.264 stream from the main process decoded with WebCodecs onto a
// canvas. With `onTouch`, pointer presses, drags and releases become touches at the same spot (0–1).
type ScreenPacket = { serial: string; type: "size" | "config" | "frame" | "closed"; key?: boolean; data?: Uint8Array; width?: number; height?: number };
type Listener = (packet: ScreenPacket) => void;

// One subscription for all screens, handed out by phone, instead of one listener per tile.
const listeners = new Map<string, Set<Listener>>();
let unsubscribe: (() => void) | null = null;
function listen(serial: string, listener: Listener) {
  if (!unsubscribe && window.xiaoxiPhoneMatrix?.onScreen) {
    unsubscribe = window.xiaoxiPhoneMatrix.onScreen((packet: ScreenPacket) => listeners.get(packet.serial)?.forEach((fn) => fn(packet)));
  }
  if (!listeners.has(serial)) listeners.set(serial, new Set());
  listeners.get(serial)!.add(listener);
  return () => { listeners.get(serial)?.delete(listener); };
}

// avc1.PPCCLL from the stream's SPS (the NAL unit of type 7 after a start code).
function codecFromConfig(data: Uint8Array) {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (value: number) => value.toString(16).padStart(2, "0");
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return "avc1.42e01e";
}

export function PhoneScreen({ serial, className = "", onTouch }: { serial: string; className?: string; onTouch?: (action: 0 | 1 | 2, x: number, y: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  const liveNow = useRef(false);
  const pressed = useRef(false);

  useEffect(() => {
    let decoder: VideoDecoder | null = null, config: Uint8Array | null = null, waitingForKey = true, time = 0;
    const draw = (frame: VideoFrame) => {
      const target = canvas.current;
      if (target) {
        if (target.width !== frame.displayWidth || target.height !== frame.displayHeight) { target.width = frame.displayWidth; target.height = frame.displayHeight; }
        target.getContext("2d")?.drawImage(frame, 0, 0);
        if (!liveNow.current) { liveNow.current = true; setLive(true); }
      }
      frame.close();
    };
    const reset = () => { try { decoder?.close(); } catch { /* already closed */ } decoder = null; waitingForKey = true; };
    const stop = listen(serial, (packet) => {
      if (packet.type === "closed") { reset(); liveNow.current = false; setLive(false); return; }
      if (packet.type === "config" && packet.data) {
        config = new Uint8Array(packet.data);
        reset();
        decoder = new VideoDecoder({ output: draw, error: () => reset() });
        decoder.configure({ codec: codecFromConfig(config), optimizeForLatency: true });
        return;
      }
      if (packet.type !== "frame" || !packet.data || !decoder || decoder.state !== "configured") return;
      if (waitingForKey && !packet.key) return;
      let data = new Uint8Array(packet.data);
      if (packet.key && config) { const joined = new Uint8Array(config.length + data.length); joined.set(config); joined.set(data, config.length); data = joined; }
      waitingForKey = false;
      // A decoder that falls behind drops to the next key frame instead of piling up.
      if (decoder.decodeQueueSize > 8 && !packet.key) return;
      decoder.decode(new EncodedVideoChunk({ type: packet.key ? "key" : "delta", timestamp: (time += 33333), data }));
    });
    return () => { stop(); reset(); };
  }, [serial]);

  const at = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height] as const;
  };
  const handlers = onTouch ? {
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => { pressed.current = true; event.currentTarget.setPointerCapture(event.pointerId); onTouch(0, ...at(event)); },
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => { if (pressed.current) onTouch(2, ...at(event)); },
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => { if (pressed.current) { pressed.current = false; onTouch(1, ...at(event)); } },
    onPointerCancel: (event: ReactPointerEvent<HTMLCanvasElement>) => { if (pressed.current) { pressed.current = false; onTouch(1, ...at(event)); } }
  } : {};
  return <div className={`phone-screen ${live ? "is-live" : ""} ${className}`}>
    <canvas ref={canvas} {...handlers} />
    {!live && <span className="phone-screen-wait">连接画面中…</span>}
  </div>;
}
