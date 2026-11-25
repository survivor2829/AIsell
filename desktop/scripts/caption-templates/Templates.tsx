import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

// Five packaging templates (title bar + captions + keyword motion) for lead mixes and
// digital-human talking heads. Preview stage: the user picks which ones go into the app.

export type Word = { t: string; s: number };
export type Caption = { text: string; start: number; end: number; words: Word[] };
export type TemplateProps = {
  template: "live" | "notes" | "cinema" | "news" | "pop";
  clip: string;
  audio?: string;
  title: [string, string];
  captions: Caption[];
  keywords: string[];
  brand: { name: string; line: string };
  durationMs: number;
};

const FONTS = `
@font-face { font-family: Noto; src: url(${staticFile("noto.ttf")}); font-weight: 100 900; }
@font-face { font-family: Smiley; src: url(${staticFile("smiley.ttf")}); }
@font-face { font-family: SerifHeavy; src: url(${staticFile("serif.ttf")}); }
`;

const useMs = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { ms: (frame / fps) * 1000, frame, fps };
};

// Splits a caption into plain and keyword runs; each run knows when its first character is said.
function runs(caption: Caption, keywords: string[]) {
  const marks = new Array(caption.text.length).fill(false);
  for (const key of keywords) {
    let at = caption.text.indexOf(key);
    while (at >= 0) {
      for (let i = at; i < at + key.length; i += 1) marks[i] = true;
      at = caption.text.indexOf(key, at + key.length);
    }
  }
  const out: { text: string; key: boolean; s: number; chars: Word[] }[] = [];
  [...caption.text].forEach((ch, i) => {
    const word = caption.words[i] || { t: ch, s: caption.start + ((caption.end - caption.start) * i) / caption.text.length };
    const last = out[out.length - 1];
    if (last && last.key === marks[i]) {
      last.text += ch;
      last.chars.push({ t: ch, s: word.s });
    } else out.push({ text: ch, key: marks[i], s: word.s, chars: [{ t: ch, s: word.s }] });
  });
  return out;
}

const current = (captions: Caption[], ms: number) => captions.find((c) => ms >= c.start && ms < c.end + 120);

// A spring that starts at a given millisecond.
const springAt = (frame: number, fps: number, startMs: number, config = { damping: 12, stiffness: 180 }) =>
  spring({ frame: frame - Math.round((startMs / 1000) * fps), fps, config });

function Footage({ clip, audio }: { clip: string; audio?: string }) {
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile(clip)} muted={Boolean(audio)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {audio ? <Audio src={staticFile(audio)} /> : null}
    </AbsoluteFill>
  );
}

