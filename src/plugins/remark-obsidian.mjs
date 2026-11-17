/**
 * remark-obsidian — 让 Astro 的 Markdown 管线支持 Obsidian 语法。
 *
 * 背景（已核实）：Astro 的 Markdown 解析器是 remark，遵循 CommonMark 规范，
 * **不原生支持 wikilink**。要让 Obsidian 笔记直接发布，必须挂 remark 插件。
 *
 * 支持语法：
 *   ![[img.png]]               → 图片
 *   ![[dir/img.png|替代文字]]   → 图片（带 alt）
 *   [[post-slug]]              → 站内文章链接
 *   [[post-slug|显示文字]]      → 站内文章链接（自定义文本）
 *   [[post-slug#三级标题]]      → 带锚点
 *
 * 不处理 code / inlineCode / html 节点内的内容 —— 那里出现 [[ ]] 应当原样保留。
 */

/** GitHub 风格 heading 锚点（与 rehype-slug 行为一致） */
function slugifyHeading(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function basename(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

const SKIP_TYPES = new Set(['code', 'inlineCode', 'html', 'yaml', 'toml']);

export default function remarkObsidian(options = {}) {
  const mediaBase = (options.mediaBase || '/media').replace(/\/+$/, '');
  const postsBase = (options.postsBase || '/posts').replace(/\/+$/, '');
  const resolveMedia = typeof options.resolveMedia === 'function' ? options.resolveMedia : null;
  const resolvePost = typeof options.resolvePost === 'function' ? options.resolvePost : null;

  const RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

  const toMediaUrl = (target) => {
    if (/^https?:\/\//i.test(target)) return target;
    const resolved = resolveMedia ? resolveMedia(target) : null;
    if (resolved) return resolved;
    return `${mediaBase}/${String(target).replace(/^\.?\//, '').replace(/\\/g, '/')}`;
  };

  const toPostUrl = (target) => {
    const slug = resolvePost ? resolvePost(target) : target;
    return `${postsBase}/${String(slug).replace(/^\/+|\/+$/g, '')}/`;
  };

  /** 把一段 text 值切成 [text|image|link] 节点数组 */
  function transform(value) {
    const nodes = [];
    let cursor = 0;
    let m;
    RE.lastIndex = 0;

    while ((m = RE.exec(value)) !== null) {
      const [raw, bang, inner] = m;
      if (m.index > cursor) {
        nodes.push({ type: 'text', value: value.slice(cursor, m.index) });
      }

      const [targetRaw, labelRaw] = inner.split('|');
      const target = (targetRaw || '').trim();
      const label = (labelRaw || '').trim();

      if (!target) {
        // 空目标，原样保留
        nodes.push({ type: 'text', value: raw });
      } else if (bang === '!') {
        nodes.push({
          type: 'image',
          url: toMediaUrl(target),
          alt: label || basename(target),
          title: null,
        });
      } else {
        const hashIdx = target.indexOf('#');
        const pathPart = hashIdx === -1 ? target : target.slice(0, hashIdx);
        const hashPart = hashIdx === -1 ? '' : target.slice(hashIdx + 1);
        const url = toPostUrl(pathPart) + (hashPart ? `#${slugifyHeading(hashPart)}` : '');
        nodes.push({
          type: 'link',
          url,
          title: null,
          children: [{ type: 'text', value: label || pathPart }],
        });
      }

      cursor = m.index + raw.length;
    }

    if (cursor < value.length) {
      nodes.push({ type: 'text', value: value.slice(cursor) });
    }
    return nodes.length ? nodes : [{ type: 'text', value }];
  }

  function walk(node) {
    if (!node || !Array.isArray(node.children)) return;
    const next = [];
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('[[')) {
        next.push(...transform(child.value));
        continue;
      }
      if (!SKIP_TYPES.has(child.type)) walk(child);
      next.push(child);
    }
    node.children = next;
  }

  return (tree) => {
    walk(tree);
  };
}
