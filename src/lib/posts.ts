import { getCollection, type CollectionEntry } from 'astro:content';
import { TAG_INDEX_THRESHOLD } from './site';
import { toSlug } from './slugs';

export type Post = CollectionEntry<'posts'>;
export { toSlug };

/** 单篇构建内复用，避免重复过滤排序 */
let cache: Post[] | null = null;

/** 已发布文章，按发布时间倒序 */
export async function getAllPosts(): Promise<Post[]> {
  if (cache) return cache;
  const all = await getCollection('posts', ({ data }) => !data.draft);
  cache = all.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  return cache;
}

export async function getPostBySlug(slug: string): Promise<Post | undefined> {
  const posts = await getAllPosts();
  return posts.find((p) => p.data.slug === slug);
}

/** sitemap lastmod 用：优先 updated，回落到 date（保证 100% 有值、且真实） */
export function lastModified(post: Post): Date {
  return post.data.updated ?? post.data.date;
}

/** 中文按 400 字/分、英文按 200 词/分估算；代码块不计入 */
export function readingMinutes(post: Post): number {
  if (post.data.readingMinutes) return post.data.readingMinutes;
  const text = (post.body ?? '').replace(/```[\s\S]*?```/g, ' ');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9_]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 400 + words / 200));
}

export interface TermStat {
  name: string;
  slug: string;
  count: number;
  posts: Post[];
  /** 聚合页是否允许被索引（阈值策略，见 PRD §7） */
  indexable: boolean;
}

function groupBy(posts: Post[], pick: (p: Post) => string[]): TermStat[] {
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    for (const raw of pick(post)) {
      const name = raw.trim();
      if (!name) continue;
      const list = map.get(name) ?? [];
      list.push(post);
      map.set(name, list);
    }
  }
  return [...map.entries()]
    .map(([name, list]) => ({
      name,
      slug: toSlug(name),
      count: list.length,
      posts: list.sort((a, b) => b.data.date.getTime() - a.data.date.getTime()),
      indexable: false, // 下面按类型覆写
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

/**
 * 标签聚合页。
 * 索引策略：默认 noindex,follow；文章数 ≥ TAG_INDEX_THRESHOLD 才转为可索引。
 */
export async function getTags(): Promise<TermStat[]> {
  const posts = await getAllPosts();
  return groupBy(posts, (p) => p.data.tags).map((t) => ({
    ...t,
    indexable: t.count >= TAG_INDEX_THRESHOLD,
  }));
}

/**
 * 分类聚合页。承担「主题落地页」角色，恒定可索引 + 自指 canonical。
 */
export async function getCategories(): Promise<TermStat[]> {
  const posts = await getAllPosts();
  return groupBy(posts, (p) => [p.data.category]).map((c) => ({
    ...c,
    indexable: true,
  }));
}

/** 归档：按年份倒序分组 */
export async function getArchive(): Promise<{ year: number; posts: Post[] }[]> {
  const posts = await getAllPosts();
  const map = new Map<number, Post[]>();
  for (const post of posts) {
    const year = post.data.date.getFullYear();
    map.set(year, [...(map.get(year) ?? []), post]);
  }
  return [...map.entries()]
    .map(([year, list]) => ({ year, posts: list }))
    .sort((a, b) => b.year - a.year);
}

/**
 * 首页「按主题分组的精选长文」。
 * 分组键：series → category，组内 featured 优先、其次按时间倒序。
 */
export async function getSeriesGroups(limitPerGroup = 3): Promise<
  { name: string; posts: Post[] }[]
> {
  const posts = await getAllPosts();
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    const key = (post.data.series || post.data.category).trim();
    map.set(key, [...(map.get(key) ?? []), post]);
  }
  return [...map.entries()]
    .map(([name, list]) => ({
      name,
      posts: [...list]
        .sort((a, b) => {
          if (a.data.featured !== b.data.featured) return a.data.featured ? -1 : 1;
          return b.data.date.getTime() - a.data.date.getTime();
        })
        .slice(0, limitPerGroup),
    }))
    .sort((a, b) => b.posts.length - a.posts.length || a.name.localeCompare(b.name, 'zh'));
}
