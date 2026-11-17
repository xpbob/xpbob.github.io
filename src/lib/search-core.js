/**
 * 站内搜索的纯逻辑（无 DOM、无依赖）。
 *
 * 单独成文件的两个原因：
 *   1. 组件里的 <script> 只负责渲染，匹配规则可以脱离浏览器用 Node 跑断言；
 *   2. 中文不分词 —— 查询串按空白切成词，在字段里做子串匹配。词典分词
 *      对 `G1`、`unsafe`、`cpu.max` 这类术语只会帮倒忙。
 */

/** 查询串 → 词数组（最多 6 个，去重） */
export function splitTerms(q) {
  const out = [];
  q.toLowerCase()
    .split(/[\s,，、;；|]+/)
    .forEach((t) => {
      const v = t.trim();
      if (v && !out.includes(v)) out.push(v);
    });
  return out.slice(0, 6);
}

/** 出现次数（上限 40，避免长文把分数拉爆） */
export function countIn(hay, term) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(term, i)) >= 0) {
    n++;
    if (n >= 40) break;
    i += term.length;
  }
  return n;
}

/**
 * 单篇打分。
 * strict=true 表示 AND：任一词没命中就淘汰；false 表示 OR 兜底。
 * 权重按「这个字段有多能代表主题」排：标题 42 > 分类 16 ≈ 标签 14 > 摘要 10 > 小标题 9 > 正文 5。
 */
export function evaluate(doc, terms, strict) {
  const title = (doc.t || '').toLowerCase();
  const cat = (doc.c || '').toLowerCase();
  const tags = (doc.g || []).join(' ').toLowerCase();
  const heads = (doc.h || []).join(' \u0001 ').toLowerCase();
  const sum = (doc.x || '').toLowerCase();
  const body = (doc.b || '').toLowerCase();

  let score = 0;
  let matched = 0;
  let pos = -1;

  for (const term of terms) {
    let hit = false;

    let n = countIn(title, term);
    if (n) {
      score += 42 + Math.min(n - 1, 4) * 8;
      hit = true;
      if (title === term) score += 70;
      else if (title.indexOf(term) === 0) score += 18;
    }

    if (cat.indexOf(term) >= 0) { score += 16; hit = true; }
    if (tags.indexOf(term) >= 0) { score += 14; hit = true; }
    if (sum.indexOf(term) >= 0) { score += 10; hit = true; }
    if (heads.indexOf(term) >= 0) { score += 9; hit = true; }

    n = countIn(body, term);
    if (n) {
      score += 5 + Math.min(n, 8);
      hit = true;
      if (pos < 0) pos = body.indexOf(term);
    }

    if (!hit) {
      if (strict) return null;
    } else {
      matched++;
    }
  }

  if (!matched) return null;

  // 多词查询：命中比例参与缩放，全中的再加一点
  score *= matched / terms.length;
  if (matched === terms.length) score += 12;

  return { doc, score, pos, matched };
}

/** 全库检索：先 AND，全空再退化为 OR */
export function search(docs, q, maxItems = 12) {
  const terms = splitTerms(q);
  if (!terms.length) return null;

  const strict = [];
  const loose = [];

  for (const doc of docs || []) {
    const hit = evaluate(doc, terms, true);
    if (hit) {
      strict.push(hit);
      continue;
    }
    const partial = evaluate(doc, terms, false);
    if (partial) loose.push(partial);
  }

  const items = strict.length ? strict : loose;
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.doc.d < b.doc.d ? 1 : -1; // 同分按发布时间倒序
  });

  return { items: items.slice(0, maxItems), terms, loose: strict.length === 0 };
}

/** 取命中位置附近的一段正文，避免出现「都从头开始」的假摘要 */
export function snippetOf(doc, hit) {
  const inBody = hit && hit.pos >= 0 && doc.b;
  const text = inBody ? doc.b : doc.x || '';
  if (!text) return null;

  const pos = inBody ? hit.pos : 0;
  let start = Math.max(0, pos - 34);
  const end = Math.min(text.length, start + 120);

  // 不要从拉丁单词/数字中间切开
  while (
    start > 0 &&
    /[A-Za-z0-9]/.test(text.charAt(start)) &&
    /[A-Za-z0-9]/.test(text.charAt(start - 1))
  ) {
    start--;
  }

  return { text: text.slice(start, end), lead: start > 0, tail: end < text.length };
}

/** 所有命中区间（合并重叠），供高亮使用：[start, end][] */
export function mergeMatchRanges(text, terms) {
  const low = text.toLowerCase();
  const ranges = [];

  for (const t of terms) {
    let i = 0;
    while ((i = low.indexOf(t, i)) >= 0) {
      ranges.push([i, i + t.length]);
      i += t.length;
    }
  }

  if (ranges.length < 2) return ranges;

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      if (r[1] > last[1]) last[1] = r[1];
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}
