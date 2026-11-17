/**
 * 站点级配置与常量。
 *
 * 站点 URL 来自 astro.config.mjs 的 `site`（可被 .env 的 SITE_URL 覆盖），
 * 这里统一出口，避免各页面各写一份。
 */

export const SITE_URL = (import.meta.env.SITE || 'https://xpbob.github.io').replace(/\/+$/, '');
export const SITE = {
  url: SITE_URL,
  title: 'xpbob.site',
  /** 作者实体：文章页 JSON-LD 的 Person，也是信任信号展示源 */
  author: {
    name: 'xpbob',
    jobTitle: 'OpenJDK Author',
    /** 身份由 jobTitle 表达，这里只写做了什么，不在简介里重复一遍头衔 */
    description:
      '专注线上疑难问题诊断：JVM 内存与 GC、CPU 高频与采样分析、eBPF 系统级观测。',
    knowsAbout: [
      'JVM 内存模型',
      'GC 日志分析',
      'eBPF',
      'JFR (Java Flight Recorder)',
      'perf',
      '火焰图',
      'Linux 性能诊断',
      'Flink',
    ],
    /**
     * OpenJDK Census 署名页（社区作者名册，公开可核验）。
     *
     * pxie 在名册里登记为 JDK Project 与 JDK Updates Project 的 Author ——
     * 这正是 jobTitle 「OpenJDK Author」的出处，所以作者卡与关于页都把
     * 这个头衔链到这里，访客点一下就能自己核对，不用信我们自称。
     */
    census: 'https://openjdk.org/census#pxie',
    /**
     * 外部身份链接（B 站等可公开抓取的主页）。
     *
     * 与下面的 CONTACT 分开：sameAs 只放**可被搜索引擎识别为同一实体**的
     * 主页链接（会写进 Person JSON-LD），公众号二维码进不去这里 ——
     * 二维码不是 URL，塞进去只会污染结构化数据。
     */
    sameAs: [
      'https://openjdk.org/census#pxie',
      'https://space.bilibili.com/67838579',
    ] as string[],
  },
  /**
   * 首页 Hero 的信任信号不在这里 —— 全部构建期从内容集合算（文章数、分类数），
   * 写死的静态项会随发文过时，也容易变成自我宣称。见 pages/index.astro。
   */
  nav: [
    { label: '文章', href: '/posts/' },
    { label: '分类', href: '/categories/' },
    { label: '标签', href: '/tags/' },
    { label: '归档', href: '/archive/' },
    { label: '关于', href: '/about/' },
  ],
} as const;

/**
 * 首页作者名片的联系方式。
 *
 * 三块都可为空：任一块留空时对应 UI 整体不渲染 —— 不留空壳、不破图。
 * 所以没配二维码之前站点也是正常的，配好即出现。
 *
 * 二维码图片直接放 `web/public/media/` 下，路径以 `/` 开头。
 */
export const CONTACT = {
  wechat: {
    /** 公众号名称；用于「微信搜一搜」文字引导，也是二维码缺失时的降级文案 */
    name: '肥宅英短',
    /**
     * 二维码图片路径。取自公众号后台「搜一搜推广物料」，
     * 用画布左上角的黑白码本身裁出（含 4 模块静默区），不是整张宣传图 ——
     * 整图是 1710×624 的横幅，塞进 88px 的方框里什么都看不清。
     */
    qr: '/media/wechat-qr.png',
    /** 二维码旁边的一句话，说清关注能得到什么 */
    desc: '每周一篇线上排障实录',
  },
  bilibili: {
    /** 入口文案 */
    label: 'B 站 · 排障实录视频',
    /** 主页或合集链接；留空则整块不渲染 */
    href: 'https://space.bilibili.com/67838579',
    /** 副标题 */
    desc: '把排查过程录成能跟着做的视频',
  },
} as const;

/**
 * 聚合页索引策略阈值（PRD §7 量化版）。
 * 标签页默认 noindex,follow；文章数 ≥ 该阈值时自动转为可索引。
 */
export const TAG_INDEX_THRESHOLD = 5;

/**
 * 埋点上报地址。留空 = 关闭埋点。
 *
 * 原实现默认 `/blog-api/track`，由 nginx 反代到 Spring Boot。GitHub Pages
 * 是纯静态托管，没有这个端点，请求只会换回一个 404 —— 所以此处不再兜底，
 * 宁可不上报，也不要在每个页面上打一条失败请求。
 *
 * 若将来接入第三方统计（Umami / Plausible 等），在此填完整 URL 即可，
 * 事件结构（pageview / read_30s / read_75）无需改动。
 */
export const TRACK_ENDPOINT = import.meta.env.PUBLIC_TRACK_ENDPOINT || '';

/** 媒体基址（COS + CDN 或本地 /media） */
export const MEDIA_BASE = (import.meta.env.PUBLIC_MEDIA_BASE || '/media').replace(/\/+$/, '');
