import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import remarkObsidian from './src/plugins/remark-obsidian.mjs';
import remarkVideo from './src/plugins/remark-video.mjs';
import remarkCjkQuotes from './src/plugins/remark-cjk-quotes.mjs';

/**
 * 极简 .env 读取器。
 *
 * 为什么自己读：astro.config.mjs 在 Astro 加载 .env 之前求值，
 * 此处无法用 import.meta.env，也不想为此引入额外依赖。
 * 优先级：真实 process.env  >  .env.production  >  .env
 */
function readEnvFile(file) {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) return {};
  const out = {};
  for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const fileEnv = { ...readEnvFile('.env'), ...readEnvFile('.env.production') };
const env = { ...fileEnv, ...process.env };

/**
 * GitHub Pages 用户页（仓库名 xpbob.github.io）→ 站点根路径就是 `/`，
 * 不需要配 base。若换成项目页（如 /blog），必须同时加 `base`，
 * 否则所有绝对路径资源都会 404。
 */
const SITE_URL = env.SITE_URL || 'https://xpbob.github.io';
// 媒体基址：本地开发指向 public/media，生产指向 COS + CDN
const MEDIA_BASE_URL = env.MEDIA_BASE_URL || '/media';

export default defineConfig({
  site: SITE_URL,

  // URL 一律带尾斜杠：/posts/{slug}/，与 PRD §7 的 URL 结构一致
  trailingSlash: 'always',
  build: { format: 'directory' },

  // 纯静态产出：运行期零常驻，交 Nginx 托管（见 PRD §A 资源预算）
  output: 'static',

  // 静态站不需要开发工具栏，也避免它进产物
  devToolbar: { enabled: false },

  markdown: {
    /**
     * 为什么显式选 unified 处理器，而不用 Astro 7 默认的 Sätteri：
     *
     * Sätteri 内建了 `features.wikilinks`（默认关闭），但它是**纯布尔开关，
     * 无法配置 URL 前缀** —— 生成的链接不匹配本站 `/posts/{slug}/` 结构，
     * 图片也无法映射到 COS/CDN 基址。
     *
     * 因此改用自研 remark 插件（src/plugins/remark-obsidian.mjs）：
     * 可控 postsBase / mediaBase，并与 heading 锚点规则对齐。
     * 代价是走统一的 unified 管线（@astrojs/markdown-remark，
     * Astro 官方保留并长期支持的路径）。
     */
    /**
     * smartypants 关掉（在 unified 的选项里），换自研的 remark-cjk-quotes。
     *
     * smartypants 判断开/闭引号依赖「前一个字符是空白或左括号」，中文没有词间
     * 空格，`你以为"分代"` 的第一个引号会被判成闭引号，渲染出两个右引号。
     * 站点全是中文正文，这个启发式不适用；而它顺带做的 `...` → `…` 在正文里
     * 只有两处，关掉没有损失。
     */
    processor: unified({
      smartypants: false,
      /**
       * 顺序有讲究：remark-video 在前。
       * 它把整段指令替换成 `html` 节点，而 remark-obsidian 的 SKIP_TYPES
       * 里有 `html` —— 反过来的话视频指令会被 wikilink 扫描一遍再处理，
       * 虽然结果一样，但语义上不该给插件碰。
       *
       * 视频号跳转卡的 base 也能用 CHANNEL_BASE_URL 覆盖（比如换短链域名）。
       */
      remarkPlugins: [
        [remarkVideo, { mediaBase: MEDIA_BASE_URL, channelBase: env.CHANNEL_BASE_URL || undefined }],
        [remarkObsidian, { mediaBase: MEDIA_BASE_URL }],
        remarkCjkQuotes,
      ],
    }),
    shikiConfig: {
      theme: 'github-dark',
      wrap: false,
    },
  },

  // 构建期把媒体基址固化为常量，前端不引入运行时依赖
  vite: {
    define: {
      'import.meta.env.PUBLIC_MEDIA_BASE': JSON.stringify(MEDIA_BASE_URL),
    },
  },
});
