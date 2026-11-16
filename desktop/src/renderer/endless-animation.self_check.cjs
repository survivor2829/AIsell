// An endless CSS animation keeps the whole window redrawing at the display rate for as long as it is on
// screen. On a 200% / 120 Hz laptop the login page's loops (pulses, number shine, caret, a drifting blurred
// background) took a third of the graphics card and made the presenter video stutter (user report
// 2026-11-16); three dots in 小玺's transparent window cost a quarter of a CPU core during a task.
// "Still working" cues use the shared heartbeat (beat.ts, html[data-beat]); only the animations below,
// each shown only while something really is loading or being generated, may loop.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_KEYFRAMES = new Set([
  // Spinners and skeletons while loading or generating.
  "auto-mix-resource-spin", "content-spin", "studio-spin", "dh-spin", "product-detail-spin", "vp-spin",
  "finished-skeleton", "ns-shimmer",
  // Progress of a running generation or publish, removed when it ends.
  "rh-speaking", "dist-flowbar", "dist-shimmer",
  // Home portrait breathing: switched on for three breaths by AgentHome, then removed.
  "agent-breathe", "agent-breathe-light",
  // 小玺: the caret exists only while a message types out; the spiral only during the short dizzy act.
  "xiaoxi-caret", "xiaoxi-spin"
]);

const dir = __dirname;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, "");
const offenders = [];
const keyframes = new Set();
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".css"))) {
  const css = stripComments(fs.readFileSync(path.join(dir, file), "utf8"));
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)/gu)) keyframes.add(match[1]);
  for (const match of css.matchAll(/animation(?:-iteration-count)?\s*:\s*([^;}]*)/gu)) {
    const value = match[1];
    if (!/\binfinite\b/u.test(value)) continue;
    // Every comma-separated animation that loops must name an allowed keyframe.
    // Split at top-level commas only: cubic-bezier(0.42, 0, ...) is one value.
    for (const part of value.split(/,(?![^(]*\))/u)) {
      if (!/\binfinite\b/u.test(part)) continue;
      const names = part.trim().split(/\s+/u).filter((token) => keyframes.has(token) || /^[a-z][\w-]*$/u.test(token) && !/^(infinite|linear|ease|ease-in|ease-out|ease-in-out|alternate|alternate-reverse|reverse|normal|forwards|backwards|both|none|paused|running|step-start|step-end)$/u.test(token));
      if (!names.some((name) => ALLOWED_KEYFRAMES.has(name))) offenders.push(`${file}: ${part.trim().slice(0, 100)}`);
    }
  }
}
for (const file of fs.readdirSync(dir).filter((name) => /\.(tsx?|jsx?)$/u.test(name) && !name.endsWith(".self_check.cjs"))) {
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  if (/animation\s*:\s*["'`][^"'`]*\binfinite\b/u.test(source)) offenders.push(`${file}: inline endless animation`);
  if (/iterations\s*:\s*Infinity/u.test(source)) offenders.push(`${file}: element.animate with endless iterations`);
}
assert.deepEqual(offenders, [], "endless animations outside the allowed loading/progress indicators");
for (const name of ALLOWED_KEYFRAMES) assert.ok(keyframes.has(name), `allowed keyframe ${name} still exists (keep the list exact)`);

const login = fs.readFileSync(path.join(dir, "LoginScreen.css"), "utf8");
assert.doesNotMatch(stripComments(login), /backdrop-filter\s*:\s*blur/u, "the login card has no backdrop blur");
assert.doesNotMatch(stripComments(login), /\.signin-aurora\s*\{[^}]*filter\s*:\s*blur/u, "the login background is not blurred");
assert.doesNotMatch(fs.readFileSync(path.join(dir, "XiaoxiSprite.css"), "utf8"), /xiaoxi-dot/u, "小玺's working dots follow the heartbeat");
assert.match(fs.readFileSync(path.join(dir, "main.tsx"), "utf8"), /import "\.\/beat";/u, "every window starts the shared heartbeat");
console.log("endless animation self-check passed");
