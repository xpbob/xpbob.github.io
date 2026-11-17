# xpbob.github.io

xpbob 的技术博客，Astro 静态站，托管在 GitHub Pages。

线上地址：<https://xpbob.github.io>

## 技术栈

- **Astro 7**（`output: 'static'`，纯静态产物，零运行时常驻）
- Markdown 内容源：`src/content/posts/*.md`（Obsidian 导出）
- 自研 remark 插件：`src/plugins/`（Obsidian wikilink、视频号卡片、中文引号）
- 样式：`src/styles/global.css`（火焰暖色令牌）

## 本地开发

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # 产物在 dist/
npm run preview    # 预览构建结果
```

要求 Node >= 22（Astro 7 的硬性要求）。

## 发布流程

push 到 `master` 即自动发布，无需手动构建：

1. GitHub Actions 按 `.github/workflows/deploy.yml` 跑 `npm ci` + `npm run build`
2. `dist/` 作为 artifact 上传
3. `actions/deploy-pages` 发布到 Pages

> 首次使用需在仓库 **Settings → Pages → Build and deployment → Source** 选
> **GitHub Actions**，否则不会触发发布。

## 与旧版站点的差异

本站由原 `xpbob.site`（Astro + Spring Boot + MySQL + nginx）**只迁移了阅读部分**：

| 能力 | 状态 |
|---|---|
| 文章、分类、标签、归档、搜索索引、sitemap、RSS 无关的纯阅读 | ✅ 全部保留 |
| 图片资源 `public/media`（4.4M） | ✅ 随仓库分发 |
| 后台发文 `/admin/`、`/blog-api/` 接口 | ❌ Pages 不能运行后端，已下线 |
| 自建访问统计（sendBeacon → MySQL） | ❌ 已关闭上报，`PUBLIC_TRACK_ENDPOINT` 留空 |
| 日志采集、IP 封禁、限流等 nginx 加固 | ❌ 随服务器一并退役 |

**发文方式**：直接编辑 `src/content/posts/*.md` 并 push，front-matter 契约见
`src/content/config.ts`（title / slug / date / tags / category / summary / draft / cover）。

## 两个容易踩的坑

1. `public/.nojekyll` **不要删** —— GitHub Pages 若走 Jekyll 管线会忽略下划线开头的
   目录，`_astro/` 里的 CSS/JS 会全部 404。
2. 本仓库是**用户页**（仓库名即 `xpbob.github.io`），站点根路径是 `/`。若将来改名为
   项目页（如 `blog`），`astro.config.mjs` 必须同时设 `base: '/blog'`，否则资源路径全错。
