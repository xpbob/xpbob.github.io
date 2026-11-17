/**
 * remark-video — 让 Markdown 文章内嵌视频（含视频号引流卡）。
 *
 * 背景（已核实）：
 *   视频号没有对外开放的点播嵌入能力。`https://weixin.qq.com/sph/<id>` 在站外
 *   浏览器里只是一个纯 JS 壳（只渲染出「视频号」三个字），既拿不到 <video>
 *   也拿不到 og 元数据，iframe 还会被 UA/Referer 校验 + X-Frame 拦截。
 *
 *   因此本站只有两条路：
 *     1) 自托管 MP4（作者在「视频号助手 → 内容管理」下载无水印原片）
 *     2) 视频号跳转卡（不在站内播放，只做导流）
 *
 * 语法（必须独占一行，整段只有这一条指令）：
 *
 *   @video(demo.mp4 | Flink TaskManager 内存布局演示 | poster=demo.jpg | duration=02:34 | channel=Am0jhUnNDQ)
 *   @channel(Am0jhUnNDQ | 视频标题 | poster=cover.jpg | duration=01:23)
 *
 *   - 第 1 个位置参数：@video 为视频地址（相对路径自动拼 mediaBase），@channel 为视频号 ID
 *   - 第 2 个位置参数：标题（可省略）
 *   - 其余为 key=value：poster / duration / channel / caption
 *   - 值里要出现 `|` 时用 `\|` 转义
 *
 * 输出为原生 HTML，样式在 src/styles/global.css 的 `.vembed-*` 段落里。
 * 之所以输出 HTML 而不是 AST 节点：Astro 的 scoped style 不会给 Markdown
 * 里的原始 HTML 打 data-astro-cid，走组件反而要额外包一层。
 *
 * 依赖为零：`preload="none"` 本身就是懒加载，不需要任何运行期 JS。
 */

const DEFAULT_CHANNEL_BASE = 'https://weixin.qq.com/sph/';

/** 属性/文本转义。只用到双引号属性值，但文本节点也要一并处理 & < > */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 按未转义的 `|` 切分 */
function splitArgs(raw) {
  const out = [];
  let cur = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && raw[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((s) => s !== '');
}

/** 把 `k=v` 收进对象，其余按顺序作为位置参数 */
function parseArgs(raw) {
  const positional = [];
  const named = {};
  for (const part of splitArgs(raw)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
        named[key] = val;
        continue;
      }
    }
    positional.push(part);
  }
  return { positional, named };
}

const DIRECTIVE_RE = /^@(video|channel)\(([\s\S]*)\)$/;

/**
 * 把 `9:16` 解析成 `9 / 16`，并判断是否竖屏。
 * 视频号内容大量是 9:16 竖屏，硬套 16:9 会把画面拉变形，
 * 所以竖屏要额外加类名收窄宽度，而不是靠 object-fit 硬扛。
 */