/* 1 现场红标：开拍式红底白字标题 + 粗描边字幕，关键词荧光绿弹出 */
function Live(p: TemplateProps) {
  const { ms, frame, fps } = useMs();
  const cap = current(p.captions, ms);
  const drop = springAt(frame, fps, 0);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 150, left: 70, right: 70, transform: `translateY(${(1 - drop) * -60}px)`, opacity: drop }}>
        <div style={{ background: "#E8262D", borderRadius: 18, padding: "22px 34px", boxShadow: "0 10px 0 rgba(0,0,0,.25)" }}>
          {p.title.map((line, i) => (
            <div key={i} style={{ font: "900 70px/1.22 Noto", color: i ? "#FFE14D" : "#fff", textAlign: "center" }}>{line}</div>
          ))}
        </div>
      </div>
      <div style={{ position: "absolute", left: 64, top: 1480, transform: `translateX(${(1 - springAt(frame, fps, 300)) * -400}px)` }}>
        <div style={{ font: "108px/1 Smiley", color: "#fff", textShadow: "6px 6px 0 #000" }}>{p.brand.name}</div>
        <div style={{ marginTop: 14, font: "700 34px Noto", color: "#B6FF3B", borderLeft: "8px solid #B6FF3B", paddingLeft: 14 }}>{p.brand.line}</div>
      </div>
      {cap ? (
        <div key={cap.start} style={{ position: "absolute", top: 1180, left: 40, right: 40, textAlign: "center",
          transform: `scale(${interpolate(springAt(frame, fps, cap.start, { damping: 14, stiffness: 260 }), [0, 1], [0.86, 1])})` }}>
          {runs(cap, p.keywords).map((r, i) => {
            // Keywords are set larger and grow in from small when said, so they never cover their neighbours.
            const pop = r.key ? interpolate(springAt(frame, fps, r.s, { damping: 9, stiffness: 220 }), [0, 1], [0.55, 1]) : 1;
            return (
              <span key={i} style={{ display: "inline-block", font: `900 ${r.key ? 92 : 78}px Noto`, color: r.key ? "#B6FF3B" : "#fff",
                WebkitTextStroke: "14px #000", paintOrder: "stroke fill", transform: `scale(${pop})`, margin: r.key ? "0 6px" : 0 }}>{r.text}</span>
            );
          })}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

/* 2 黄条干货：斜贴黄色标题条 + 黑底胶囊字幕，关键词黄色荧光笔从左刷出 */
function Notes(p: TemplateProps) {
  const { ms, frame, fps } = useMs();
  const cap = current(p.captions, ms);
  const enter = springAt(frame, fps, 0, { damping: 14, stiffness: 160 });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 170, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ background: "#111", color: "#FFD400", font: "800 38px Noto", padding: "10px 26px", borderRadius: 10,
          transform: `translateY(${(1 - enter) * -80}px)`, letterSpacing: 4 }}>现场实拍 · {p.brand.name}</div>
        <div style={{ marginTop: 22, background: "#FFD400", padding: "18px 40px", transform: `rotate(-2.5deg) scaleX(${enter})`,
          boxShadow: "12px 12px 0 #111" }}>
          {p.title.map((line, i) => (
            <div key={i} style={{ font: "900 74px/1.2 Noto", color: "#111", textAlign: "center" }}>{line}</div>
          ))}
        </div>
      </div>
      {cap ? (
        <div style={{ position: "absolute", top: 1230, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
          <div key={cap.start} style={{ background: "rgba(10,10,10,.82)", borderRadius: 26, padding: "18px 34px",
            transform: `translateY(${(1 - springAt(frame, fps, cap.start, { damping: 16, stiffness: 240 })) * 40}px)` }}>
            {runs(cap, p.keywords).map((r, i) => {
              const wipe = r.key ? interpolate(ms, [r.s, r.s + 260], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
              return (
                <span key={i} style={{ font: "800 66px Noto", color: r.key && wipe > 40 ? "#111" : "#fff", padding: r.key ? "0 8px" : 0,
                  background: r.key ? `linear-gradient(90deg, #FFD400 ${wipe}%, transparent ${wipe}%)` : "none", borderRadius: 8 }}>{r.text}</span>
              );
            })}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

/* 3 电影质感：宋体标题 + 金线，细字幕，关键词金色砸下并轻微震屏 */
function Cinema(p: TemplateProps) {
  const { ms, frame, fps } = useMs();
  const cap = current(p.captions, ms);
  const fade = interpolate(ms, [0, 700], [0, 1], { extrapolateRight: "clamp" });
  const line = interpolate(ms, [300, 1100], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 58%, rgba(0,0,0,.7) 100%)" }} />
      <div style={{ position: "absolute", top: 190, left: 0, right: 0, textAlign: "center", opacity: fade }}>
        <div style={{ font: "600 32px Noto", color: "#E9C46A", letterSpacing: 12 }}>{p.brand.name} · 现场实录</div>
        <div style={{ margin: "26px auto", height: 3, width: 620 * line, background: "#E9C46A" }} />
        {p.title.map((t, i) => (
          <div key={i} style={{ font: `${i ? 64 : 78}px/1.3 SerifHeavy`, color: "#fff", letterSpacing: 4,
            transform: `translateY(${(1 - fade) * 24}px)`, textShadow: "0 4px 24px rgba(0,0,0,.6)" }}>{t}</div>
        ))}
        <div style={{ margin: "26px auto", height: 3, width: 620 * line, background: "#E9C46A" }} />
      </div>
      {cap ? (
        <div style={{ position: "absolute", top: 1330, left: 60, right: 60, textAlign: "center",
          opacity: interpolate(ms, [cap.start, cap.start + 160], [0, 1], { extrapolateRight: "clamp" }) }}>
          {runs(cap, p.keywords).map((r, i) => {
            // Before it is said a keyword reads as plain text; when said it turns gold and slams down.
            const said = r.key && ms >= r.s;
            const hit = said ? springAt(frame, fps, r.s, { damping: 10, stiffness: 300 }) : 1;
            return (
              <span key={i} style={{ display: "inline-block", font: `${said ? 900 : 500} ${said ? 74 : 60}px Noto`,
                color: said ? "#F2B84B" : "#fff", textShadow: "0 3px 14px rgba(0,0,0,.85)",
                transform: `scale(${interpolate(hit, [0, 1], [1.8, 1])})`, margin: said ? "0 6px" : 0 }}>{r.text}</span>
            );
          })}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

/* 4 快讯播报：红色“现场直击”+ 蓝色标题条从左滑入，底部滚动条，白卡字幕关键词标红 */
function News(p: TemplateProps) {
  const { ms, frame, fps } = useMs();
  const cap = current(p.captions, ms);
  const slide = springAt(frame, fps, 0, { damping: 16, stiffness: 150 });
  const ticker = `${p.brand.name} · ${p.brand.line} · `.repeat(6);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 170, left: 0, transform: `translateX(${(1 - slide) * -1100}px)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, background: "#E8262D", color: "#fff", font: "900 40px Noto",
          padding: "10px 28px", width: "fit-content" }}>
          <span style={{ width: 18, height: 18, borderRadius: 9, background: "#fff", opacity: Math.sin(ms / 160) > 0 ? 1 : 0.25 }} />现场直击
        </div>
        <div style={{ background: "linear-gradient(90deg, #1446E0, #2F7BFF)", padding: "20px 60px 20px 34px", marginTop: 0,
          clipPath: "polygon(0 0, 100% 0, 94% 100%, 0 100%)" }}>
          {p.title.map((t, i) => (
            <div key={i} style={{ font: `900 ${i ? 58 : 68}px/1.25 Noto`, color: i ? "#FFE14D" : "#fff" }}>{t}</div>
          ))}
        </div>
      </div>
      {cap ? (
        <div style={{ position: "absolute", top: 1300, left: 50, right: 50, display: "flex", justifyContent: "center" }}>
          <div key={cap.start} style={{ background: "#fff", borderLeft: "14px solid #1446E0", padding: "16px 30px",
            boxShadow: "0 10px 30px rgba(0,0,0,.35)",
            transform: `translateX(${(1 - springAt(frame, fps, cap.start, { damping: 18, stiffness: 260 })) * 60}px)` }}>
            {runs(cap, p.keywords).map((r, i) => (
              <span key={i} style={{ font: "900 62px Noto", color: r.key ? "#E8262D" : "#0D1B3D" }}>{r.text}</span>
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ position: "absolute", top: 1560, left: 0, right: 0, height: 64, background: "rgba(13,27,61,.9)", overflow: "hidden" }}>
        <div style={{ whiteSpace: "nowrap", font: "700 36px/64px Noto", color: "#fff", transform: `translateX(${-(ms / 6) % 1400}px)` }}>{ticker}</div>
      </div>
    </AbsoluteFill>
  );
}

/* 5 荧光弹跳：得意黑大字标题弹入，字幕逐字蹦出，关键词荧光底线画出 */
function Pop(p: TemplateProps) {
  const { ms, frame, fps } = useMs();
  const cap = current(p.captions, ms);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 160, left: 0, right: 0, textAlign: "center" }}>
        {p.title.map((t, i) => {
          const b = springAt(frame, fps, i * 180, { damping: 8, stiffness: 200 });
          return (
            <div key={i} style={{ font: `${i ? 104 : 116}px/1.12 Smiley`, color: i ? "#C6FF00" : "#fff",
              WebkitTextStroke: "16px #111", paintOrder: "stroke fill", transform: `rotate(${i ? 2 : -3}deg) scale(${b})`,
              filter: "drop-shadow(0 10px 0 rgba(0,0,0,.35))" }}>{t}</div>
          );
        })}
      </div>
      {cap ? (
        <div style={{ position: "absolute", top: 1220, left: 40, right: 40, textAlign: "center" }}>
          {runs(cap, p.keywords).map((r, i) => (
            <span key={i} style={{ position: "relative", display: "inline-block", margin: r.key ? "0 8px" : 0 }}>
              {r.chars.map((c, k) => {
                const up = springAt(frame, fps, c.s, { damping: 10, stiffness: 320 });
                return (
                  <span key={k} style={{ display: "inline-block", font: `${r.key ? "92px" : "80px"} Smiley`, color: r.key ? "#C6FF00" : "#fff",
                    WebkitTextStroke: "12px #111", paintOrder: "stroke fill", opacity: up > 0.02 ? 1 : 0,
                    transform: `translateY(${(1 - up) * 50}px) scale(${interpolate(up, [0, 1], [0.6, 1])})` }}>{c.t}</span>
                );
              })}
              {r.key ? (
                <span style={{ position: "absolute", left: 0, bottom: 6, height: 16, borderRadius: 8, background: "#C6FF00", zIndex: -1,
                  width: `${interpolate(ms, [r.s, r.s + 300], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}%` }} />
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

const BY_ID = { live: Live, notes: Notes, cinema: Cinema, news: News, pop: Pop };

export const CaptionTemplate: React.FC<TemplateProps> = (props) => {
  const { ms } = useMs();
  const Overlay = BY_ID[props.template];
  // Cinema shakes the frame for 200 ms when a keyword lands.
  let shake = 0;
  if (props.template === "cinema") {
    for (const c of props.captions) for (const r of runs(c, props.keywords)) if (r.key && ms >= r.s && ms < r.s + 200) shake = 8 * (1 - (ms - r.s) / 200);
  }
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <style>{FONTS}</style>
      <AbsoluteFill style={{ transform: `translate(${shake * Math.sin(ms / 9)}px, ${shake * Math.cos(ms / 11)}px) scale(${shake ? 1.02 : 1})` }}>
        <Footage clip={props.clip} audio={props.audio} />
      </AbsoluteFill>
      <Overlay {...props} />
    </AbsoluteFill>
  );
};
