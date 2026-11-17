---
title: "JDK 25 AOT 缓存实测：Spring Boot 启动快 2.4 倍，一行代码不改"
slug: jdk25-aot-cache-startup
date: 2026-11-08
category: "JDK 新特性"
tags:
  - "AOT"
  - "JDK 25"
  - "Spring Boot"
  - "启动优化"
summary: "JDK 25 的 AOT 缓存把类加载、链接提前到构建期：Spring PetClinic 启动 6.76s → 2.84s，四组对照拆开每一层的贡献，附使用姿势与排错手册。"
---

> 4 核虚拟机实测 Spring PetClinic，启动 6.76s → 2.84s，附实现原理、使用姿势、排错手册

---

Java 一直被吐槽「启动慢」。一个 Spring Boot 应用，光是启动就要加载两万多个类，读字节码、解析、加载、链接，一套流程走两万遍，几秒钟就没了。

JDK 25 给这个问题交了一份答卷：**AOT 缓存**。官方叫 Ahead-of-Time Cache，属于 Project Leyden 的第一批落地成果。它的思路很朴素——既然每次启动都在重复读同样的 jar、加载同样的类，为什么不把这些工作提前做好、下次直接复用？

我把这套机制在 4 核虚拟机上完整跑了一遍，用官方标杆应用 Spring PetClinic 实测：**启动时间从 6.76 秒降到 2.84 秒，加速 2.38 倍，全程一行代码没改**。下面从实测数据反推它的原理和用法。

---

## 一、AOT缓存是什么：三个 JEP 打包

先说清楚一个常见误解：**JDK 25 的 AOT 不是 GraalVM Native Image**，不编译成原生二进制，JVM 照常跑。它缓存的是「类的状态」，不是「编译后的机器码」。

具体由三个 JEP 组成：

| JEP | 名称 | 做什么 |
|-----|------|--------|
| **JEP 483** | Ahead-of-Time Class Loading & Linking | 把类的读取、解析、加载、链接提前到构建期存进缓存 |
| **JEP 514** | Ahead-of-Time Command-Line Ergonomics | 把命令简化为一步式（`-XX:AOTCacheOutput`） |
| **JEP 515** | Ahead-of-Time Method Profiling | 把热点方法的剖析数据也放进缓存，改善预热 |

它本质是 CDS（Class Data Sharing）的进化版。CDS 从 JDK 5 就有了，但 JDK 自带的默认 CDS 只缓存 JDK 基础类（一千多个），**你的应用类一个都不管**；AOT 缓存把应用类的读取、解析、加载、链接全部提前——这才是它提速的来源。具体哪一层贡献最大，后面用四组对照实测拆给你看。

---

## 二、实现原理：它到底省了哪几步

一个类要被 JVM 用起来，启动时必须依次走四步：

```
读取字节码 → 解析 → 加载 → 链接（验证 + 准备 + 符号解析）
```

这四步之后类才可用，再往后是执行静态初始化（`<clinit>` 静态块）和业务代码——注意静态初始化 AOT 不提前，它可能依赖运行时状态，仍留在启动时执行。

Spring Boot 应用要加载约两万个类，这四步 × 两万次，就是启动慢的根源。

AOT 的做法是**把这四步整体搬到构建期**。整个工作流分三阶段：

1. **训练跑（record）**：正常运行一次应用，记录它加载了哪些类。
2. **组装缓存（create）**：根据记录，把那些类的读取、解析、加载、链接全部提前做好，写进一个缓存文件。
3. **部署跑（run）**：应用启动时用 `mmap` 直接把缓存映射进内存，类「现成可用」，跳过前四步，直接执行。

![AOT 缓存的三阶段：训练跑记录真正加载过的类，组装缓存把读取解析加载链接提前做完并写入 app.aot，部署跑直接 mmap 映射跳过这四步](/media/posts/jdk25-aot-cache-startup/AOT_-642d889b.png)

用一张图对比启动环节：

![两种启动路径的对比：默认每次都要走读取字节码、解析、加载、链接，AOT 缓存把前四步搬到构建期，只有执行仍留在启动时](/media/posts/jdk25-aot-cache-startup/AOT_-b84b1dda.png)

一个关键的细节：**最后一步「执行」AOT 管不了**。解释器执行 + JIT 编译照样发生，热点方法该编译还是编译。这就是为什么 AOT 只省启动、不提峰值吞吐——它把「从 0 到 1」变快，但管不了「从 1 到 100」。

那句类比可以帮你记：

- **默认 CDS** = 只把官方教材（JDK 基础类）提前印好摆好
- **AOT 缓存** = 把你的两万本书也提前印好、拆好、摆上桌（应用类读取解析 + 加载链接）
- **jWarmup** = 提前把书翻到最常看的那几页（省预热到峰值）

