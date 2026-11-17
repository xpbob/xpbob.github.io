import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 文章集合。
 *
 * 开发期与兜底：读本地 src/content/posts/*.md（Obsidian 导出的 Markdown）。
 * 后端就绪后：把 CONTENT_SOURCE 切到 api，由构建时从 Spring Boot 拉取
 *            （见 src/lib/posts.ts 的 source 分支），集合 schema 保持一致。
 *
 * front-matter 契约（与 PRD §F 一致）：
 *   title / slug / date / tags / category / summary / draft / cover
 */
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    /** 文章标题 */
    title: z.string(),
    /** 语义化 URL slug（kebab-case）。与旧拼音 slug 的映射见 post_slug_alias 表 */
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 必须是 kebab-case'),
    /** 首次发布时间 */
    date: z.coerce.date(),
    /** 最近修改时间。sitemap lastmod 取此值，缺省回落到 date（R-25 lastmod 准确性） */
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    category: z.string(),
    summary: z.string(),
    draft: z.boolean().default(false),
    /** 封面图，相对 mediaBase 或完整 URL */
    cover: z.string().optional(),
    /** 系列名，用于首页分组（缺省回落到 category） */
    series: z.string().optional(),
    /** 是否进首页精选 */
    featured: z.boolean().default(false),
    /** 人工标注的阅读时长（分钟）；不填则自动估算 */
    readingMinutes: z.number().int().positive().optional(),
  }),
});

export const collections = { posts };
