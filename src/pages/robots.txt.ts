import type { APIRoute } from 'astro';
import { SITE_URL } from '../lib/site';

/**
 * /robots.txt
 *
 * 说明：不 Disallow 标签页等 noindex 内容 —— 它们用 `<meta name="robots" content="noindex, follow">`
 * 表达（见 tags/[slug].astro）。用 robots.txt 屏蔽会导致爬虫无法读到 noindex 指令，
 * 反而可能因外部链接被收录成"无描述"结果。
 */
export const GET: APIRoute = () => {
  const body = `# robots.txt · ${SITE_URL}
User-agent: *
Allow: /

# 本站为纯静态托管（GitHub Pages），无后台、无接口，
# 因此不再 Disallow /admin/ 与 /blog-api/ —— 这些路径已不存在。

# 站点地图（索引文件，指向分片）
Sitemap: ${SITE_URL}/sitemap.xml
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
