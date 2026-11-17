/**
 * 站内搜索索引（构建期生成）。
 *
 * 为什么不用 Pagefind / Algolia：
 *   - 站点只有个位数文章、纯静态、零运行期依赖是硬约束；Pagefind 要额外
 *     装二进制并扫 dist，Algolia 要外部服务和额度。
 *   - 中文检索的关键是「不分词也能命中」。本索引把正文压成一段纯文本，
 *     前端做子串匹配 —— 中文没有词边界，子串匹配反而比词典分词稳，
 *     `G1`、`unsafe`、`cpu.max` 这类术语也能原样命中。
 *
 * 体积控制：围栏代码块整体丢弃（占原文近一半且几乎不可读），
 * 图片、链接、Markdown 标记全部剥掉，只留可读文字。
 */
import { getAllPosts, readingMinutes } from './posts';

/**
 * 单篇文档。键名刻意用单字母：索引是首次搜索时的下载内容，
 * 9 篇文章的 `b` 字段就是几万字符，键名省下的字节是白拿的。
 */
export interface SearchDoc {
  /** slug */
  s: string;
  /** 标题 */
  t: string;
  /** 路径 */
  u: string;
  /** 发布日期 YYYY-MM-DD */
  d: string;
  /** 分类 */
  c: string;
  /** 标签 */
  g: string[];
  /** 阅读时长（分钟） */
  m: number;
  /** 摘要 */
  x: string;
  /** 小标题（h2–h4） */
  h: string[];
  /** 正文纯文本 */
  b: string;
}

export interface SearchIndexPayload {
  /** 索引结构版本，前端据此判断兼容性 */
  v: number;
  /** 文档数 */
  n: number;
  docs: SearchDoc[];
}

/** 剥掉行内 Markdown 标记，只留文字（标题与正文共用） */
function inlineText(s: string): string {
  return s
    .replace(/!\[\[[^\]]*\]\]/g, ' ')                    // Obsidian 嵌入 ![[图.png]]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                // 标准图片
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')        // [[note|别名]]
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                   // [[note]]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')              // [文字](链接)
    // 链接文字里可能带标题井号（如 `[# 某工具](url)`），解链之后再剥一次
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, '$1')
    .replace(/`/g, '')                                    // 行内代码反引号
    .replace(/(^|[^\w])[*_]{1,3}(?=\S)/g, '$1')           // 强调起始标记
    .replace(/(\S)[*_]{1,3}(?=[^\w]|$)/g, '$1')           // 强调结束标记
    .replace(/<[^>]+>/g, ' ')                             // 内联 HTML
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文 → 纯文本 */
export function toPlainText(md: string): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, ' ');                  // 围栏代码块（```）
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ');                  // 围栏代码块（~~~）
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');                 // HTML 注释
  s = s.replace(/%%[\s\S]*?%%/g, ' ');                    // Obsidian 注释
  s = s.replace(/^@(?:video|channel)\([^)]*\)[ \t]*$/gm, ' '); // 自定义视频指令
  s = s.replace(/^\s{0,3}#{1,6}[ \t]+/gm, '');            // 标题符号
  s = s.replace(/^\s{0,3}>\s?/gm, '');                    // 引用
  s = s.replace(/^\s*[-*+][ \t]+/gm, '');                 // 无序列表
  s = s.replace(/^\s*\d+\.[ \t]+/gm, '');                 // 有序列表
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ');     // 表格分隔行
  s = s.replace(/\|/g, ' ');                              // 表格竖线
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ');          // 分割线
  return inlineText(s);
}

/** 提取 h2–h4 小标题（h1 是文章标题，不重复收） */
export function toHeadings(md: string): string[] {
  const out: string[] = [];
  const re = /^#{2,4}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const t = inlineText(m[1]);
    // 「参考」「小结」这类泛标题对检索没有区分度，收了只会制造噪音
    if (t && t.length <= 60) out.push(t);
  }
  return out.slice(0, 40);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 报告生成时间：留在产物里，方便线上确认索引是不是这一版构建的 */
export async function buildSearchIndex(): Promise<SearchIndexPayload> {
  const posts = await getAllPosts();

  const docs: SearchDoc[] = posts.map((post) => {
    const { data } = post;
    const d = data.date;
    return {
      s: data.slug,
      t: data.title,
      u: `/posts/${data.slug}/`,
      d: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      c: data.category,
      g: data.tags,
      m: readingMinutes(post),
      x: data.summary,
      h: toHeadings(post.body ?? ''),
      b: toPlainText(post.body ?? ''),
    };
  });

  return { v: 1, n: docs.length, docs };
}
