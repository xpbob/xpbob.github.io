/**
 * 术语 → URL slug 字典。
 *
 * 为什么需要它：PRD 洞察 #9 要求语义化英文 slug，而中文分类/标签名无法
 * 通过字符转换得到可读 slug（「框架与中间件排障」→ 空）。这里显式登记
 * 映射，未登记的词回落到 ASCII 化，仍无法转换时保留原文。
 *
 * 新增中文分类/标签时，务必在此登记，否则 URL 会退化为百分号编码。
 */
const SLUG_MAP: Record<string, string> = {
  // ── 分类 ────────────────────────────────────────────────
  'JVM 内存与 GC': 'jvm-gc',
  'CPU 与采样分析': 'cpu-profiling',
  'eBPF 与系统观测': 'ebpf-system',
  '框架与中间件排障': 'framework-middleware',
  'JDK 新特性': 'jdk-features',
  'JIT 与编译器': 'jit-compiler',

  // ── 标签 ────────────────────────────────────────────────
  JVM: 'jvm',
  G1: 'g1',
  ZGC: 'zgc',
  内存: 'memory',
  GC: 'gc',
  停顿: 'pause',
  JFR: 'jfr',
  采样: 'sampling',
  火焰图: 'flamegraph',
  CPU: 'cpu',
  Flink: 'flink',
  排障: 'troubleshooting',
  eBPF: 'ebpf',
  Linux: 'linux',
  工具链: 'toolchain',
  unsafe: 'unsafe',
  AOT: 'aot',
  'JDK 25': 'jdk25',
  'Spring Boot': 'spring-boot',
  启动优化: 'startup',
  LLVM: 'llvm',
  JIT: 'jit',
  编译器: 'compiler',
  Go: 'go',
  GraalVM: 'graalvm',
  网关: 'gateway',
  性能: 'performance',

  // ── 预留给后续迁移的功能性术语 ──────────────────────────
  异步: 'async',
  线程: 'threads',
  锁: 'locking',
  网络: 'network',
  存储: 'storage',
  调优: 'tuning',
};

/** 中文术语 → URL slug */
export function toSlug(name: string): string {
  const key = name.trim();
  const mapped = SLUG_MAP[key];
  if (mapped) return mapped;

  const ascii = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // 无 ASCII 可转且未登记时保留原文，由 Astro 负责 URL 编码（可构建但不可读）
  return ascii || key;
}
