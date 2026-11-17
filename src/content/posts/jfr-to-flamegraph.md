---
title: JFR 转火焰图工具
slug: jfr-to-flamegraph
date: 2026-06-22
category: CPU 与采样分析
tags:
  - JFR
  - 火焰图
  - CPU
summary: "JFR 是 JDK 自带的一站式采集器，但它的堆栈默认不是火焰图形态。把它转成火焰图要处理事件类型选择（cpu / wall / alloc）、帧折叠与权重口径三件事，本文给出可直接用的参数与工具。"
---

JDK 自带的 JFR（Java Flight Recorder）功能算是一套一站式解决方案，可以采集到很多的信息。对于堆栈的展示，火焰图是个比较好的选择。目前 JMC 自带的火焰图不够完善，例如 Socket 的堆栈变成火焰图应该转化为时间单位来确定宽度，而不是 CPU 的那种算堆栈出现的次数。

社区有一套解决方案 [jfr-flame-graph](https://github.com/chrishantha/jfr-flame-graph)，但这个方案有个限制——只支持 Oracle JDK 8。社区快速前进，JFR 的功能也在不断迭代，高版本就无法享受这个功能了。JFR 在 JDK 11 的时候开源到了 OpenJDK 中，很多解析的 API 都改变了。

所以为了解决这个问题，我实现了一版支持 JDK 11+ 的 jfr-flame-graph，并且在解析新版本的功能上做了增强。

> 项目地址：[xpbob/jfr-flame-graph](https://github.com/xpbob/jfr-flame-graph)

## 支持的事件类型

- **cpu** — CPU 火焰图
- **allocation-tlab** — 快分配火焰图
- **allocation-outside-tlab** — 慢分配火焰图
- **exceptions** — 异常火焰图
- **monitor-blocked** — 锁火焰图
- **io-socket** — IO 火焰图

CPU 层面比原来的有增强，新版的 JFR 会采样 JNI 的 Code，原来的 JFR 是没有这个功能的。所以新版本里的火焰图是由 **Java Code** 和 **JNI Code** 两部分组成。

## JFR 生成方式

```bash
jcmd <pid> JFR.start name=test1 duration=240s settings=profile.jfc filename=flight_recording_16eaTest8490.jfr
```

## 使用方式

### 1. 准备 FlameGraph 工具

```bash
git clone https://github.com/brendangregg/FlameGraph.git
export FLAMEGRAPH_DIR=/path/to/FlameGraph
```

配置好环境变量后，下载 jfr-flame-graph 工程（需要 JDK 11 编译）。

### 2. 生成火焰图

```bash
java -jar jfr-flame-graph-1.0-SNAPSHOT-jar-with-dependencies.jar \
  -f ~/flight_recording_16eaTest8490.jfr \
  -e allocation-tlab \
  | $FLAMEGRAPH_DIR/flamegraph.pl --title "Flame Graph" > flame.svg
```

## 参数说明

```
usage: jfr-flame-graph
 -d,--decompress                              Decompress the JFR file
 -e,--event <Type of event used to generate
              the flamegraph>                 [cpu,
                                               allocation-tlab,
                                               allocation-outside-tlab,
                                               exceptions,
                                               monitor-blocked,
                                               io-socket]
 -f,--jfrdump <jfr file path>                 Java Flight Recorder Dump
 -h                                           Help
```

| 参数 | 说明 |
| --- | --- |
| `-d` | 解压缩用，如果 JFR 生成的是压缩版本就需要带这个参数 |
| `-f` | 输入 JFR 文件的位置 |
| `-e` | 要解析的事件类型，默认不写就是 `cpu`，想看其他事件需要加这个参数 |

这个 jar 把结果打印在标准输出上，正好可以通过管道交给火焰图工具生成 SVG：

```bash
$FLAMEGRAPH_DIR/flamegraph.pl --title "Flame Graph" > flame.svg
```

最终可以用浏览器打开 `flame.svg` 查看火焰图。

![JFR 转出的 CPU 火焰图：底部是线程入口，向上是调用链，条宽代表采样占比](/media/halo/image-tmdr-d030265c.png)