---

## 三、实测效果：2.38 倍启动加速

### 测试环境

| 项目 | 值 |
|------|-----|
| CPU | 4 核（虚拟机） |
| 内存 | 7.4 GiB |
| OS | OpenCloudOS 8.10 |
| JDK | Temurin 25.0.4+7 (LTS) |
| 应用 | Spring PetClinic 4.0.0-SNAPSHOT（main 分支快照，Spring Boot 4.1.0，93 个依赖 jar） |

测试方法：每组跑 5 次取中位数，每次运行前 `sync && echo 3 > /proc/sys/vm/drop_caches` 清空页缓存，避免 OS 文件缓存干扰。

### 四组对照

我特意做了四组，把每一层的贡献拆开——因为「CDS 默认就开着」和「AOT 缓存」是两个不同的东西，混在一起就看不清谁在出力：

| 组 | 中位数启动耗时 | 累计降幅 |
|----|--------------|---------|
| 无缓存（`-Xshare:off`） | **6.761s** | — |
| JDK 默认 CDS（只含基础类） | 6.482s | -4.1% |
| AOT 缓存，关闭链接（应用类 CDS 级） | 3.973s | -41.2% |
| **AOT 完整缓存** | **2.838s** | **-58.0%** |

**加速 2.38 倍，净省 3.9 秒，完整缓存 123MB。**

第二组用的是 JDK 自带的默认 CDS 归档——它只缓存 JDK 基础类（一千多个），你的两万个 Spring 类一个都不管，所以只省 4.1%。第三组用 `-XX:-AOTClassLinking` 生成「只提前读取解析、不提前链接」的缓存，等价于把应用类的 CDS 也做了——这才是能和官方数据对标的口径。

### 拆开看：谁贡献了什么

| 优化层次 | 做什么 | 单独贡献 |
|---------|--------|---------|
| JDK 默认 CDS | JDK 基础类读取、解析提前 | -4.1% |
| 应用类读取解析 | 两万个 Spring 类的读取、解析提前 | **-37.1%** |
| 加载 + 链接 | 类加载、链接提前 | -16.8% |

结论有点反直觉：**提速主力不是「加载链接」，而是「应用类的读取解析」（37.1%）**，加载链接只再贡献 16.8%。

这个结论和 JEP 483 官方的拆解完全吻合——官方原话是「PetClinic 启动提升的大部分来自 CDS 已实现的提前读取解析」。我的实测里「应用类 CDS 级」累计 -41.2%，官方是 33%（JDK 23→24 口径，基线没我关得彻底），同量级。

但这不等于「AOT 没价值」。关键区别在于：**JDK 默认 CDS 只管 JDK 自己的类，你的应用类它一个都不认识**。AOT 缓存相对默认 CDS 的增量是那 53.9 个百分点——应用类读取解析（37.1%）+ 加载链接（16.8%）全是 AOT 给你的，这是默认 CDS 给不了的。

---

## 四、AOT 怎么用：三步，零代码改动

### 前提：Spring Boot fat jar 要先解压

AOT 不支持嵌套 jar（fat jar），所以 Spring Boot 应用必须先解压：

```bash
java -Djarmode=tools -jar app.jar extract --destination extracted
```

解压后得到 `extracted/` 目录，里面有主 jar 和一个 `lib/` 子目录（本测试解出 93 个依赖 jar）。

### 第一步：训练跑 + 生成缓存（一步式）

JDK 25 已经简化为一步，训练跑结束退出时自动产出缓存：

```bash
java -XX:AOTCacheOutput=app.aot \
     -Dspring.context.exit=onRefresh \
     -jar extracted/app.jar
```

`-Dspring.context.exit=onRefresh` 让 Spring 完成 context 初始化就退出，正好覆盖启动阶段要加载的全部类，是官方推荐的训练姿势。

### 第二步：部署跑，加载缓存

```bash
java -XX:AOTCache=app.aot \
     -jar extracted/app.jar
```

就这些。改一个启动参数，多一个缓存文件。

### 一个硬约束

训练跑和部署跑必须**同一 JDK 版本 / OS / CPU 架构 / classpath**，任何一项变了缓存就失效。所以缓存要在 CI/CD 里随版本重新生成，别想着跨机器、跨版本拷贝。

---

## 五、故障排错手册

AOT 最大的坑是**静默降级**：缓存没生效，应用照样跑，只是启动慢回去了。下面这套方法能帮你确认「缓存到底用没用上、为什么没用上」。

### 第一步：打开 AOT 日志

