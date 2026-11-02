import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type VideoHTMLAttributes } from "react";
import "./SpeedVideo.css";

const SPEEDS = [1, 1.5, 2] as const;
export const DEFAULT_TUTORIAL_SPEED = 2;

// Tutorial and demo recordings run a minute or more, so they start at 2x (user 2026-11-02); the
// viewer can slow them down. The rate is set again after each load, since a new source resets it. The player's own speed
// menu is turned off so there is one speed control, and the buttons sit over the picture so no container can cut them off.
export const SpeedVideo = forwardRef<HTMLVideoElement, VideoHTMLAttributes<HTMLVideoElement>>(function SpeedVideo(props, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const [speed, setSpeed] = useState<number>(DEFAULT_TUTORIAL_SPEED);
  useImperativeHandle(ref, () => video.current as HTMLVideoElement);
  useEffect(() => { if (video.current) video.current.playbackRate = speed; }, [speed]);
  return <div className="speed-video">
    <video {...props} controlsList="noplaybackrate" ref={video} onLoadedMetadata={(event) => { event.currentTarget.playbackRate = speed; props.onLoadedMetadata?.(event); }} />
    <div className="speed-video-rates" role="radiogroup" aria-label="播放速度">
      {SPEEDS.map((rate) => <button type="button" key={rate} role="radio" aria-checked={speed === rate} className={speed === rate ? "is-on" : ""} onClick={() => setSpeed(rate)}>{rate}x</button>)}
    </div>
  </div>;
});

// Running time at the default speed, for labels such as 「约 34 秒（2 倍速）」.
export function atTutorialSpeed(seconds: number) {
  const shown = Math.round(seconds / DEFAULT_TUTORIAL_SPEED);
  return `约 ${shown >= 60 ? `${Math.floor(shown / 60)} 分 ${shown % 60} 秒` : `${shown} 秒`}（2 倍速）`;
}
