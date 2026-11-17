import { getAllPosts, getCategories, getTags, lastModified } from './posts';
import { canonicalFor } from './seo';

/**
 * sitemap URL 收集。
 *
 * 关键约束（PRD R-25 / R-02）：
 *  - loc 一律用 canonicalFor() 生成，保证 canonical 与 sitemap **完全一致**
 *  - lastmod 取文章真实修改时间（updated ?? date），不得虚报 —— Google 2023 起
 *    明确 lastmod 年份须与实际一致，否则该抓取调度信号失效
 *  - 只收可索引页面：noindex 的标签页、404 一律不进
 */

export interface SitemapUrl {
  loc: string;
  lastmod: string;
}

/** 每片 URL 上限，超过则分片（sitemaps.org 单文件上限 5 万） */
export const SITEMAP_PAGE_SIZE = 5000;

const STATIC_PATHS = ['/', '/posts/', '/categories/', '/tags/', '/archive/', '/about/'];

const iso = (d: Date) => d.toISOString();

export async function collectUrls(): Promise<SitemapUrl[]> {
  const posts = await getAllPosts();
  const categories = await getCategories();
  const tags = await getTags();

  const newest = posts.length
    ? new Date(Math.max(...posts.map((p) => lastModified(p).getTime())))
    : new Date();

  const newestOf = (list: typeof posts) =>
    list.length ? new Date(Math.max(...list.map((p) => lastModified(p).getTime()))) : newest;

  const urls: SitemapUrl[] = [];

  // 1) 静态页：lastmod 取全站最新修改时间
  for (const path of STATIC_PATHS) {
    urls.push({ loc: canonicalFor(path), lastmod: iso(newest) });
  }

  // 2) 正文页：每篇各自的真实修改时间
  for (const post of posts) {
    urls.push({
      loc: canonicalFor(`/posts/${post.data.slug}/`),
      lastmod: iso(lastModified(post)),
    });
  }

  // 3) 分类页：恒定可索引
  for (const c of categories) {
    urls.push({ loc: canonicalFor(`/categories/${c.slug}/`), lastmod: iso(newestOf(c.posts)) });
  }

  // 4) 标签页：仅文章数达阈值的才进 sitemap
  for (const t of tags.filter((x) => x.indexable)) {
    urls.push({ loc: canonicalFor(`/tags/${t.slug}/`), lastmod: iso(newestOf(t.posts)) });
  }

  // 去重（同一 loc 只保留一次，取更新的 lastmod）
  const map = new Map<string, SitemapUrl>();
  for (const u of urls) {
    const prev = map.get(u.loc);
    if (!prev || prev.lastmod < u.lastmod) map.set(u.loc, u);
  }

  return [...map.values()].sort((a, b) => a.loc.localeCompare(b.loc));
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