```bash
# 看缓存是否命中
java -Xlog:aot=info    -XX:AOTCache=app.aot -jar app.jar

# 排查失败，开到最详细
java -Xlog:aot=debug   -XX:AOTCache=app.aot -jar app.jar
```

缓存命中时的典型日志：

```
[0.002s][info][aot] Opened AOT cache /data/aotbench/petclinic-extracted/app.aot.
[0.002s][info][aot] The AOT cache was created with UseCompressedOops = 1,
                    UseCompressedClassPointers = 1, UseCompactObjectHeaders = 0
```

注意第二行：**缓存会记住创建时的关键 JVM 参数**。这条日志是排查失效的黄金线索——当前运行参数和它不一致，就能看出是哪个 flag 变了。

### 四个真实失败场景

我在机器上实际触发过这几个场景，日志特征如下：

| 场景 | 日志特征 | 应用行为 |
|------|---------|---------|
| 缓存文件不存在 | `Loading static archive failed` / `Unable to map shared spaces` | 报错后**继续启动**（exit=0） |
| `-XX:AOTMode=on` + 缓存缺失 | `Unable to use AOT cache` | **VM 直接失败**（exit=1） |
| 关键 flag 不一致 | 日志里 `created with UseCompressedOops = 1...` 与当前不符 | 静默降级 |
| 改 GC（换 Shenandoah） | 无 error | **照常用**（JEP 允许 GC 不一致） |

### 最容易踩的坑

默认 `AOTMode=auto` 下，缓存不可用**只打一条 error 就悄悄继续跑**。你以为开了 AOT，实际可能根本没生效。两个应对：

- **上线前自检**：用 `-XX:AOTMode=on` 强制校验，缓存有问题直接报错退出——但**仅用于诊断，别用于生产**（云平台注入 JVMTI agent 等外部因素可能导致意外启动失败）。
- **监控日志**：抓 `Opened AOT cache` / `Loading static archive failed` 两个关键字做告警。

### 排查清单

1. 缓存文件真的在吗？（训练跑确实生成了 `app.aot`）
2. 训练和运行是不是同一套环境？跨版本跨机器拷贝必失效。
3. 关键 JVM flag 变了吗？（对照 `created with ...` 那行）
4. 是不是 fat jar？（先 `jarmode=tools extract` 解压）
5. 挂没挂 APM/JVMTI agent？（字节码改写会导致缓存不可用）
6. 是不是自定义类加载器加载的类？（这类类本来就不进缓存）
7. 开 `-Xlog:aot=debug` 看细节，多数问题到这步就定位了。

---

## 六、AOT 缓存的边界：什么时候别用

AOT 不是银弹，下面这些限制决定了它的适用场景：

| 限制 | 说明 |
|------|------|
| 缓存不可移植 | 同 JDK 版本/OS/架构/classpath 才能命中 |
| 不缓存机器码 | 峰值吞吐不提升，JIT 该编译还是编译 |
| 训练质量决定收益 | 训练跑没覆盖的类/路径不会进缓存 |
| 不支持自定义类加载器 / 动态生成类 | 本次训练跑 216 个类被跳过，其中 198 个 `Unsupported location`（多为 JDK 动态代理运行时生成的 `$Proxy` 类，无 jar 来源可定位） |
| 与 JVMTI 字节码改写不兼容 | 很多 APM 工具会踩这个坑 |
| fat jar 需先解压 | 嵌套 jar 不支持 |
| 一步式生成吃双倍堆 | 小容器可能内存不够，需拆成三步 |
| 缓存格式不保证稳定 | 跨版本甚至小版本都不能复用 |

**适合**：启动时间 > 3-5s 的 Spring Boot/框架类服务、serverless 冷启动、K8s 滚动发布/扩容。

**不适合**：启动本就 < 1s 的小程序、常年长驻且不在意启动的大单体、重度依赖自定义类加载器或字节码改写 agent 的场景。

---

## 七、一句话总结

AOT 缓存是给**「秒级启动敏感」**场景省钱的：serverless 冷启动、K8s 滚动发布、微服务快速就绪。它对长驻服务的峰值吞吐没有提升。

如果你的服务启动要 5 秒以上、又在意启动/扩容速度，JDK 25 的 AOT 缓存几乎是无成本收益——解压 fat jar、跑一次训练、加个启动参数，启动就能快 2 倍多。如果服务本来 500ms 就起来了、又常年长驻，那这功能对你基本无用。

---

*测试环境：OpenCloudOS 8.10, x86_64, 4 core, Temurin JDK 25.0.4, Spring PetClinic 4.0.0-SNAPSHOT（main 分支，Spring Boot 4.1.0）*

