---
title: "火焰图顶上那个桩，指向一批从未编译的方法"
slug: huge-method-adapter
date: 2026-11-15
category: "CPU 与采样分析"
tags:
  - "JVM"
  - "火焰图"
  - "JIT"
  - "排障"
summary: "火焰图顶上那帧 I2C/C2I adapters 只是 JVM 的跳转桩，真正的问题在它下面的方法从未被编译。顺着 codelist 和字节码长度查下去，是 HotSpot 的一条准入判断：单个方法超过 8,000 字节，分层编译不给它排队。跨过这条线稳态慢 3.05 倍，翻转 DontCompileHugeMethods 把 27,262 ns 拉回 9,465 ns。"
---

一个跑了很久的 Java 服务做性能优化，火焰图来自 pyroscope 的持续采集看板。热点方法顶上挂着一帧 `I2C/C2I adapters`，把调用方和被调方法隔开。

这不是业务方法名。它是 JVM 生成的一段跳转桩，负责在解释执行和编译执行之间转换参数布局。桩贴在热点方法的入口上，说明有方法一直在跨这道边界。

服务跑了这么久，热点方法还没被编译？顺着这条线查下去，最后碰到的是 JDK 的一条准入判断：单个方法超过 8,000 字节，分层编译不给它排队。跨过这条线，稳态慢 3.05 倍。

## 一、它为什么总在栈顶

名字是采集端从 JVM 的 code blob 里读出来的，I2C 和 C2I 分别指解释调编译、编译调解释。它站在栈的哪个位置、下面压着谁，决定了后面往哪里查。平台上看得到这个桩，看不到它背后是谁，要看清，只能在自己机器上造一份同样的负载。

复现负载不加任何额外 JVM 参数，`-e itimer -i 1ms` 分三段各 4 秒采，三轮合并 1,166 个 adapter 样本。位置只有一个：

| 位置 | 样本数 |
| --- | --- |
| 栈顶（collapsed 的最后一个字段） | 1,166 |
| 栈中（深度 ≥ 1） | 0 |

换采样引擎（`-e cpu`，走 perf_events），256 个样本同样全在栈顶。显式打开大方法编译（`-XX:-DontCompileHugeMethods`），这个帧只剩 11 个，也全在栈顶。所有方法都在阈值以下的配置、全解释执行的配置，一个都没有。

![桩只在栈顶出现，栈中间永远没有它](/media/posts/huge-method-adapter/HugeMethod_-5e9ca9a3.png)

栈顶之下是调用方。调用方一共六种，前五种是业务方法：

| 调用方 | 样本 | 它是谁 |
| --- | --- | --- |
| `Loop.main` | 484 | 压测循环，直接调大方法 |
| `Row$Builder.mergeFrom` | 445 | protobuf 生成的解析方法 |
| `Row.writeTo` | 149 | 序列化 |
| `Row.equals` | 73 | 比较 |
| `Row.getSerializedSize` | 2 | 计算序列化长度 |
| `JavaCalls::call_helper` | 1 | VM 内部从 C++ 调 Java |

六种加起来 1,154，剩下 12 个样本的栈里只有 adapter 一帧，占 1.0%，是栈遍历断掉了，别把它当信号。

栈的形状说的也是同一件事。`Loop.main` → adapter 这条，单条栈就 55 个样本，桩直接贴在循环调用的入口上，中间没有别的帧。Builder 链最长到 11 帧，从循环穿进 7 层 protobuf 继承链才落到 adapter，调用方是不是热点，不影响这个桩露头。

### 它不可能出现在栈中间

源码写得很直接。`sharedRuntime_x86_64.cpp` 里生成 adapter 的函数开头有一条注释：

```c
// Adapters can be frameless because they do not require the caller
// to perform additional cleanup work, such as correcting the stack pointer.
```

frameless 是真的没有帧。i2c adapter 把返回地址 `pop(rax)` 取下来，重排完参数再 `push(rax)` 压回去，最后 `jmp(r11)` 跳进目标方法。c2i 那一侧的注释是 `We finally end in a jump to the generic interpreter entry point`。

两边都是尾跳。跳完以后桩的代码已经不在执行路径上，栈上也没有它的帧，遍历时看不见它。唯一能看见的时机，是采样点正好落在桩的那几条指令上，这时 PC 在桩里，展开出来它就是栈顶。

它在栈里占比不高，3.19%，同一批栈里被调的那个方法本身占 95.1%（11,568/12,162）。耗时都在被调的方法里，这 3.19% 只是跨边界那一瞬。

