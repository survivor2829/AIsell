// A friendly round cartoon face, the same for the same seed (2026-11-18 UI redesign: customers see
// people, not lines of text). Used for leads in 精准获客 and for posts in 吐槽中心. Nothing about the
// person is shown: the seed only picks colours and a small accessory.
const PALETTE: [string, string][] = [
  ["#ffd7c2", "#e8794a"], ["#d6ecff", "#3b82f6"], ["#dcf5e5", "#16a34a"],
  ["#fbe1f0", "#db2777"], ["#ece4ff", "#7c3aed"], ["#fff1c7", "#d97706"]
];

function hash(seed: string) {
  let value = 0;
  for (const char of seed) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

export function CartoonAvatar({ seed, size = 48, dim = false, label }: { seed: string; size?: number; dim?: boolean; label?: string }) {
  const value = hash(String(seed || "?"));
  const [background, accent] = PALETTE[value % PALETTE.length];
  const accessory = value % 3;
  return <svg width={size} height={size} viewBox="0 0 48 48" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    style={dim ? { filter: "grayscale(1) opacity(.6)", flex: "none" } : { flex: "none" }}>
    <circle cx="24" cy="24" r="24" fill={background} />
    {accessory === 0 && <path d="M14 18 Q24 6 34 18 Z" fill={accent} />}
    {accessory === 1 && <rect x="15" y="12" width="18" height="5" rx="2.5" fill={accent} />}
    {accessory === 2 && <circle cx="34" cy="14" r="4" fill={accent} />}
    <circle cx="24" cy="27" r="12" fill="#fff" />
    <circle cx="20" cy="26" r="1.8" fill="#1f2937" />
    <circle cx="28" cy="26" r="1.8" fill="#1f2937" />
    <path d="M20.5 31 Q24 33.5 27.5 31" stroke="#1f2937" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <circle cx="17" cy="30" r="1.6" fill={accent} opacity=".35" />
    <circle cx="31" cy="30" r="1.6" fill={accent} opacity=".35" />
  </svg>;
}
