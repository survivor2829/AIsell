// The company mascot as a living desktop pet (user decisions 2026-11-08): traced from the mascot stickers,
// every part on its own spring so it can look at you, find things to do, react when touched and act out
// the work in progress. Only the window's feet move through the main process.
//
// Low-end computers matter: the frame loop stops whenever nothing is moving, and quiet stretches are the norm.

export type PetWork = "work" | "typing" | "error" | null;
export type PetHooks = {
  walk: (dx: number) => Promise<{ moved?: number } | undefined>;
  stopWalk: () => void;
  say: (text: string, ms: number) => void;
  openMain: () => void;
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

const FIST = `<path class="red" d="M-68 -20C-72 -62 -30 -80 8 -78C52 -76 78 -48 76 -4C74 48 44 76 2 76C-44 76 -66 36 -68 -20Z"/><path class="cr" d="M-30 -72C-34 -52 -32 -40 -26 -30M4 -76C0 -56 2 -42 8 -32M38 -66C34 -50 36 -38 42 -30M-56 10C-32 -10 24 -12 50 8C60 20 50 38 32 34"/>`;
const THUMB = `<path class="red" d="M-22 -40C-30 -76 -18 -104 0 -124C24 -152 84 -146 88 -102C90 -80 78 -62 80 -40Z"/><path class="red" d="M-90 8C-96 -42 -66 -62 -36 -62L46 -62C82 -62 98 -36 98 -2L98 62C98 106 70 128 28 128L-34 128C-74 128 -96 102 -92 62Z"/><path class="cr" d="M-86 0C-44 9 12 9 50 0M-88 36C-44 45 12 45 50 36M-88 72C-44 81 12 81 50 72"/>`;
const OPEN = `<path class="red" d="M-56 66C-74 8 -66 -78 -36 -102C-8 -124 42 -118 56 -80C72 -32 66 32 46 72Z"/><path class="cr" d="M-22 -110C-26 -56 -26 -14 -24 24M16 -112C14 -56 14 -14 14 24"/><path class="red" d="M50 40C82 26 102 4 96 -24C92 -42 70 -38 62 -18C58 -6 54 2 42 8Z"/>`;
let POM = '<circle r="104" fill="#f3ad06"/>';
for (let i = 0; i < 70; i++) {
  const a = i * 2.39996, R = 30 + Math.sqrt(i / 70) * 96 + (i % 5) * 2, q = Math.max(0, R - 44);
  POM += `<line x1="${(Math.cos(a) * q).toFixed(0)}" y1="${(Math.sin(a) * q).toFixed(0)}" x2="${(Math.cos(a + .1) * R).toFixed(0)}" y2="${(Math.sin(a + .1) * R).toFixed(0)}" stroke="${["#e99f00", "#ffc62f", "#ffd867", "#f8b710"][i % 4]}" stroke-width="13" stroke-linecap="round"/>`;
}
const CUP = `<g transform="translate(0 -96)"><path d="M-20 -62c-12-18 12-26 0-44M22 -62c-12-18 12-26 0-44" fill="none" stroke="#c9ced8" stroke-width="9" stroke-linecap="round"/><path class="ink thin" d="M66 -32c44-6 44 50-6 54" fill="none"/><path class="ink thin" d="M-68 -50H70C68 34 36 58 2 58C-34 58 -66 34 -68 -50Z" fill="#fff"/><ellipse cx="1" cy="-46" rx="60" ry="11" fill="#8a4a2e"/><ellipse class="ink thin" cx="0" cy="66" rx="104" ry="17" fill="#fff"/></g>`;
const PHONE = `<g transform="translate(14 -120) rotate(8)"><rect class="ink thin" x="-50" y="-92" width="104" height="186" rx="20" fill="#34363d"/><rect x="-38" y="-78" width="80" height="150" rx="9" fill="#9fd8ff"/><path d="M-22 -44h48M-22 -20h48M-22 4h30" stroke="#fff" stroke-width="12" stroke-linecap="round"/></g>`;
const eyeBall = (x: number) => `<ellipse cx="${x}" cy="490" rx="176" ry="196" fill="#fff" stroke="#d3d3d9" stroke-width="9"/><ellipse cx="${x}" cy="490" rx="150" ry="170" fill="none" stroke="#c6c6cd" stroke-width="6"/>`;
const pupil = (x: number, star = false) => `<ellipse cx="${x}" cy="500" rx="88" ry="118" fill="#3f1b18"/><ellipse cx="${x}" cy="546" rx="62" ry="50" fill="#74352a" opacity=".6"/>` + (star
  ? `<path d="M${x + 28} 400c6 34 14 42 48 48c-34 6-42 14-48 48c-6-34-14-42-48-48c34-6 42-14 48-48Z" fill="#fff"/><path d="M${x - 30} 530c3 15 7 19 22 22c-15 3-19 7-22 22c-3-15-7-19-22-22c15-3 19-7 22-22Z" fill="#fff"/>`
  : `<circle cx="${x + 30}" cy="438" r="31" fill="#fff"/><circle cx="${x - 32}" cy="556" r="12" fill="#fff" opacity=".85"/>`);
const spiral = (x: number) => `<g transform="translate(${x} 490)"><path class="spin dk" d="M0 0c20-22 52 2 36 34c-18 36-82 22-84-30c-2-58 78-92 128-44"/></g>`;
const FOOT = '<path class="red" d="M-78 22C-84 -32 -40 -56 6 -52C60 -50 96 -24 96 22C96 46 -74 48 -78 22Z"/>';
const hands = (extra: string) => `<g data-h="fist">${FIST}</g><g data-h="open" class="off">${OPEN}</g><g data-h="thumb" class="off">${THUMB}</g><g data-prop="pom" class="off">${POM}</g>${extra}`;

const ART = `<svg viewBox="-280 -110 1560 1360" data-mouth="smile" data-eye="normal" aria-hidden="true">
<ellipse id="shadow" cx="500" cy="1222" rx="330" ry="30" fill="#000" opacity=".16"/>
<g id="root">
 <path id="legL0" class="ink" fill="none" style="stroke-width:112"/><path id="legR0" class="ink" fill="none" style="stroke-width:112"/><path id="legL1" fill="none" stroke="#fff" stroke-width="82" stroke-linecap="round"/><path id="legR1" fill="none" stroke="#fff" stroke-width="82" stroke-linecap="round"/>
 <g id="footL">${FOOT}</g><g id="footR">${FOOT}</g>
 <g id="torso"><path class="ink" fill="#e7e7ea" d="M300 800C232 900 216 1040 280 1120C340 1176 660 1176 720 1120C784 1040 768 900 700 800C630 850 370 850 300 800Z"/>
  <path class="gray" d="M372 880C430 906 570 906 628 880M372 880L330 980M628 880L670 980M330 980C396 1090 604 1090 670 980M500 898V940M420 1078L376 1140M580 1078L624 1140"/>
  <rect x="396" y="946" width="208" height="92" rx="16" fill="#e8251c"/><text x="500" y="1012" text-anchor="middle" font-size="62" font-weight="900" fill="#fff">玺联惠</text></g>
 <g id="laptop" class="off"><path class="ink thin" d="M330 1000H670L690 1160H310Z" fill="#b9bdc8"/><rect class="ink thin" x="270" y="1148" width="460" height="42" rx="16" fill="#d5d8e0"/><circle cx="500" cy="1078" r="20" fill="#e8251c"/></g>
 <g id="head">
  <g id="tailG" class="off"><path d="M238 300C176 250 106 214 18 196C38 240 44 268 28 310C104 324 178 330 238 340Z" fill="#dc1f16"/><path d="M242 292C208 226 162 168 90 112C172 116 250 170 284 256Z" fill="#c7180f"/></g>
  <g id="tuft"><path d="M372 158C358 94 424 42 494 26C536 16 566 0 590 -36C588 26 622 68 630 118C634 148 618 164 610 170C536 134 446 136 372 158Z" fill="#f03a1f" stroke="#c52410" stroke-width="10" stroke-linejoin="round"/><path d="M430 124C432 92 468 66 516 56" fill="none" stroke="#ff9a85" stroke-width="15" stroke-linecap="round" opacity=".75"/></g>
  <path class="ink" fill="#fff" d="M500 120C600 120 690 150 748 222C838 252 928 340 928 470C928 580 868 650 790 690C730 760 620 802 500 802C380 802 270 760 210 690C132 650 72 580 72 470C72 340 162 252 252 222C310 150 400 120 500 120Z"/>
  <path d="M120 690C200 770 350 790 500 790C650 790 800 770 880 690C800 740 650 760 500 760C350 760 200 740 120 690Z" fill="#dfdfe5" opacity=".75"/>
  <g id="face">
   <path class="gray wide" d="M118 294C218 236 336 268 420 344L580 344C664 268 782 236 882 294"/>
   <ellipse id="blushL" cx="330" cy="672" rx="50" ry="23" fill="#ffb1bb" opacity=".5"/><ellipse id="blushR" cx="670" cy="672" rx="50" ry="23" fill="#ffb1bb" opacity=".5"/>
   ${eyeBall(258)}${eyeBall(742)}
   <g data-e="normal"><g id="eyesN"><g id="lookN">${pupil(286)}${pupil(714)}</g></g></g>
   <g data-e="star"><g id="lookS">${pupil(286, true)}${pupil(714, true)}</g></g>
   <g data-e="wide"><g id="lookW"><ellipse cx="286" cy="500" rx="46" ry="62" fill="#3f1b18"/><ellipse cx="714" cy="500" rx="46" ry="62" fill="#3f1b18"/><circle cx="302" cy="468" r="17" fill="#fff"/><circle cx="730" cy="468" r="17" fill="#fff"/></g></g>
   <g data-e="happy"><path class="dk bold" d="M170 512Q258 400 346 512M654 512Q742 400 830 512"/></g>
   <g data-e="squeeze"><path class="dk bold" d="M184 428L326 494L184 560M816 428L674 494L816 560"/></g>
   <g data-e="closed"><path class="dk bold" d="M174 480Q258 562 342 480M658 480Q742 562 826 480"/></g>
   <g data-e="worry"><g id="lookR"><ellipse cx="286" cy="510" rx="66" ry="90" fill="#3f1b18"/><ellipse cx="714" cy="510" rx="66" ry="90" fill="#3f1b18"/><circle cx="308" cy="470" r="21" fill="#fff"/><circle cx="736" cy="470" r="21" fill="#fff"/></g><path class="dk" d="M178 336L330 288M822 336L670 288"/></g>
   <g data-e="dizzy">${spiral(258)}${spiral(742)}</g>
   <path class="dk slim" d="M462 592l20 12M538 592l-20 12"/>
   <g data-m="smile"><path class="dk" d="M404 664Q500 740 596 664"/><path class="dk slim" d="M396 654l14 16M604 654l-14 16"/></g>
   <g data-m="open"><path d="M386 640Q500 684 614 640C606 776 394 776 386 640Z" fill="#7e1d16" stroke="#2e2a2c" stroke-width="11" stroke-linejoin="round"/><path d="M428 728C462 690 538 690 572 728C544 764 456 764 428 728Z" fill="#ff8088"/></g>
   <g data-m="big"><path d="M360 628Q500 676 640 628C636 802 364 802 360 628Z" fill="#7e1d16" stroke="#2e2a2c" stroke-width="11" stroke-linejoin="round"/><path d="M412 742C454 696 546 696 588 742C552 786 448 786 412 742Z" fill="#ff8088"/></g>
   <g data-m="o"><ellipse cx="500" cy="690" rx="36" ry="42" fill="#7e1d16" stroke="#2e2a2c" stroke-width="11"/></g>
   <g data-m="wave"><path class="dk" d="M402 690q24-30 49 0t49 0t49 0t49 0"/></g>
   <g data-m="pout"><path class="dk" d="M444 700Q500 664 556 700"/></g>
   <g data-m="smirk"><path class="dk" d="M430 684Q530 730 610 648"/></g>
  </g>
  <g id="band" class="off"><path d="M228 322C330 200 670 200 772 322L788 380C680 300 320 300 212 380Z" fill="#e8251c" stroke="#a51f0d" stroke-width="6"/><text x="500" y="300" text-anchor="middle" font-size="62" font-weight="900" fill="#fff">玺联惠</text></g>
  <g id="shades" class="off"><path d="M46 392C186 368 352 374 470 398C482 514 444 626 298 634C150 642 58 556 46 392ZM954 392C814 368 648 374 530 398C518 514 556 626 702 634C850 642 942 556 954 392ZM462 400H538V442H462Z" fill="#17161a" stroke="#17161a" stroke-width="10" stroke-linejoin="round"/><path d="M112 412L222 412L118 562ZM256 412L336 412L202 602L166 592ZM604 412L714 412L610 562ZM748 412L828 412L694 602L658 592Z" fill="#fff" opacity=".2"/></g>
  <path id="sweat" class="off" d="M880 170Q924 240 880 270Q836 240 880 170Z" fill="#7ccbff" stroke="#3f88bf" stroke-width="6"/>
 </g>
 <path id="armL0" class="ink" fill="none" style="stroke-width:98"/><path id="armR0" class="ink" fill="none" style="stroke-width:98"/><path id="armL1" fill="none" stroke="#fff" stroke-width="68" stroke-linecap="round"/><path id="armR1" fill="none" stroke="#fff" stroke-width="68" stroke-linecap="round"/>
 <g id="handL">${hands("")}</g>
 <g id="handR">${hands(`<g data-prop="cup" class="off">${CUP}</g><g data-prop="phone" class="off">${PHONE}</g>`)}</g>
</g>
<g id="fxLayer"></g>
</svg>`;

const HEART = '<path d="M0 26C-52 -20 -30 -66 0 -38C30 -66 52 -20 0 26Z" fill="#ff5a68"/>';
const BANG = '<text text-anchor="middle" font-size="170" font-weight="900" fill="#e8251c">!</text>';
const ASK = '<text text-anchor="middle" font-size="150" font-weight="900" fill="#4d7fd6">?</text>';
const ZZ = '<text text-anchor="middle" font-size="120" font-weight="900" fill="#8db2ec">Z</text>';
const STAR = '<path d="M0 -50l15 35 35 15-35 15-15 35-15-35-35-15 35-15Z" fill="#ffc52e"/>';
const ANGER = '<path d="M-40 -14h26v-26M14 -40v26h26M40 14h-26v26M-14 40v-26h-26" fill="none" stroke="#e8251c" stroke-width="13" stroke-linecap="round"/>';

const REST = { by: 0, bx: 0, lean: 0, sx: 1, sy: 1, hr: 0, hx: 0, hy: 0, turn: 0, lx: 0, ly: 0, blink: 0, tuft: 0, shade: 0, blush: .5,
  Lx: 206, Ly: 1040, Lr: 0, Lb: -46, Rx: 794, Ry: 1040, Rr: 0, Rb: 46, fLx: 410, fLy: 1190, fRx: 590, fRy: 1190, fLr: 0, fRr: 0 };
type Key = keyof typeof REST;
type Values = Record<Key, number>;
const SPRING: Partial<Record<Key, [number, number]>> = { sx: [340, 15], sy: [340, 15], lx: [420, 30], ly: [420, 30], blink: [900, 46], tuft: [150, 6], by: [210, 17],
  Lx: [210, 18], Ly: [210, 18], Rx: [210, 18], Ry: [210, 18], Lr: [230, 18], Rr: [230, 18], hr: [170, 13], fLx: [420, 28], fLy: [420, 28], fRx: [420, 28], fRy: [420, 28], shade: [160, 17] };
const KEYS = Object.keys(REST) as Key[];
const SHOULDER_L: [number, number] = [300, 882], SHOULDER_R: [number, number] = [700, 882], HIP_L: [number, number] = [410, 1110], HIP_R: [number, number] = [590, 1110];
const limb = (a: [number, number], b: [number, number], bend: number) => {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], k = bend / (Math.hypot(dx, dy) || 1);
  return `M${a[0]} ${a[1]}Q${(mx - dy * k).toFixed(1)} ${(my + dx * k).toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
};
// Metres of the prototype: a 340px pet. The jump height scales with the real size.
const AIR_REFERENCE = 340;
const SLEEP_AFTER_MS = 120_000;
const IDLE_ACTIONS: [string, number][] = [["look", 4], ["tea", 3], ["stretch", 2], ["yawn", 2], ["scratch", 2], ["wave", 2], ["dance", 1.5], ["cool", 1.5], ["phone", 2.5], ["sneeze", 1], ["walk", 4], ["sit", 2], ["butterfly", 1.2], ["trip", .7], ["flip", .8]];
type Wait = (ms: number) => Promise<void>;
type Action = (w: Wait) => Promise<void>;

export function createMascotPet(host: HTMLElement, hooks: PetHooks) {
  host.innerHTML = ART;
  const svg = host.querySelector("svg") as SVGSVGElement;
  const el = (id: string) => svg.querySelector("#" + id) as SVGGraphicsElement;
  const E = Object.fromEntries(["root", "head", "tuft", "face", "lookN", "lookS", "lookW", "lookR", "eyesN", "legL0", "legL1", "legR0", "legR1", "footL", "footR", "armL0", "armL1", "armR0", "armR1", "handL", "handR", "shadow", "fxLayer", "band", "shades", "sweat", "tailG", "laptop", "blushL", "blushR"].map((id) => [id, el(id)])) as Record<string, SVGGraphicsElement>;
  const S: Values = { ...REST }, T: Values = { ...REST }, V = Object.fromEntries(KEYS.map((k) => [k, 0])) as Values;

  let air = 0, vy = 0, facing = 1, walking = false, walkPhase = 0, track = true, asleep = false, dragging = false, destroyed = false;
  let token = 0, busy = false, currentName = "", work: PetWork = null, worked = false;
  let raf = 0, last = 0, awakeUntil = 0, lastDraw = 0, fps = 30, idleTimer = 0, blinkTimer = 0, sleepTimer = 0, lastIdle = "", clock = 0, lastCursorAt = performance.now();
  const timers = new Set<number>();

  function render() {
    host.style.transform = `translateY(${(-air * host.clientWidth / AIR_REFERENCE).toFixed(1)}px)`;
    E.root.setAttribute("transform", `translate(${S.bx.toFixed(1)} ${S.by.toFixed(1)}) rotate(${S.lean.toFixed(2)} 500 1215) translate(500 1215) scale(${S.sx.toFixed(3)} ${S.sy.toFixed(3)}) translate(-500 -1215)`);
    E.shadow.setAttribute("opacity", clamp(.18 - air / 900, .04, .18).toFixed(3));
    E.shadow.setAttribute("transform", `translate(500 1222) scale(${clamp(1 - air / 700, .45, 1).toFixed(3)}) translate(-500 -1222)`);
    E.head.setAttribute("transform", `translate(${S.hx.toFixed(1)} ${S.hy.toFixed(1)}) rotate(${S.hr.toFixed(2)} 500 800)`);
    E.tuft.setAttribute("transform", `rotate(${S.tuft.toFixed(2)} 500 160)`);
    E.face.setAttribute("transform", `translate(${(S.turn * 34).toFixed(1)} 0)`);
    const look = `translate(${S.lx.toFixed(1)} ${S.ly.toFixed(1)})`;
    for (const key of ["lookN", "lookS", "lookW", "lookR"]) E[key].setAttribute("transform", look);
    E.eyesN.setAttribute("transform", `translate(0 500) scale(1 ${clamp(1 - S.blink, .04, 1).toFixed(3)}) translate(0 -500)`);
    E.blushL.setAttribute("opacity", S.blush.toFixed(2)); E.blushR.setAttribute("opacity", S.blush.toFixed(2));
    E.shades.setAttribute("transform", `translate(0 ${((1 - S.shade) * -520).toFixed(1)})`);
    const armL = limb(SHOULDER_L, [S.Lx, S.Ly], S.Lb), armR = limb(SHOULDER_R, [S.Rx, S.Ry], S.Rb);
    E.armL0.setAttribute("d", armL); E.armL1.setAttribute("d", armL); E.armR0.setAttribute("d", armR); E.armR1.setAttribute("d", armR);
    E.handL.setAttribute("transform", `translate(${S.Lx.toFixed(1)} ${S.Ly.toFixed(1)}) rotate(${S.Lr.toFixed(1)})`);
    E.handR.setAttribute("transform", `translate(${S.Rx.toFixed(1)} ${S.Ry.toFixed(1)}) rotate(${S.Rr.toFixed(1)}) scale(-1 1)`);
    const legL = limb(HIP_L, [S.fLx, S.fLy - 34], -12), legR = limb(HIP_R, [S.fRx, S.fRy - 34], 12);
    E.legL0.setAttribute("d", legL); E.legL1.setAttribute("d", legL); E.legR0.setAttribute("d", legR); E.legR1.setAttribute("d", legR);
    E.footL.setAttribute("transform", `translate(${S.fLx.toFixed(1)} ${S.fLy.toFixed(1)}) rotate(${S.fLr.toFixed(1)}) scale(-1 1)`);
    E.footR.setAttribute("transform", `translate(${S.fRx.toFixed(1)} ${S.fRy.toFixed(1)}) rotate(${S.fRr.toFixed(1)})`);
  }

  function step(dt: number) {
    clock += dt;
    if (walking) {
      walkPhase += dt * 8.4;
      const s = Math.sin(walkPhase), c = Math.cos(walkPhase), d = facing;
      Object.assign(T, { fLx: 410 + d * 72 * s, fLy: 1190 - Math.max(0, c) * 46, fRx: 590 - d * 72 * s, fRy: 1190 - Math.max(0, -c) * 46, fLr: d * 10 * c, fRr: -d * 10 * c,
        by: -Math.abs(s) * 14, hr: d * 2 + Math.sin(walkPhase * .5) * 1.8, lean: d * 1.8, Lx: 206 + d * 48 * s, Ly: 1040 - Math.max(0, -s) * 24, Rx: 794 - d * 48 * s, Ry: 1040 - Math.max(0, s) * 24 });
    }
    if (!dragging && (air > 0 || vy !== 0)) {
      vy -= 2400 * dt; air += vy * dt;
      if (air <= 0) {
        const impact = -vy; air = 0;
        V.sy -= Math.min(9, impact / 190); V.sx += Math.min(7, impact / 260); V.tuft += rnd(-160, 160);
        vy = impact > 520 ? impact * .34 : 0;
      }
    }
    let energy = 0;
    for (const key of KEYS) {
      const [k, c] = SPRING[key] || [170, 16];
      V[key] += ((T[key] - S[key]) * k - V[key] * c) * dt;
      S[key] += V[key] * dt;
      energy += Math.abs(V[key]) + Math.abs(T[key] - S[key]);
    }
    return energy;
  }
  function frame(now: number) {
    raf = 0;
    if (destroyed) return;
    if (now - lastDraw < 1000 / fps - 2) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(.05, (now - last) / 1000); last = now; lastDraw = now;
    const energy = step(dt);
    render();
    if (energy > .35 || now < awakeUntil || air > 0 || vy !== 0 || walking || dragging) raf = requestAnimationFrame(frame);
  }
  function wake(ms = 900) {
    const now = performance.now();
    awakeUntil = Math.max(awakeUntil, now + ms);
    if (!raf && !destroyed) { last = Math.max(last, now - 33); raf = requestAnimationFrame(frame); }
  }
  const go = (values: Partial<Values>) => { Object.assign(T, values); wake(); };
  const face = (eye?: string, mouth?: string) => { if (eye) svg.dataset.eye = eye; if (mouth) svg.dataset.mouth = mouth; };
  const hand = (side: "L" | "R", kind: string) => E[side === "L" ? "handL" : "handR"].querySelectorAll<SVGGElement>("[data-h]").forEach((g) => g.classList.toggle("off", g.dataset.h !== kind));
  const prop = (side: "L" | "R", name: string, on: boolean) => E[side === "L" ? "handL" : "handR"].querySelector(`[data-prop=${name}]`)?.classList.toggle("off", !on);
  const show = (key: string, on: boolean) => E[key].classList.toggle("off", !on);
  const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms); timers.add(id); return id; };
  function fx(markup: string, x: number, y: number, dx = 0) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${x} ${y})`); g.innerHTML = `<g class="fx" style="--dx:${dx}px">${markup}</g>`;
    E.fxLayer.append(g); later(() => g.remove(), 1300);
  }
  function confetti() {
    const colours = ["#e8251c", "#ffc52e", "#4d7fd6", "#31b36b", "#ff8fa3"];
    for (let i = 0; i < 26; i++) {
      const piece = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      piece.setAttribute("x", String(500 + rnd(-40, 40))); piece.setAttribute("y", "240"); piece.setAttribute("width", String(rnd(18, 32))); piece.setAttribute("height", String(rnd(30, 52)));
      piece.setAttribute("fill", pick(colours)); piece.setAttribute("class", "cf");
      piece.style.cssText = `--dx:${rnd(-560, 560)}px;--dy:${rnd(-200, 760)}px;--r:${rnd(-540, 540)}deg;animation-delay:${rnd(0, .16)}s`;
      E.fxLayer.append(piece); later(() => piece.remove(), 1800);
    }
  }
  const pop = (a = 1) => { V.sy -= 2.6 * a; V.sx += 1.9 * a; V.tuft += rnd(-90, 90) * a; wake(); };
  const hop = (speed = 420) => { vy = speed; air = Math.max(air, .1); wake(); };
  const talk = (text: string, ms = 1900) => hooks.say(text, ms);
  const restPose = () => go({ Lx: 206, Ly: 1040, Lr: 0, Lb: -46, Rx: 794, Ry: 1040, Rr: 0, Rb: 46, by: 0, bx: 0, lean: 0, sx: 1, sy: 1, hr: 0, hx: 0, hy: 0, fLx: 410, fLy: 1190, fRx: 590, fRy: 1190, fLr: 0, fRr: 0, shade: 0, blush: .5, blink: 0, turn: 0 });
  function resetLook() {
    face("normal", "smile"); hand("L", "fist"); hand("R", "fist");
    for (const key of ["band", "shades", "sweat", "tailG", "laptop"]) show(key, false);
    prop("L", "pom", false); prop("R", "pom", false); prop("R", "cup", false); prop("R", "phone", false);
  }

  async function play(name: string, action: Action, followCursor: boolean) {
    const mine = ++token;
    window.clearTimeout(idleTimer);
    currentName = name; busy = true;
    if (walking) { walking = false; hooks.stopWalk(); }
    const wait: Wait = (ms) => new Promise((ok, no) => later(() => (mine === token ? ok() : no(0)), ms));
    resetLook(); restPose(); track = followCursor;
    try {
      await action(wait);
      if (mine !== token) return;
      resetLook(); restPose(); track = true; busy = false; currentName = "";
      carryOn();
    } catch { /* A newer action took over. */ }
  }
  function carryOn() { if (work) startWork(); else scheduleIdle(); }

  const hoverFollow = new Set(["wave", "salute", "work", "done", "error", "cool", "scratch", "dance", "sit", "walk", "typing"]);
  const A: Record<string, Action> = {
    async wave(w) { face("normal", "open"); hand("R", "open"); talk(pick(["嗨～", "你好呀！", "我在这儿呢～"])); pop(); for (let i = 0; i < 5; i++) { go({ Rx: 945 + (i % 2) * 62, Ry: 560, Rr: i % 2 ? 18 : -16, Rb: 170, hr: i % 2 ? 3 : -3 }); await w(230); } },
    async salute(w) { hand("L", "open"); go({ Lx: 118, Ly: 330, Lr: 24, Lb: -430, hr: -4 }); pop(); await w(420); go({ by: -14, sy: 1.03 }); await w(900); go({ by: 0, sy: 1 }); },
    async tea(w) { prop("R", "cup", true); go({ Rx: 800, Ry: 950, Rr: 0, Rb: 60 }); await w(800); track = false; go({ Rx: 640, Ry: 800, Rr: -16, hr: 6, lx: -30, ly: 18 }); face("closed", "o"); await w(900); go({ hr: 8 }); await w(500); fx(HEART, 700, 300, 40); face("happy", "smile"); go({ Rx: 800, Ry: 950, Rr: 0, hr: 2, blush: .9 }); talk(pick(["这杯茶不错～", "辛苦了，喝口茶～", "记得喝水呀～"])); await w(1400); },
    async stretch(w) { track = false; hand("L", "open"); hand("R", "open"); face("closed", "big"); go({ Lx: 300, Ly: -20, Lr: -8, Lb: -560, Rx: 700, Ry: -20, Rr: 8, Rb: 560, sy: 1.09, sx: .95, by: -22 }); await w(1200); go({ Lr: -16, Rr: 16, lean: 3 }); await w(420); go({ lean: -3 }); await w(420); go({ lean: 0 }); face("happy", "smile"); restPose(); pop(); await w(700); },
    async yawn(w) { track = false; face("closed", "big"); hand("L", "open"); go({ Lx: 430, Ly: 760, Lr: 40, Lb: -70, hr: -3, sy: 1.03 }); await w(1200); pop(.5); face("closed", "smile"); restPose(); await w(650); },
    async dance(w) { face("happy", "big"); talk("♪ 嘿嘿 ♪", 2400); for (let i = 0; i < 8; i++) { const s = i % 2 ? 1 : -1; go({ bx: s * 44, lean: s * 6, hr: -s * 7, Lx: s > 0 ? 60 : 206, Ly: s > 0 ? 640 : 1000, Lb: s > 0 ? -170 : -46, Rx: s > 0 ? 794 : 940, Ry: s > 0 ? 1000 : 640, Rb: s > 0 ? 46 : 170, fLy: s > 0 ? 1150 : 1190, fRy: s > 0 ? 1190 : 1150 }); pop(.45); await w(300); } go({ bx: 0 }); },
    async cool(w) { show("shades", true); T.shade = 0; S.shade = 0; go({ shade: 1 }); face("normal", "smirk"); await w(260); pop(); go({ Lx: 40, Ly: 690, Lr: -8, Lb: -250, Rx: 960, Ry: 690, Rr: 8, Rb: 250, hr: -3 }); fx(STAR, 930, 160, 30); talk("帅呆了！"); for (let i = 0; i < 4; i++) { go({ sx: 1.03, sy: .985 }); await w(320); go({ sx: 1, sy: 1 }); await w(320); } go({ shade: 0 }); await w(420); },
    async phone(w) { track = false; prop("R", "phone", true); go({ Rx: 690, Ry: 960, Rr: -6, Rb: 100, hr: 4, lx: 40, ly: 60, hy: 12 }); await w(1400); fx(ASK, 820, 240, 20); go({ hr: 8 }); await w(900); face("happy", "smile"); await w(900); },
    async scratch(w) { face("normal", "wave"); hand("R", "open"); go({ Rx: 770, Ry: 190, Rr: -30, Rb: 600, hr: 6 }); fx(ASK, 800, 130, 20); for (let i = 0; i < 6; i++) { go({ Rx: 770 + (i % 2 ? 30 : -22), Ry: 190 + (i % 2 ? -18 : 14) }); await w(180); } },
    async sneeze(w) { track = false; face("closed", "o"); go({ hr: -8, hy: -14, sy: 1.04, lean: -3 }); await w(800); face("squeeze", "big"); talk("阿——嚏！"); go({ hr: 12, hy: 20, sy: .93, lean: 4 }); V.tuft += 240; fx(STAR, 500, 720, -40); await w(420); face("normal", "wave"); go({ hr: 0, hy: 0, sy: 1, lean: 0 }); await w(900); },
    async walk(w) {
      const distance = pick([-1, 1]) * rnd(90, 240);
      facing = Math.sign(distance); go({ turn: facing }); walking = true; wake();
      const result = await Promise.race([hooks.walk(distance), w(6000).then(() => undefined)]);
      walking = false; hooks.stopWalk(); restPose();
      if (result && !result.moved) { fx(ASK, 780, 220, 10); }
      await w(380);
    },
    async trip(w) {
      facing = pick([-1, 1]); go({ turn: facing }); walking = true; wake();
      await Promise.race([hooks.walk(facing * 60), w(1100).then(() => undefined)]); await w(100).catch(() => { throw 0; });
      walking = false; hooks.stopWalk(); face("wide", "o"); talk("哎！");
      go({ lean: facing * 26, Lx: facing > 0 ? 290 : 206, Rx: facing > 0 ? 794 : 710, by: 30, hr: facing * 14 }); pop(1.2); V.tuft += 200; await w(380);
      go({ lean: facing * 74, by: 110, hr: facing * 6, Lx: 520 + facing * 260, Ly: 1120, Rx: 480 + facing * 260, Ry: 1130 }); await w(800);
      fx(STAR, 500 + facing * 320, 860, 20); fx(STAR, 500 + facing * 420, 830, -20); face("dizzy", "wave"); await w(1300);
      face("squeeze", "wave"); restPose(); go({ turn: 0, lean: -facing * 4 }); await w(560); go({ lean: 0 }); face("normal", "smile"); talk("没人看见吧…"); go({ lx: -46 }); await w(450); go({ lx: 46 }); await w(1100);
    },
    async sit(w) { go({ by: 112, sy: .96, fLx: 330, fLy: 1150, fRx: 670, fRy: 1150, fLr: -24, fRr: 24, Lx: 236, Ly: 1080, Rx: 764, Ry: 1080 }); await w(500); for (let i = 0; i < 8; i++) { go({ fLy: 1118 + (i % 2) * 46, fRy: 1164 - (i % 2) * 46, hr: i % 2 ? 2 : -2 }); await w(340); } },
    async butterfly(w) {
      track = false; face("star", "open"); talk("蝴蝶！");
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.innerHTML = '<path d="M0 0C-70 -86 -116 -20 -52 16C-96 58 -30 80 0 22C30 80 96 58 52 16C116 -20 70 -86 0 0Z" fill="#ffb02e" stroke="#2e2a2c" stroke-width="7"/><path d="M0 -24V36" stroke="#2e2a2c" stroke-width="10" stroke-linecap="round"/>';
      E.fxLayer.append(g);
      let on = true, t = 0, bx = 0, by = 320;
      const fly = () => {
        if (!on || destroyed) return;
        t += .05; bx = 500 + Math.sin(t * .9) * 640; by = 300 + Math.sin(t * 2.1) * 130;
        g.setAttribute("transform", `translate(${bx.toFixed(0)} ${by.toFixed(0)}) scale(${(.72 + Math.sin(t * 14) * .28).toFixed(2)} .9)`);
        T.lx = clamp((bx - 500) / 9, -52, 52); T.ly = clamp((by - 470) / 9, -30, 30); T.hr = clamp((bx - 500) / 70, -11, 11); wake(120);
        requestAnimationFrame(fly);
      };
      fly();
      try {
        await w(1500); hand("L", "open"); hand("R", "open");
        for (let i = 0; i < 3; i++) { go({ Lx: clamp(bx - 60, -100, 600), Ly: clamp(by, 60, 600), Rx: clamp(bx + 60, 400, 1100), Ry: clamp(by, 60, 600), Lb: -260, Rb: 260, sy: 1.08 }); hop(640); await w(780); restPose(); await w(420); }
        face("normal", "pout"); talk("又飞走了…"); await w(1200);
      } finally { on = false; g.remove(); }
    },
    async done(w) { face("star", "big"); hand("L", "thumb"); hand("R", "thumb"); go({ Lx: 118, Ly: 900, Lr: -15, Lb: -70, Rx: 882, Ry: 900, Rr: 15, Rb: 70, blush: .9 }); hop(760); V.tuft += 220; confetti(); await w(1000); for (let i = 0; i < 4; i++) { go({ Ly: 870, Ry: 870, hr: i % 2 ? 3 : -3 }); await w(240); go({ Ly: 925, Ry: 925 }); await w(240); } },
    async oops(w) { face("worry", "wave"); show("sweat", true); go({ Lx: 240, Ly: 770, Lr: 14, Lb: -110, Rx: 760, Ry: 770, Rr: -14, Rb: 110, sx: .98, hr: -2 }); for (let i = 0; i < 12; i++) { go({ bx: (i % 2 ? 1 : -1) * 7, hr: i % 2 ? 2 : -2 }); await w(120); } go({ bx: 0 }); await w(400); },
    async poke(w) { face("wide", "o"); V.tuft += rnd(150, 240) * pick([-1, 1]); fx(BANG, 840, 190, 30); hop(520); go({ sx: .95, sy: 1.06, Lx: 90, Ly: 690, Lb: -180, Rx: 910, Ry: 690, Rb: 180 }); talk(pick(["哎呀！", "吓我一跳！", "干嘛戳我～", "嘿！"])); await w(600); restPose(); face("normal", "smile"); await w(650); },
    async giggle(w) { face("happy", "big"); go({ blush: 1, Lx: 370, Ly: 1030, Lb: -20, Rx: 630, Ry: 1030, Rb: 20 }); talk(pick(["哈哈哈好痒！", "不要挠胸牌～"])); for (let i = 0; i < 10; i++) { go({ bx: (i % 2 ? 1 : -1) * 11, sy: i % 2 ? .97 : 1.02 }); await w(100); } go({ bx: 0, sy: 1 }); },
    async annoyed(w) { face("squeeze", "pout"); go({ Lx: 320, Ly: 980, Lb: -160, Rx: 680, Ry: 980, Rb: 160, lean: -4, hr: -10, blush: 1 }); fx(ANGER, 830, 210, 20); talk("别戳啦！"); await w(900); go({ lean: 4, hr: 10 }); await w(900); face("normal", "pout"); await w(700); },
    async flip(w) {
      face("star", "big"); go({ sy: .82, sx: 1.12 }); await w(260); go({ sy: 1, sx: 1 }); hop(1000);
      const start = performance.now();
      const spin = () => { const p = (performance.now() - start) / 860; if (p < 1 && !destroyed) { S.lean = T.lean = p * 360; V.lean = 0; wake(120); requestAnimationFrame(spin); } else { S.lean = T.lean = 0; } };
      spin(); await w(1100); face("happy", "open"); fx(STAR, 300, 220, -60); fx(STAR, 720, 190, 60); await w(800);
    },
    async petted(w) { track = false; face("happy", "smile"); talk(pick(["好舒服～", "再摸摸～", "嘿嘿～"])); go({ blush: 1, sy: .985 }); for (let i = 0; i < 24 && petting(); i++) { go({ hr: Math.sin(i * .8) * 7, hy: 8 }); if (i % 4 === 0) fx(HEART, rnd(300, 720), 240, rnd(-50, 50)); await w(170); } },
    async sleepy(w) { track = false; asleep = true; face("closed", "o"); go({ by: 112, sy: .96, fLx: 330, fLy: 1150, fRx: 670, fRy: 1150, fLr: -24, fRr: 24, Lx: 236, Ly: 1080, Rx: 764, Ry: 1080, hr: 7, hy: 24 }); for (;;) { fx(ZZ, 780, 260, 60); go({ hy: 30, hr: 9 }); await w(1900); go({ hy: 18, hr: 5 }); await w(1900); } },
    async wake(w) { asleep = false; face("wide", "o"); pop(1.2); hop(420); await w(420); face("happy", "big"); hand("R", "open"); talk(pick(["你回来啦！", "我刚刚没睡！", "想我了吗～"])); for (let i = 0; i < 4; i++) { go({ Rx: 945 + (i % 2) * 62, Ry: 560, Rr: i % 2 ? 18 : -16, Rb: 170 }); await w(220); } },
    async dizzy(w) { face("dizzy", "wave"); V.tuft += 240; talk("晕…晕了…"); for (let i = 0; i < 24; i++) { go({ lean: Math.sin(i * .55) * 8, hr: Math.sin(i * .55 + 1) * 9, bx: Math.sin(i * .55) * 18 }); await w(90); } go({ lean: 0, hr: 0, bx: 0 }); },
    async look(w) { track = false; go({ lx: -46, hr: -6, turn: -.6 }); await w(800); go({ lx: 46, hr: 6, turn: .6 }); await w(800); go({ lx: 0, hr: 0, turn: 0 }); fx(ASK, 780, 220, 10); await w(500); },
    // The work acts run in bursts: a task can last all night and this must not cost a CPU core.
    async workLoop(w) {
      if (!worked) { worked = true; await A.salute(w); }
      show("band", true); show("tailG", true); prop("L", "pom", true); prop("R", "pom", true); face("squeeze", "open");
      for (;;) {
        for (let i = 0; i < 14; i++) { const s = i % 2; go({ Lx: -60 + s * 36, Ly: 720 - s * 96, Rx: 1060 - (1 - s) * 36, Ry: 720 - (1 - s) * 96, Lb: -120, Rb: 120, hr: s ? -3 : 3, sy: s ? 1.04 : .97 }); if (i % 2 === 0) hop(250); await w(290); }
        go({ Lx: 60, Ly: 860, Rx: 940, Ry: 860, hr: 0, sy: 1 }); face("normal", "open"); await w(rnd(7000, 11000)); face("squeeze", "open");
      }
    },
    async typingLoop(w) {
      show("laptop", true); face("normal", "smile"); track = false;
      for (;;) {
        go({ lx: 0, ly: 58, hy: 12, Lx: 384, Ly: 1106, Lr: 58, Lb: -30, Rx: 616, Ry: 1106, Rr: -58, Rb: 30 });
        for (let i = 0; i < 26; i++) { go({ Ly: 1106 - (i % 2) * 26, Ry: 1106 - ((i + 1) % 2) * 26 }); await w(150); }
        go({ Ly: 1106, Ry: 1106, ly: 8, hy: 4 }); await w(rnd(7000, 11000));
      }
    },
    async errorLoop(w) {
      face("worry", "wave"); show("sweat", true); go({ Lx: 240, Ly: 770, Lr: 14, Lb: -110, Rx: 760, Ry: 770, Rr: -14, Rb: 110, sx: .98, hr: -2 });
      for (;;) { for (let i = 0; i < 16; i++) { go({ bx: (i % 2 ? 1 : -1) * 7, hr: i % 2 ? 2 : -2 }); await w(120); } go({ bx: 0, hr: -2 }); await w(rnd(6000, 9000)); }
    }
  };
  const act = (name: string) => { asleep = name === "sleepy"; fps = ["sleepy", "workLoop", "typingLoop", "errorLoop"].includes(name) ? 30 : 60; return play(name, A[name], hoverFollow.has(name)); };

  function startWork() { act(work === "typing" ? "typingLoop" : work === "error" ? "errorLoop" : "workLoop"); }
  function scheduleIdle() {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (busy || dragging || work || destroyed) return;
      const pool = IDLE_ACTIONS.filter(([name]) => name !== lastIdle);
      let roll = Math.random() * pool.reduce((sum, item) => sum + item[1], 0), chosen = pool[0][0];
      for (const [name, weight] of pool) { roll -= weight; if (roll <= 0) { chosen = name; break; } }
      lastIdle = chosen; act(chosen);
    }, rnd(6000, 16000));
  }
  function blinkLoop() {
    blinkTimer = window.setTimeout(() => {
      if (svg.dataset.eye === "normal" && !asleep) { go({ blink: 1 }); later(() => go({ blink: 0 }), 95); if (Math.random() < .22) later(() => { go({ blink: 1 }); later(() => go({ blink: 0 }), 85); }, 260); }
      blinkLoop();
    }, rnd(2000, 6000));
  }
  function sleepCheck() {
    sleepTimer = window.setTimeout(() => {
      if (!asleep && !work && !dragging && performance.now() - lastCursorAt > SLEEP_AFTER_MS) act("sleepy");
      sleepCheck();
    }, 5000);
  }

  const toSvg = (clientX: number, clientY: number) => {
    const box = svg.getBoundingClientRect(), scale = 1560 / (box.width || 1);
    return { x: (clientX - box.left) * scale - 280, y: (clientY - box.top) * scale - 110 };
  };
  let lastCursor = { x: -1, y: -1 }, overHead = false, lastPetAt = 0, petDistance = 0, lastPoint: { x: number; y: number } | null = null;
  const petting = () => overHead && performance.now() - lastPetAt < 420;
  let clicks: number[] = [], shakes = 0, lastShake = 0;

  resetLook(); render(); blinkLoop(); sleepCheck(); later(() => { if (!busy && !work) act("wave"); }, 900);

  return {
    setWork(next: PetWork) {
      if (next === work) return;
      work = next;
      if (!next) { worked = false; if (!dragging) { token++; busy = false; resetLook(); restPose(); track = true; scheduleIdle(); } return; }
      if (!dragging && !["poke", "giggle", "annoyed", "petted", "dizzy"].includes(currentName)) startWork();
    },
    celebrate() { if (!dragging) act("done"); },
    oops() { if (!dragging && !work) act("oops"); },
    cursor(x: number, y: number) {
      if (Math.abs(x - lastCursor.x) + Math.abs(y - lastCursor.y) < 3) return;
      lastCursor = { x, y }; lastCursorAt = performance.now();
      if (asleep && !dragging) { act("wake"); return; }
      if (destroyed || !track || dragging) return;
      const p = toSvg(x, y);
      // Far-away movement changes nothing it would notice, so the loop can stay stopped.
      if (Math.abs(p.x - 500) > 6500) return;
      go({ lx: clamp((p.x - 500) / 10, -54, 54), ly: clamp((p.y - 480) / 12, -34, 34), hr: clamp((p.x - 500) / 120, -7, 7), turn: clamp((p.x - 500) / 900, -.8, .8) });
    },
    hover(clientX: number, clientY: number) {
      const p = toSvg(clientX, clientY), now = performance.now(), head = p.x > 90 && p.x < 910 && p.y > 110 && p.y < 800;
      overHead = head;
      if (head && !dragging) {
        if (lastPoint) { petDistance += Math.hypot(p.x - lastPoint.x, p.y - lastPoint.y); lastPetAt = now; if (petDistance > 1500 && currentName !== "petted") { petDistance = 0; act("petted"); } }
        lastPoint = p;
      } else { lastPoint = null; petDistance = Math.max(0, petDistance - 40); }
    },
    leave() { overHead = false; lastPoint = null; },
    dragMove(vx: number, vy2: number) {
      if (!dragging) {
        dragging = true; token++; busy = true; window.clearTimeout(idleTimer); if (walking) { walking = false; hooks.stopWalk(); }
        resetLook(); track = false; asleep = false; shakes = 0; lastShake = 0; face("wide", "o"); talk(pick(["放我下来！", "哇啊啊——", "要掉啦！"]));
      }
      if (Math.abs(vx) > 500) { const sign = Math.sign(vx); if (sign !== lastShake) { shakes++; lastShake = sign; } }
      const sw = clamp(vx * .2, -180, 180), sv = clamp(vy2 * .2, -140, 140);
      go({ lean: clamp(-vx * .04, -22, 22), sy: 1.05, sx: .97, Lb: -80, Rb: 80, Lx: 150 - sw * .6, Ly: 900 - sv, Rx: 850 - sw * .6, Ry: 900 - sv, Lr: sw * .2, Rr: sw * .2, fLx: 430 - sw * .8, fLy: 1230 - sv * .4, fRx: 570 - sw * .8, fRy: 1230 - sv * .4, hr: -sw * .06 });
      V.tuft += vx * .05;
    },
    dragEnd(impact: number) {
      dragging = false; busy = false; restPose();
      V.sy -= Math.min(9, impact / 190); V.sx += Math.min(7, impact / 260); V.tuft += 200; wake();
      if (impact > 520) { vy = impact * .3; air = .1; }
      if (shakes >= 5) act("dizzy"); else if (work) startWork(); else act(pick(["look", "scratch"]));
    },
    click(clientX: number, clientY: number) {
      const now = performance.now(), p = toSvg(clientX, clientY);
      clicks = clicks.filter((time) => now - time < 2400); clicks.push(now);
      if (clicks.filter((time) => now - time < 360).length >= 2) { clicks = []; pop(); hooks.openMain(); return; }
      if (clicks.length >= 3) { clicks = []; act("annoyed"); return; }
      act(p.y > 920 && p.y < 1060 && p.x > 380 && p.x < 620 ? "giggle" : "poke");
    },
    destroy() {
      destroyed = true; token++; if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(idleTimer); window.clearTimeout(blinkTimer); window.clearTimeout(sleepTimer);
      timers.forEach((id) => window.clearTimeout(id)); timers.clear();
      if (walking) hooks.stopWalk();
      host.innerHTML = "";
    }
  };
}