名字是两个方向合在一起的，采集端不替你区分。关掉编译限制之后，这个帧降到 0.02%，被调的那个方法本身仍占 87.8%（11,268/12,838）。方法照跑，只是不再跨边界，说明这批样本基本都出在编译方法调解释方法那一侧。

所以这个帧只能证明跨边界发生过，证明不了谁在跨、跨到哪儿。看到它，前一帧是调用方，再往前才是调用链。具体到这次，它指向的怀疑很明确：热点路径上那几个上万字节的方法，一直在解释执行。

## 二、平台上看不出编译状态

怀疑要落地，得看方法到底编没编。pyroscope 给出的答案是没有答案。

不少团队的 Java 持续剖析走的是 async-profiler，Grafana 的 `pyroscope.java` 组件就是这么做的，官方文档写着 `using async-profiler`。它的 `profiling_config` 参数表里只有这些：

```
cpu = true            # itimer 事件
sample_rate = 100     # 100 Hz
alloc = "512k"
lock = "10ms"
per_thread = false
```

没有 `--ann`。这个参数是 async-profiler 用来把编译状态写进方法名的，采集端不传，导出的帧里就只剩方法名。

同一份负载导出四遍，差别全在帧名上：

| 导出 | 帧名形态 | 编译状态 |
| --- | --- | --- |
| collapsed（默认） | `bench/w800/Row.writeTo` | 看不到 |
| collapsed `-a` | `bench/w800/Row.writeTo_[0]` | 看得到 |
| OTLP（平台入库格式） | `bench/w800/Row.writeTo` | 看不到 |
| HTML 火焰图 | 按帧类型着色 | 看得到 |

OTLP 那份就是推给平台的样子：162,569 字节，`bench/w800` 相关字符串 1,134 个，`I2C/C2I adapters` 这个字符串 1 个，带 `_[` 标注的 0 个。平台认得出这个桩，认不出谁在解释。

两份 OTLP 摆在一起更清楚。默认那组的大方法永远不编译，翻转 `-XX:-DontCompileHugeMethods` 之后编译，而 `bench/w800/Row.equals` 这个字符串在一份里和另一份里一字不差。同一个方法名，一个是解释执行，一个是 C2 编译，画在平台上是同一块颜色。

平台自己的着色也不救场。Pyroscope 官方博客讲火焰图怎么读，说颜色只是为了把相邻的块分开，原话是 `The colors for profiles are generally not significant. They are distributed at random to distinguish between function calls.` 它不承载语义。

一块很宽的 Java 帧，看不出它是在解释执行还是编译执行。这层信息在采集端就没写进去，后面聚合、入库、画图都不会再补。要确认，只能去翻 JIT 自己的账。能登录机器的话，自己起一次 profiler 加 `-a` 也看得见。

## 三、去 JIT 的记录里查

JIT 的账有三个地方记着，各管一件事：

```bash
# 当前在册的 nmethod 清单，一次快照，不触发编译
jcmd <pid> Compiler.codelist

# 编译事件流水：谁被编译、level 几、多大
-Xlog:jit+compilation=debug:file=jit.log

# XML 明细：nmethod 大小、编译耗时
-XX:+UnlockDiagnosticVMOptions -XX:+LogCompilation
```

这三样的时间窗口不一样。`-Xlog:jit+compilation` 得在启动时加，事后开只能看到之后的事件；`jcmd Compiler.codelist` 能随时抓，但只有当下在册的方法，没有"曾经编译又失效"的记录。所以两者要配合着看。

默认配置那组，codelist 全表 2,987 行，`bench.w800` 相关 2,436 条。先把 adapter 的相邻帧列成候选，再拿名字去查：

| 相邻帧 | 样本数 | 在 codelist 里 |
| --- | --- | --- |
| `Row$Builder.mergeFrom` | 82 | 命中（同名桥接方法） |
| `Row.writeTo` | 57 | **查无** |
| `Row.equals` | 27 | **查无** |
| `Loop.main` | 21 | **查无** |
| `Row.getSerializedSize` | 2 | **查无** |

`mergeFrom` 那 82 个样本是脚本的漏报。codelist 里有四个同名的 7 字节桥接方法（返回不同的 `*Builder` 接口），按名字粗匹配会命中。定性不能停在名字上。

查无在册也可能只是"还没轮到"。要把它和另外几种可能分开，得有一组对照。四组配置，唯一变量是大方法编不编：

