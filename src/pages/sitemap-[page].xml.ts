import type { APIRoute } from 'astro';
import { collectUrls, escapeXml, SITEMAP_PAGE_SIZE } from '../lib/sitemap';

/**
 * /sitemap-{n}.xml —— sitemap 分片。
 * 每片最多 SITEMAP_PAGE_SIZE 条；loc 与 canonical 完全一致（见 lib/sitemap.ts）。
 */
export async function getStaticPaths() {
  const urls = await collectUrls();
  const pages = Math.max(1, Math.ceil(urls.length / SITEMAP_PAGE_SIZE));

  return Array.from({ length: pages }, (_, i) => ({
    params: { page: String(i + 1) },
    props: { chunk: urls.slice(i * SITEMAP_PAGE_SIZE, (i + 1) * SITEMAP_PAGE_SIZE) },
  }));
}

export const GET: APIRoute = ({ props }) => {
  const { chunk } = props as { chunk: { loc: string; lastmod: string }[] };

  const entries = chunk
    .map((u) =>
      [
        '  <url>',
        `    <loc>${escapeXml(u.loc)}</loc>`,
        `    <lastmod>${u.lastmod}</lastmod>`,
        '  </url>',
      ].join('\n'),
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
};