function parseRatio(raw) {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(String(raw).trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return { css: `${w} / ${h}`, portrait: h > w };
}

export default function remarkVideo(options = {}) {
  const mediaBase = (options.mediaBase || '/media').replace(/\/+$/, '');
  const channelBase = (options.channelBase || DEFAULT_CHANNEL_BASE).replace(/\/*$/, '/');

  const toMediaUrl = (target) => {
    if (/^https?:\/\//i.test(target) || target.startsWith('//')) return target;
    return `${mediaBase}/${String(target).replace(/^\.?\//, '').replace(/\\/g, '/')}`;
  };

  const toChannelUrl = (id) => {
    if (/^https?:\/\//i.test(id)) return id;
    return `${channelBase}${String(id).replace(/^\/+/, '')}`;
  };

  function renderVideo(args) {
    const [srcRaw, titleRaw] = args.positional;
    if (!srcRaw) return null;
    const src = toMediaUrl(srcRaw);
    const title = titleRaw || '';
    const poster = args.named.poster ? toMediaUrl(args.named.poster) : '';
    const duration = args.named.duration || '';
    const channelId = args.named.channel || '';
    const caption = args.named.caption || title;
    const ratio = parseRatio(args.named.ratio) || { css: '16 / 9', portrait: false };

    // 有 poster 才敢 preload="none"（否则浏览器连首帧都不给，只剩黑框）；
    // 没 poster 时退到 metadata，至少能拿到时长与首帧。
    const preload = poster ? 'none' : 'metadata';
    const posterAttr = poster ? ` poster="${esc(poster)}"` : '';
    const ratioStyle = ` style="aspect-ratio:${ratio.css}"`;

    const channelLink = channelId
      ? `<a class="vembed-jump" href="${esc(toChannelUrl(channelId))}" target="_blank" rel="noopener noreferrer">在视频号观看<span aria-hidden="true">↗</span></a>`
      : '';

    const dur = duration ? `<span class="vembed-dur">${esc(duration)}</span>` : '';
    const head = title
      ? `<div class="vembed-head"><span class="vembed-title">${esc(title)}</span>${dur}${channelLink}</div>`
      : dur || channelLink
        ? `<div class="vembed-head"><span class="vembed-title"></span>${dur}${channelLink}</div>`
        : '';

    const figcaption = caption ? `<figcaption>${esc(caption)}</figcaption>` : '';
    const figClass = ratio.portrait ? 'vembed vembed-portrait' : 'vembed';

    return (
      `<figure class="${figClass}">` +
      head +
      `<div class="vembed-box">` +
      `<video controls playsinline preload="${preload}"${posterAttr}${ratioStyle}` +
      (title ? ` aria-label="${esc(title)}"` : '') +
      `><source src="${esc(src)}" type="video/mp4" />` +
      `<p class="vembed-fallback">你的浏览器不支持内嵌视频，<a href="${esc(src)}">点此直接下载播放</a>。</p>` +
      `</video>` +
      `</div>` +
      figcaption +
      `</figure>`
    );
  }

  function renderChannel(args) {
    const [idRaw, titleRaw] = args.positional;
    if (!idRaw) return null;
    const url = toChannelUrl(idRaw);
    const title = titleRaw || '';
    const poster = args.named.poster ? toMediaUrl(args.named.poster) : '';
    const duration = args.named.duration || '';
    const caption = args.named.caption || '';
    const ratio = parseRatio(args.named.ratio) || { css: '16 / 9', portrait: false };

    // 站外无法播放，只能用封面当诱饵 + 明确提示「请用微信打开」。
    // 单引号包裹 url()，避免 &quot; 被二次转义成 &#x22; 后污染属性。
    // background-image 与 aspect-ratio 必须合并进同一个 style ——
    // 重复的 style 属性会被 HTML 解析器丢掉后一个。
    const bg = poster ? `background-image:url('${String(poster).replace(/'/g, '%27')}');` : '';
    const style = ` style="${bg}aspect-ratio:${ratio.css}"`;
    const dur = duration ? `<span class="vembed-dur">${esc(duration)}</span>` : '';
    const figClass = ratio.portrait ? 'vembed vembed-channel vembed-portrait' : 'vembed vembed-channel';

    return (
      `<figure class="${figClass}">` +
      `<a class="vembed-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer">` +
      `<span class="vembed-poster${poster ? ' has-img' : ''}"${style}>` +
      `<span class="vembed-play" aria-hidden="true"></span>` +
      `</span>` +
      `<span class="vembed-bar">` +
      (title ? `<span class="vembed-title">${esc(title)}</span>` : '') +
      dur +
      `<span class="vembed-hint">请用微信打开</span>` +
      `</span>` +
      `</a>` +
      (caption ? `<figcaption>${esc(caption)}</figcaption>` : '') +
      `</figure>`
    );
  }

  function toHtml(node) {
    if (node.type !== 'paragraph') return null;
    if (!Array.isArray(node.children) || node.children.length !== 1) return null;
    const only = node.children[0];
    if (only.type !== 'text' || typeof only.value !== 'string') return null;

    const m = DIRECTIVE_RE.exec(only.value.trim());
    if (!m) return null;

    const kind = m[1];
    const args = parseArgs(m[2]);
    return kind === 'video' ? renderVideo(args) : renderChannel(args);
  }

  function walk(node) {
    if (!Array.isArray(node.children)) return;
    const next = [];
    for (const child of node.children) {
      const html = toHtml(child);
      if (html) {
        next.push({ type: 'html', value: html });
        continue;
      }
      walk(child);
      next.push(child);
    }
    node.children = next;
  }

  return (tree) => {
    walk(tree);
  };
}