| 组 | N | 额外参数 | 含义 |
| --- | --- | --- | --- |
| A | 800 | 无 | 大方法永不编译，调用者已编译 |
| B | 800 | `-XX:-DontCompileHugeMethods` | 大方法被编译 |
| C | 200 | 无 | 最大方法 6,219 B，全部可编译 |
| D | 800 | `-Xint` | 全解释执行，没有编译/解释边界 |

每组三轮交错执行，采样窗口 12 秒。同一个帧，成因至少四种，走势完全不同：

| 场景 | 本次结果 | 三段走向 | 第一判据 |
| --- | --- | --- | --- |
| 还没热，方法正在编译 | C 组首段 0.17% | 0.17% → 0.00% → 0.00% | 第二段是否归零 |
| 永远不会被编译 | A 组 3.23% | 2.60% → 3.03% → 3.70% | 是否始终不归零 |
| deopt 退回解释器 | 本次 0 条 uncommon trap | — | uncommon trap 的时间点是否对齐 |
| 全解释执行 | D 组 0.00% | 0 | 这个帧不出现 |

![一段比一段高和一段就归零，是两种完全不同的原因](/media/posts/huge-method-adapter/HugeMethod_-dd52e3b4.png)

A 组三轮落在 3.08%~3.27%，中位 3.23%；B 组 0.02%~0.05%，中位 0.02%。换 `-e cpu`（perf_events）复测同向：A 3.08%、B 0.01%、C 和 D 都是 0。这个帧不是采样引擎造出来的。

第一种是"还没热"。C 组最大方法 6,219 B，全部可编译，首段 0.17%（10 个样本），第二段、第三段都是 0.00%。普通方法编完，边界就没了，这一类的判据只有一条：第二段归零就可以放下。

第二种是"永远不会被编译"，走势正相反。A 组三段 2.60% → 3.03% → 3.70%，一段比一段高。把调用加到 10 万次、阈值压到 100：

```
-XX:CompileThreshold=100 -XX:Tier3CompileThreshold=50 -XX:Tier4CompileThreshold=100
```

codelist 里六个大方法仍然 0 条。调用次数和阈值都不再是变量，剩下的解释只有一个：它们没进队列。

第三种是 deopt。方法退回解释器，下次调用时重新编译，几十毫秒就回去，表现是一阵一阵，很难在 12 秒窗口里稳定占住 3%。真正的 deopt 在 jit 日志里记成 `uncommon trap`，这次九份日志（A、B、C 各三轮）一条都没有，拿不到占比。判据只能靠时间对齐：`uncommon trap` 出现的时刻，和 adapter 样本集中的那一段是否重合。

这里有个坑是 `made not entrant`。A 组的日志里有 885 条，看着像大范围失效，其中 880 条是 level 3 的 C1 版本被 level 4 的 C2 版本替换，属于分层编译的正常升级。拿它当 deopt 的证据会认错方向。

第四种是全解释，最好排除。`-Xint` 组 0.00%，解释调解释不需要桩，所以这个帧一旦出现，就说明进程里有编译代码在工作。

三种都排除掉，剩下那一种还要验一次因果：如果真是因为没被编译，把编译打开，这个帧就该消失。翻转 `-XX:-DontCompileHugeMethods` 之后 16 条编译记录，adapter 从 3.23% 掉到 0.02%，方法还在跑，只是不再跨边界。

问题只剩一个：这些方法为什么进不了编译队列。答案在字节码的长度上。

## 四、门槛在 8,000 字节

用脚本直接解析 class 文件的 Code 属性，拿 `code_length`，不用 `javap` 估算：

| 方法 | 字节码 |
| --- | --- |
| `Row$Builder.mergeFrom(CodedInputStream, ExtensionRegistryLite)` | 24,639 B |
| `Row.getSerializedSize()` | 15,899 B |
| `Row.hashCode()` | 15,115 B |
| `Row.writeTo(CodedOutputStream)` | 14,277 B |
| `Row$Builder.mergeFrom(Row)` | 12,824 B |
| `Row.equals(Object)` | 10,443 B |

同一个类里其余方法最大 4,132 B，`buildPartial` 被生成器拆成了每块 508 B。这六个没被拆。

![越过 8,000 的都在虚线右边，N=255 与 N=258 只差 3 个字段](/media/posts/huge-method-adapter/HugeMethod_-bf5741c5.png)

字节码随字段数线性涨。255 到 258 多 3 个字段、多 89 字节，平均一个字段约 30 字节。边界落在两个相邻配置之间：

