---
title: "JDK 8 升 25，代码一行不改，性能能翻几倍？"
slug: jdk8-to-25-performance
date: 2026-11-15
category: "JDK 新特性"
tags:
  - "JDK 25"
  - "JVM"
  - "性能"
summary: "不改代码、不重编译、不调参数，JDK 8u502 → 25.0.4 的 36 项实测：SHA-256 快 9.38 倍、Arrays.sort(int[]) 快 4 倍、字符串拼接快 2 倍，4 项被 JIT 直接消零；开 UseCompactObjectHeaders 后内存密集场景再快 8%~118%。逐项追到 JEP 280/254/348/519。"
---

> 实测 36 项基准测试，逐项追到 JEP/Bug 根因

---

最近看到 Vvauban 的博客用 SPECjbb2015 测出 JDK 25 相比 JDK 8 的 **critical jOPS +113%**，相比 JDK 21 也有 **+10%**（原文：https://blog.vvauban.com/blog/java-25-big-drop-in-performance-wins  ）。
critical jOPS 是什么？就是"响应时间达标前提下能扛多少请求"——比单纯吞吐更贴近生产。

这个数据很好，但有个问题：**原文只给了总成绩，没拆解到底是哪些特性。** 

直接从jdk 8 升级到 jdk25 风险太大了。我动手做了评测。在一台 2 核 x86_64 的 OpenCloudOS 机器上，用 JDK 8u502 vs JDK 25.0.4，跑了两套基准测试，覆盖 **36 个场景**。然后逐项追到了背后的 JEP 和 Bug 号。

*测试环境：OpenCloudOS 9.2, x86_64, 2 core, JDK 8u502 / 17.0.12 / 25.0.4, 堆 1G*
*数据仅供参考，不同硬件/负载/配置下结果会不同*

---

## 一、核心结论

> **换运行时是最省力的性能优化。** 不重编译、不改代码、不调参数，JDK 8 → 25 就有 1.2x ~ 9.4x 的场景级加速。开启 `-XX:+UseCompactObjectHeaders` 后，内存密集场景再额外 +8% ~ +118%。

不是某个单项特别猛其他就一般，是**多个方向叠加**：字符串、数学 intrinsic、排序算法、GC 效率、JIT 逃逸分析、对象头压缩，每个方向推一点，加起来就真的能看出来。

---

## 二、实测数据一览

两套测试：**JavaBench**（16 项微基准）+ **RenaBench**（20 项综合负载），堆 1G，预热 3 轮，测量 5 轮取平均。

### 加速最猛的 6 项

| 测试项 | JDK 8 | JDK 25 | JDK 25+COH | 加速比 |
|--------|-------|--------|------------|--------|
| SHA-256 摘要 | 2938ms | 314ms | 313ms | **9.38x** |
| Arrays.sort(int[]) | 568ms | 142ms | 142ms | **4.00x** |
| Math 内置函数 | 1130ms | 391ms | 391ms | **2.89x** |
| 深对象树构建 | 20ms | 24ms | 11ms | **1.82x** |
| StringBuilder 拼接 | 863ms | 396ms | — | **2.18x** |
| String 拼接 | 778ms | 392ms | — | **1.98x** |

*SHA-256 的 9.4x 主要来自 8→17 的 intrinsic 升级；17→25 基本持平*

### 稳步提升的 8 项

| 测试项 | JDK 8 | JDK 25+COH | 加速比 |
|--------|-------|------------|--------|
| 双精度算术 | 341ms | 166ms | **2.05x** |
| Regex 匹配 | 52ms | 36ms | **1.44x** |
| HashMap Put | 250ms | 160ms | **1.56x** |
| HashMap Get | 55ms | 42ms | **1.30x** |
| ConcurrentMap Get | 48ms | 38ms | **1.27x** |
| 序列化往返 | 147ms | 120ms | **1.23x** |
| LRU 缓存模拟 | — | — | **1.30x** |
| 并发队列吞吐 | — | — | **1.38x** |

### JIT 逃逸分析质变：4 项直接归零

