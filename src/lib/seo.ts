import { SITE, SITE_URL } from './site';
import { readingMinutes, type Post } from './posts';

/**
 * SEO 元信息工具。
 *
 * 硬要求（PRD R-07 / R-26）：
 *  - canonical 自指且去掉查询参数，全站正确率必须 100%（现状为 0%）
 *  - JSON-LD 覆盖 Article / Person / BreadcrumbList / WebSite
 */

export function absoluteUrl(pathname: string): string {
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${SITE_URL}${p}`;
}

/**
 * 生成 canonical。
 * 去掉 query / hash；非文件路径统一补尾斜杠，避免 /posts/x 与 /posts/x/ 产生双份。
 */
export function canonicalFor(pathname: string): string {
  const clean = pathname.split('?')[0].split('#')[0];
  let p = clean.startsWith('/') ? clean : `/${clean}`;
  const last = p.split('/').filter(Boolean).pop() ?? '';
  if (!last.includes('.') && !p.endsWith('/')) p += '/';
  return `${SITE_URL}${p}`;
}

/** 媒体地址归一化（COS + CDN 或本地 /media） */
export function mediaUrl(src?: string): string | undefined {
  if (!src) return undefined;
  if (/^https?:\/\//i.test(src)) return src;
  return absoluteUrl(src);
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export function personJsonLd() {
  const node: Record<string, unknown> = {
    '@type': 'Person',
    '@id': `${SITE_URL}/about/#person`,
    name: SITE.author.name,
    jobTitle: SITE.author.jobTitle,
    description: SITE.author.description,
    url: `${SITE_URL}/about/`,
    knowsAbout: SITE.author.knowsAbout,
  };
  // 站外身份链接清空后就不要输出空的 sameAs —— 抓取端会当成「已声明但无值」
  if (SITE.author.sameAs.length > 0) node.sameAs = SITE.author.sameAs;
  return node;
}

export function websiteJsonLd() {
  return {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: SITE.title,
    description: SITE.author.description,
    inLanguage: 'zh-CN',
    publisher: personJsonLd(),
  };
}

export function breadcrumbJsonLd(items: BreadcrumbItem[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function articleJsonLd(post: Post, path: string) {
  const canonical = canonicalFor(path);
  return {
    '@type': 'Article',
    '@id': `${canonical}#article`,
    headline: post.data.title,
    description: post.data.summary,
    url: canonical,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    datePublished: post.data.date.toISOString(),
    dateModified: (post.data.updated ?? post.data.date).toISOString(),
    inLanguage: 'zh-CN',
    keywords: post.data.tags.join(', '),
    articleSection: post.data.category,
    timeRequired: `PT${readingMinutes(post)}M`,
    image: mediaUrl(post.data.cover) ?? `${SITE_URL}/og-default.svg`,
    author: personJsonLd(),
    publisher: personJsonLd(),
  };
}

/** 组装成 @graph，一个 script 标签承载全部结构化数据 */
export function jsonLdGraph(nodes: Record<string, unknown>[]) {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes,
  };
}
