import type { APIRoute } from 'astro';
import { buildSearchIndex } from '../lib/search-index';

/**
 * GET /search-index.json —— 站内搜索索引。
 *
 * 构建期生成一个静态文件，前端首次搜索时才 fetch（不占首屏）。
 * 走的还是 location /：nginx 给 `expires -1`，每次带 ETag 回源校验，
 * 发布新版后不会读到旧索引。
 */
export const prerender = true;

export const GET: APIRoute = async () => {
  const index = await buildSearchIndex();
  return new Response(JSON.stringify(index), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
};