| 测试项 | JDK 8 | JDK 25 | 说明 |
|--------|-------|--------|------|
| ObjectAlloc | 3ms | **0ms** | new Object() 不逃逸 → 栈分配消除 |
| SmallObjAlloc | 3ms | **0ms** | new int[4] 不逃逸 → 栈分配消除 |
| SynchronizedBlock | 3ms | **0ms** | 锁对象不逃逸 → 锁消除 |
| StringParseInt | 139ms | **0ms** | 常量输入 → intrinsic + 常量折叠 |

不是"快了一点"，是 **JIT 直接把代码消了**。当然生产环境里不容易写出这么理想的测试用例。

---

## 三、拆解提升来源

每个加速比背后都有**具体的 JEP 或 Bug Fix**，不是"整体快了一点"。按影响力度排序：

### 1. 字符串拼接翻倍 `[JEP 280]` `[JEP 254]`

**JEP 280: invokedynamic 字符串拼接（JDK 9）**

把 `"a" + i + "b"` 从编译期生成 StringBuilder append 链，改为 `invokedynamic` 调用 `StringConcatFactory`。运行时可以选择不同拼接策略（StringBuilder / StringConcat / MethodHandle），JIT 有更大的内联和优化空间。

**JEP 254: Compact Strings（JDK 9）**

String 内部从 `char[]`（每字符 2 字节）改为 `byte[]` + coder（每字符 1 字节 for Latin-1）。纯 ASCII 场景内存减半，cache 命中率翻倍，GC 扫描量减半。

**实测效果**：StringConcat 1.98x，StringBuilderConcat 2.18x，StringBuilderStress 2.21x（+COH）。只要你的服务里有字符串操作，都能享受到性能提升。

### 2. 数学 intrinsic 大幅扩展 `[JEP 348]`

JDK 8 的 C2 只认少量 Math 方法（sin/cos/sqrt 的基本 intrinsic）。JDK 9~11 持续扩展：log、exp、pow、tan 等都被 C2 识别为 intrinsic，不再走 Java 层方法调用。JDK 14 的 JEP 348 又增强了循环自动向量化（SuperWord），SIMD 匹配更多模式。

**实测效果**：MathBuiltin 2.89x，DoubleArithmetic 2.05x。特别适合你的应用做数值计算（量化、风控、推荐）。

### 3. 排序算法升级

JDK 14 加入 heapsort 兜底，保证最坏 O(n log n) 复杂度。加上 JDK 9~25 间 C2 编译器持续内联优化，排序 hot path 越来越快。

**实测效果**：Arrays.sort(int[]) 4.0x。注意：Integer[] 排序走 TimSort（要求稳定），提升不大甚至略退。

### 4. SHA/加密 intrinsic

JDK 9+ 逐步给 HotSpot 加了 SHA-1/SHA-256/SHA-512 的 intrinsic，在 x86 上直接生成 SHA-NI 硬件指令，AArch64 上走 ARMv8 Crypto Extension，不再走纯 Java 实现。

**实测效果**：SHA-256 9.38x。但这个特性主要在 8→17 阶段释放，17→25 持平。

### 5. HashMap/ConcurrentHashMap 持续内联优化

不是 JEP 级别，是各版本 JIT 编译器持续改进的结果：

- JDK 9+ C2 内联策略改进，`HashMap.put()`/`getNode()` 更容易被内联
- JDK 9 `ConcurrentHashMap.get()` 用 `@Stable` 注解优化 volatile read 路径，减少内存屏障开销
- JDK 9~11 间 `CHM.putVal()` 和 `replaceNode()` 内联链改善

**实测效果**：HashMap Put 1.56x，HashMap Get 1.30x，ConcurrentMapGet 1.27x。单看不大，但 HashMap 是 Java 里调得最多的数据结构，乘以调用频次就很可观了。

---

## 四、Compact Object Headers 专项

`[JEP 519]` JDK 25 引入，对象头从 96-128 bit 压缩到 64 bit。

官方数据：堆内存 -22%，CPU 时间 -8%，GC 次数 -15%。我的实测：

