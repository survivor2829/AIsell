// Advertising-law hints for narration copy. They only point at wording the user may
// want to change; nothing here blocks confirmation or rewrites the text.
export type AdLawTermKind = "absolute" | "promise";
export type AdLawSentence = { sentence: string; start: number; terms: { term: string; kind: AdLawTermKind }[] };

// The keys of product-detail _EXTREME_WORD_MAP (app.py) and further absolute wording.
export const ABSOLUTE_TERMS: readonly string[] = [
  "最强", "最大", "最小", "最好", "最高", "最低", "最快", "最优", "最先进", "最专业", "最安全",
  "最耐用", "最便捷", "最智能", "最环保", "最轻", "最省", "第一", "唯一", "极致", "顶级", "顶尖",
  "行业领先", "业界领先", "全球领先", "国内领先", "世界领先", "国际领先", "无与伦比",
  "最佳", "全网第一", "首个", "首选", "国家级", "世界级", "史上", "绝对", "100%", "100％", "万能", "永久", "根治"
];
// Promises of a result, listed apart from absolute wording.
export const PROMISE_TERMS: readonly string[] = ["包过", "包会", "保证", "确保"];

const SENTENCE = /[^。！？!?；;\n]+[。！？!?；;]*/gu;

/** Sentences of `text` that contain listed wording, in order, with the words each contains. */
export function adLawSentences(text: string): AdLawSentence[] {
  const terms = [
    ...ABSOLUTE_TERMS.map((term) => ({ term, kind: "absolute" as const })),
    ...PROMISE_TERMS.map((term) => ({ term, kind: "promise" as const }))
  ].sort((left, right) => right.term.length - left.term.length);
  const found: AdLawSentence[] = [];
  for (const match of String(text || "").matchAll(SENTENCE)) {
    const sentence = match[0];
    // A longer term covers the shorter one inside it: 全网第一 is not also listed as 第一.
    const covered: [number, number][] = [];
    const hits: { term: string; kind: AdLawTermKind; at: number }[] = [];
    for (const { term, kind } of terms) {
      for (let at = sentence.indexOf(term); at >= 0; at = sentence.indexOf(term, at + term.length)) {
        if (covered.some(([start, end]) => at < end && start < at + term.length)) continue;
        covered.push([at, at + term.length]);
        if (!hits.some((hit) => hit.term === term)) hits.push({ term, kind, at });
      }
    }
    if (!hits.length) continue;
    const lead = sentence.length - sentence.trimStart().length;
    found.push({ sentence: sentence.trim(), start: (match.index ?? 0) + lead,
      terms: hits.sort((left, right) => left.at - right.at).map(({ term, kind }) => ({ term, kind })) });
  }
  return found;
}
