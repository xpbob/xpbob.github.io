import type { APIRoute } from 'astro';
import { collectUrls, escapeXml, SITEMAP_PAGE_SIZE } from '../lib/sitemap';
import { SITE_URL } from '../lib/site';

/**
 * /sitemap.xml —— sitemap 索引文件（sitemapindex）。
 *
 * 始终输出索引形式，指向 /sitemap-N.xml 分片：
 * 结构在内容量增长时无需改动，robots.txt 与各站长平台只认这一个入口。
 */
export const GET: APIRoute = async () => {
  const urls = await collectUrls();
  const pages = Math.max(1, Math.ceil(urls.length / SITEMAP_PAGE_SIZE));

  const latest = urls.reduce((max, u) => (u.lastmod > max ? u.lastmod : max), '');

  const items = Array.from({ length: pages }, (_, i) => {
    const loc = `${SITE_URL}/sitemap-${i + 1}.xml`;
    return [
      '  <sitemap>',
      `    <loc>${escapeXml(loc)}</loc>`,
      latest ? `    <lastmod>${latest}</lastmod>` : '',
      '  </sitemap>',
    ]
      .filter(Boolean)
      .join('\n');
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
};