| 场景 | JDK 25 默认 | +COH | 额外提升 | 原因 |
|------|------------|------|---------|------|
| DeepObjectTree | 24ms | **11ms** | +118% | 深对象树，对象头占比大 |
| StringBuilderStress | 26ms | **14ms** | +86% | 大量短命 String 对象 |
| RegexPatternMatch | 62ms | **36ms** | +72% | Pattern 内部对象更紧凑 |
| DoubleArithmetic | 208ms | **166ms** | +25% | 数据局部性改善 |
| SerializationRoundtrip | 139ms | 120ms | +16% | 写入更小的对象头 |
| ConcurrentQueueThroughput | 42ms | 39ms | +8% | int[] 更紧凑 → queue 更紧凑 |

*微基准下 ObjectAlloc/SmallObjAlloc 效果不明显，因为单线程堆压力小。真实负载（大量对象 + GC 频繁）下，官方数据是堆内存 -22%、GC 次数 -15%*

**使用方式**：

```bash
java -XX:+UseCompactObjectHeaders -jar your-app.jar
```

JDK 25 中不需要 `-XX:+UnlockExperimentalVMOptions`，直接可用。

---

## 五、JIT 逃逸分析质变

4 项测试直接 0ms，背后是多个版本 C2 编译器逃逸分析和锁消除的持续增强：

- JDK 9~10：C2 逃逸分析（EA）大幅改进，`new Object()`/`new int[4]` 不逃逸 → 栈上分配 + 标量替换，直接消掉
- JDK 10：C2 锁消除（Lock Elision）增强，锁对象不逃逸 → 消除 synchronized 块
- `[JEP 374]` JDK 15 Biased Locking 移除 + 轻量锁路径优化
- JDK 9+：`Integer.parseInt` / `Long.parseLong` 在常量输入下被 JIT 做 intrinsic 替换 + 常量折叠，直接消掉调用

生产里你的代码未必这么理想，对象经常逃逸，锁经常竞争。

---

## 六、性能退化

不是所有项都变快了，有几个退步：

| 项目 | JDK 8 | JDK 25 | 原因 |
|------|-------|--------|------|
| ThreadSpawnJoin | 133ms | 168ms | 平台线程创建开销增大（JDK 21+ 引入虚拟线程，平台线程路径有额外检查） |
| TreeMapOps | 48ms | 77ms → 53ms(+COH) | TreeMap 在 JDK 17+ 有退化，可能跟 C2 编译策略调整有关，COH 缓解但未完全恢复 |
| ArrayListSortLarge(Integer) | 1786ms | 2193ms → 1887ms(+COH) | Integer 比较开销在新 JIT 下内联策略不同 |
| AtomicCAS / ReentrantLock | — | ≈持平 | CAS 是硬件级指令，JVM 优化空间本来就小 |

线程创建变慢不意外：JDK 25 推荐用虚拟线程（`Thread.ofVirtual()`）替代频繁创建平台线程。如果你的代码还在 `new Thread()`，升级后建议逐步改掉。

---

## 七、 完整提升项映射表

| 提升项 | 加速比 | 驱动来源 | 版本 |
|--------|--------|-------------|------|
| String 拼接 | **1.98-2.21x** | JEP 280 + JEP 254 | 9 |
| Math intrinsic | **2.05-2.89x** | JEP 348 + C2 intrinsic 持续扩展 | 9-14 |
| Arrays.sort(int[]) | **4.00x** | 双轴快排（JDK 7）+ 持续优化（7-14） | 7-14 |
| SHA-256 | **9.38x** | HotSpot SHA-NI intrinsic | 9+ |
| HashMap Put | **1.56x** | C2 内联策略改进 | 9-11 |
| HashMap Get | **1.30x** | C2 内联策略改进 | 9-11 |
| CHM Get | **1.27x** | CHM get() @Stable 优化 + 内联改善 | 9-11 |
| Regex 匹配 | **1.44x** | C2 内联 + 对象分配优化 | 9-11 |
| 序列化 | **1.23-1.63x** | 内部缓冲优化 + JEP 519 | 9, 25 |
| 紧凑对象头 | **+8%~118%** | JEP 519 | 25 |
| 逃逸分析增强 | →0ms | C2 EA + 标量替换持续增强 | 9-10 |
| 锁消除增强 | →0ms | C2 Lock Elision + JEP 374 | 10, 15 |
| parseInt 折叠 | →0ms | JIT intrinsic + 常量折叠 | 9+ |

---