| 配置 | 最大方法 | 编译记录（默认） | 编译记录（翻转） |
| --- | --- | --- | --- |
| 255 字段 | 7,914 B | 4 条 | 4 条 |
| 258 字段 | 8,003 B | **0 条** | 4 条 |

只多 3 个字段、89 字节，跨过一条线，编译记录归零。线在 (7,914, 8,003] 之间。

`compiler_globals.hpp:375-380` 里两个参数：

```cpp
product(bool, DontCompileHugeMethods, true, "Do not compile methods > HugeMethodLimit")
develop(intx, HugeMethodLimit, 8000,
        "Don't compile methods larger than this if +DontCompileHugeMethods")
```

`DontCompileHugeMethods` 是 product flag，能改；`HugeMethodLimit` 是 develop flag，产品版 JDK 设不了：

```
$ java -XX:HugeMethodLimit=100000 -version
Error: VM option 'HugeMethodLimit' is develop and is available only in debug version of VM.
```

真正的判断在 `compilationPolicy.cpp:129`：

```cpp
if (DontCompileHugeMethods && m->code_size() > HugeMethodLimit) return false;
```

是 `>`，不是 `>=`，所以 8,000 本身不算超。

这行判断被包在 `compilationPolicy.cpp:779` 的 `can_be_compiled` 检查里，外层有个 `if (!CompilationModeFlag::disable_intermediate())`。关掉分层编译时，`compilerDefinitions.cpp:84-93` 把模式设成 `HIGH_ONLY`，`disable_intermediate()` 返回真，整段检查被跳过。

于是同一个 24,639 字节的方法，默认配置编不了，加 `-XX:-TieredCompilation` 就能编。纯 C2 下 15,899 字节的 `getSerializedSize` 编出了 132,080 字节的 nmethod，六个里最大的是 279,632 字节。`-XX:CompilationMode=high-only` 是同样的效果：分层还开着，跑 5,000 次，24,639 字节的方法出现 2 条编译记录。

门槛是分层编译策略里的准入判断，C2 本身编得动。而编得动却没编，代价很具体。

## 五、打开编译能拿回什么

这条线跨过去的代价，稳态上量得出来：慢 3.05 倍。

255 字段和 258 字段是两个相邻配置，字节码 7,914 B 对 8,003 B，只差 3 个字段、89 字节。前者编译，后者不编译，稳态每次调用从 8,936 ns 变成 27,262 ns。差距不在字段上：把 258 的开关翻掉，回到 9,465 ns，与 255 只差 5.92%。

三轮中位，单位 ns/iter：

| N | 最大方法 | 默认（大方法解释执行） | 关闭开关（大方法被编译） | 倍数 |
| --- | --- | --- | --- | --- |
| 255 | 7,914 B | 8,936.0 | 9,184.7 | **0.97×** |
| 258 | 8,003 B | 27,261.7 | 9,465.0 | **2.88×** |
| 800 | 24,639 B | 270,482.6 | 174,767.6 | **1.55×** |

![N=255 开关前后几乎没差，说明收益不是开关给的](/media/posts/huge-method-adapter/HugeMethod_-809c7d63.png)

两个倍数基准不同：3.05 是 255 与 258 两组默认配置之比（27,262/8,936），2.88 是 258 组开关前后之比（27,262/9,465）。

255 这一行是阴性对照。这组配置里没有任何方法超过门槛，开关开与不开应该没区别，实测 0.97×，落在 4% 左右的噪声带里，说明开关本身不产生副作用。258 和 800 的收益不是开关带来的，是那个方法真的进了编译队列。

800 的倍数反而比 258 小，1.55 对 2.88。原因在结构：N=258 只有一个超限方法，N=800 有六个，每次迭代里每个方法各自只占一段。编译只解决方法内部的执行，方法之间的切换、Builder 链的调度照旧要花时间，摊薄下来倍数就低了。

`-Xint` 全解释是 610,469.3 ns，是默认分层的 2.26 倍，可以当作"一行都不编译"的天花板。默认分层的 270,482 ns 落在天花板和编译版之间，符合"大方法解释、其余编译"的混合状态。

### 编译不能落进计时窗口

C2 编译这六个方法要两秒多。窗口里混进编译，方向都会反过来：同一份代码，有的配置看起来变快，有的看起来变慢，取决于哪个方法恰好在窗口内被编。

为此测量前要做七件事：

- 构造 seed 的代码隔离到一个只调一次的 `makeRow()`。否则 `main` 因为 800 行 `setF` 自己涨到 7,461 字节，在计时窗口里触发 OSR 编译
- 预热和测量共用同一个 `loop(int n, ...)`，每块迭代数相同
- 外部轮询 jit 日志，连续 4 秒不增长才放闸门文件
- 测量分 8 段独立计时，取后 4 段中位
- 每段窗口内 >8000 B 方法的编译数必须为 0，21/21 全部通过
- `taskset -c 2` 绑单核、`-Xms1g -Xmx1g`、3 轮拉丁方交错
- HOLD 期才抓 codelist

最后一条最容易漏。抓 codelist 会加载 JDK 的类，引入新的编译活动，放在测量窗口里就污染了。

## 六、要付多少，值不值

打开编译的代价有三块，都不在每次调用的路径上。

第一块是编译线程的时间。从 `LogCompilation` 的 `<task>` 到 `<nmethod>` 时间戳差，单个大方法在 4 vCPU 上要编这么久：

| 方法 | 字节码 | 分层（C1+C2） | 纯 C2 |
| --- | --- | --- | --- |
| `mergeFrom(Row)` | 12,824 B | 1,188 ms | 1,382 ms |
| `getSerializedSize` | 15,899 B | 555 ms | 537 ms |
| `writeTo` | 14,277 B | 366 ms | 583 ms |
| `mergeFrom(CIS)` | 24,639 B | 149 ms | 未编 |
| `hashCode` | 15,115 B | 99 ms | 未编 |
| `equals` | 10,443 B | 80 ms | 780 ms |

六个合计约 2.4 秒。这是编译线程占用，不是应用停顿；但编译线程只有两三个，被一个大方法占住，后面的方法就得排队。服务刚启动那几分钟，这个排队的代价远高于稳态。

第二块是 CodeCache 的体积。同一份 XML 里每个 nmethod 的大小：

| 方法 | 字节码 | nmethod | 膨胀 |
| --- | --- | --- | --- |
| `mergeFrom(Row)` | 12,824 | 279,632 | 21.8× |
| `mergeFrom(CIS)` | 24,639 | 195,392 | 7.9× |
| `getSerializedSize` | 15,899 | 132,080 | 8.3× |
| `equals` | 10,443 | 131,720 | 12.6× |
| `writeTo` | 14,277 | 126,896 | 8.9× |
| `hashCode` | 15,115 | 44,600 | 3.0× |

![字节码到机器码，最狠的一个方法膨胀 21.8 倍](/media/posts/huge-method-adapter/HugeMethod_-72e69a43.png)

93,197 字节的字节码变成 910,320 字节机器码，9.77 倍。整个 `bench.w800` 包 1,758 个 nmethod 共 2.79 MB。CodeCache 按方法数量累加，代码生成器批量产出大方法时，910 KB 要乘类数。

第三块是编译通道本身。这条是压出来的：把 `ReservedCodeCacheSize` 压到 2.5 MB，再关开关跑 20,000 次。

```
[7.822s][warning][codecache] CodeCache is full. Compiler has been disabled.
Compilation: disabled (not enough contiguous free space left), stopped_count=1, restarted_count=0
CodeCache: size=2560Kb used=2414Kb free=145Kb, full_count=1
```

编译在 7.82 秒停掉，之后整个进程所有方法都进不了编译队列，不只是大方法。同一份负载在 240 MB 下能编 2,139 个 nmethod，这里只编到 880 个。2.5 MB 是为了触发满而人为压的，不是建议值；这个后果不线性，折算不成 ns。

把编译时间这一块摊到每次调用上，回本点是：

- N=258：每次省 17.8 微秒，编译成本取同族方法在 N=800 的实测 149 ms（8,003 B 比 24,639 B 只会更少），约 8,400 次迭代
- N=800：每次省 95.7 微秒，六个方法合计 2,437 ms，约 25,500 次迭代

按每秒一千次迭代估，25,500 次在 26 秒内摊完。运行效率这一维，长跑里赢得干净。但三条判据要同时成立：方法在热路径上被反复调用、CodeCache 余量按方法数 × 910 KB 够用、服务已过启动期编译线程有余力。缺一条，成本就从别处冒出来。

### JDK 为什么默认关

源码里只有一行描述，没写理由。社区里的解释是 ROI 低，Stack Overflow 上一个回答的原话是 `Basically the ROI of compiling huge methods is low.`，答者是 async-profiler 的作者 Andrei Pangin（问题 24927813）。这是社区解释，不是 JDK 的设计文档。

这个解释和实测对得上：热路径通常只覆盖大方法的一小段，编译单元却是整个方法，92 KB 字节码换 910 KB 机器码、两秒多编译线程，赌的就是那一小段值得。默认值不是错，是它的前提在 protobuf 这类代码上不成立。`mergeFrom` 是顺序解析，热路径就是整个方法。

真正的处置不在开关上。`buildPartial` 是现成的对照，生成器把它拆成每块 508 B，它从来没碰到这条线。要么控制字段数让方法不进这个区间，要么把方法拆开。开关能验证问题，验证完关回去。

## 七、下次遇到怎么办

在一张稳态火焰图上看到 `I2C/C2I adapters`，按三步走。

第一步，确认它在稳态。能自己采样就分三段，每段至少 4 秒；只有平台看板，就看时间序列上这个帧是不是一直挂着、没有归零的窗口。稳态段（第二段起）占比都 ≥1%，末段不低于首段的 0.7 倍。冷启动会有 0.17% 然后归零，那不是信号。

第二步，查在册。把 adapter 的相邻帧列出来，逐个去 `jcmd <pid> Compiler.codelist` 里查，查不到 nmethod 的方法才是候选。名字匹配会被同名桥接方法骗，最终要回 class 文件。

第三步，量字节码。解析 Code 属性拿 `code_length`，超过 8,000 就是它。三个判据全满足才算，缺一个都不算。

这套判据在四组配置上验过：A 组稳态最低 3.39%，报 SUSPECT；B、C、D 三组都是 0.00%，报 CLEAN。

反面案例比正面更有用。deopt 回解释器、还没编译的普通方法都会产生这个帧，只看一帧就下结论必然误报。1% 这个阈值来自这次负载，业务不同要自己调。

### 能登录机器的话，async-profiler 直接给答案

这三步要连上进程（`jcmd`），也要拿到 class 文件。两样都在手上的时候，还有一条更直接的路：加 `--ann` 采一次，让 profiler 自己说。

官方描述是：`Annotate JIT compiled methods with _[j], inlined methods with _[i], interpreted methods with _[0] and C1 compiled methods with _[1].`

`_[0]` 是解释执行，`_[1]` 是 C1 编译，`_[j]` 是 C2 编译，`_[i]` 是被内联。同一段描述最后还有一句：`FlameGraph and Tree view will color frames depending on their type regardless of this option.` HTML 和树视图按帧类型着色，跟加不加这个参数无关。

同一个方法，两个配置在带标注的导出里差别是这样的：

```
bench/w800/Loop.main_[1];bench/w800/Row.writeTo_[0];I2C/C2I adapters
bench/w800/Loop.main_[1];bench/w800/Row.writeTo_[j];I2C/C2I adapters
```

默认那组 `Row.writeTo` 这一帧标 `_[0]`，样本 611 个；翻转开关后同名方法标 `_[j]`，336 个。方法是同一个，只是这次它编译过了。

不看标注，看颜色也行。async-profiler 的 HTML 图例把七种帧分开：

| 类型 | 颜色 |
| --- | --- |
| Kernel | `#e17d00` |
| Native | `#e15a5a` |
| C++ (VM) | `#c8c83c` |
| Java compiled | `#50e150` |
| Java compiled by C1 | `#cce880` |
| Inlined | `#50cccc` |
| Interpreted | `#b2e1b2` |

浅绿色那片就是解释执行。把两组各 8 秒的整份采样按栈顶帧分类：

| 栈顶帧类型 | 默认（不编译） | 翻转（编译） |
| --- | --- | --- |
| interpreted `_[0]` | 5,330（65.75%） | 1（0.01%） |
| C1 compiled `_[1]` | 1,446（17.84%） | 5,007（62.00%） |
| C2 compiled `_[j]` | 647（7.98%） | 1,756（21.74%） |
| inlined `_[i]` | 221（2.73%） | 1,202（14.88%） |

![默认那行整片浅绿，翻转之后只剩一个样本](/media/posts/huge-method-adapter/HugeMethod_-53716f68.png)

默认那组 8,107 个样本里，三分之二停在解释执行的帧上；翻转之后 8,076 个样本里只剩 1 个。一块很宽的浅绿，就是一批方法还在解释执行，连 adapter 这个间接线索都不用找。

平台上的图看不到这些，聚合和对比的代价就是用掉了这层信息。手里有原始输出的时候，先看颜色，再看宽度。

编译门槛不看你被调用了多少次，只看你有多大。
