---
title: "JVM 换上 LLVM：目前赢在广度，输在速度"
slug: jeandle-llvm-vs-c2
date: 2026-10-29
category: "JIT 与编译器"
tags:
  - "JVM"
  - "JIT"
  - "LLVM"
  - "编译器"
summary: "把 C2 换成 LLVM 的 Jeandle，我从源码构建出来实测：15 个基准几何平均只有 C2 的 72.8%，编译慢 49.9 倍，Renaissance 真实负载慢 2.80 倍。慢在哪能在 IR 里看到——回边上的 safepoint 轮询让 LLVM 放弃了向量化。多架构后端、优化管线、调试工具链这些广度收益已经拿到，速度还得等。"
---

2025 年 8 月，蚂蚁开源了 Jeandle（筋斗云）：把 HotSpot 里那个二十年没大动过的 JIT 编译器 C2 换成 LLVM。不是加个插件，是把 JVM 里最难动的地基挖掉重铺。

我从源码把它构建出来，和 C2 在同一把尺子上量，拿到三个数字：

15 个基准的几何平均是 C2 的 **72.8%**；编译速度**慢 49.9 倍**；Renaissance 真实负载上**慢 2.80 倍**。

只看这三个数，很容易判它不行。但收益和代价落在两个不同的地方。

广度那一边是真的拿到了：后端、优化管线、调试工具链直接站在 LLVM 上，RISC-V 这种新架构几乎不用自己写代码生成。速度这一边是目前的短板，而且能在 IR 里看到落后在哪一步。开头那三个数字的口径也不一样：0.728 说的是编译完之后谁更快，2.80 倍说的是在有限预热窗口里谁更快，中间隔着一个 49.9 倍的编译代价。

下面把两边都算一遍。自测数字来自我构建的那份 JDK，引用的官方数字单独标注。

## 一、先把数据核对干净

后面的性能对比建立在一个前提上：编译器真的换了，结果也没算错。

**编译器归属。** 用 `-XX:+LogCompilation` 解析每条 nmethod 的 `compiler` 字段：

| 配置 | 由 `c2` 编译 | 由 `jeandle` 编译 |
| --- | --- | --- |
| `-XX:-UseJeandleCompiler` | **190** | 0 |
| `-XX:+UseJeandleCompiler` | 0 | **73** |

零交叉。确实换了编译器，没有出现开关没生效、悄悄回落到 C2 的情况——测新编译器时这一步最容易自欺，先排掉。

**结果正确性。** 15 个基准各输出一个确定性 checksum，12 个整数类基准在 6 种配置下逐位一致。所以下面的性能差异只可能来自代码质量，不是算错了。

然后是主表（单位 ops/ms，越高越好）：

| 基准 | 解释执行 | C1 only | C2 only | Jeandle only | C2 分层 | Jeandle 分层 |
| --- | --- | --- | --- | --- | --- | --- |
| arith | 18.83 | 318.20 | **702.19** | 318.07 | 699.12 | 317.54 |
| longmix | 7.26 | 266.14 | 266.60 | **266.23** | **266.75** | 266.47 |
| fsum | 6.28 | 128.63 | **130.56** | 128.68 | 130.54 | 128.83 |
| fma | 38.31 | 781.12 | 790.13 | 782.24 | **791.39** | 782.51 |
| arrread | 2.52 | 94.24 | **195.36** | 93.82 | 195.14 | 94.70 |
| matmul | 0.87 | 18.92 | **50.96** | 18.82 | 50.73 | 18.74 |
| alloc | 8.11 | 986.93 | 1465.31 | 992.99 | **1465.77** | 1011.35 |
| allocal | 18.23 | 689.79 | 958.18 | 523.69 | **1083.49** | 691.69 |
| virt | 95.59 | 3081.33 | 4222.40 | 3126.74 | **4890.10** | 3174.02 |
| strcat | 1.43 | 192.89 | 204.50 | 191.63 | **206.09** | 202.05 |
| syncmono | 1.95 | 145.63 | 150.99 | 146.55 | 150.86 | **151.88** |
| recursion | 0.60 | 8.10 | 13.81 | 8.07 | **14.16** | 7.56 |
| hashmap | 0.30 | 9.52 | 13.84 | 9.33 | **17.40** | 13.09 |
| arraycopy | 2.73 | **10.32** | 8.62 | 9.16 | 10.28 | 10.27 |
| typecheck | 1.32 | **42.06** | 39.59 | 41.03 | 39.86 | 41.52 |

**几何平均：Jeandle / C2 = 0.728**（分层模式 0.733）。15 个基准里 13 个低于 C2，`arraycopy`（1.063）和 `typecheck`（1.037）反超。

![Jeandle 相对 C2 的吞吐分布：15 个基准里 13 个低于 C2、2 个反超；最低的五档是 matmul 0.369、arith 0.453、arrread 0.480、allocal 0.547、recursion 0.584，其中四个与 C1 差不到 1%；中间 8 个落在 0.674~0.999，属正常代差](/media/posts/jeandle-llvm-vs-c2/Jeandle_-_-C2-236100aa.png)

平均值底下藏着一个明显的结构：Jeandle 贴着 C1 的那几个基准，正好是丢分最狠的地方。

| 基准 | Jeandle 相对 C1 | C2 相对 C1 |
| --- | --- | --- |
| `arrread` | −0.45% | 2.07× |
| `arith` | −0.04% | 2.21× |
| `matmul` | −0.53% | 2.69× |
| `alloc` | +0.61% | 1.48× |
| `recursion` | −0.37% | 1.70× |

这五个基准上，Jeandle 几乎和第一级编译器 C1 重合，C2 却能拉开 1.48 到 2.69 倍。按 C2 相对 C1 的倍数排，它们刚好是全表最高的五档，第六名 `hashmap` 只有 1.45 倍，前后没有交错。也就是说，C2 多出来的那部分代码质量，Jeandle 一分没拿到。

先排除一种可能：是不是这些方法压根没编译、回落到了 C1？查编译日志，没有，它们确实由 `compiler='jeandle'` 编译。那就是代码本身的问题，第五节到 IR 里把原因挖出来。

真实负载上的 2.80 倍，同样不能读成"代码质量差 2.8 倍"。

Renaissance GPL 0.15.0 的 10 个基准，Jeandle 的耗时几何平均是 C2 的 **2.80 倍**，10 个无一例外。看 `scrabble` 的逐次耗时：

```
C2      :  954 → 413 → 391 → 381 → 399 → 376
Jeandle : 4674 → 2384 → 1499 → 1148 → 1082 → 1078
```

Jeandle 到第 4 次才平下来。前面几次差那么多，是方法还没编译完。编译慢 50 倍这件事，放进"每个基准只跑几秒"的窗口里，后果被放大了。

所以 0.728 和 2.80 都不能单独当结论。前者是"编译完之后谁更快"，后者是"在有限预热窗口里谁更快"，中间隔的是编译速度。你的服务多久重启一次、热点方法面有多宽，决定了站在哪一边。

## 二、它换掉的是什么：JVM 的地基之一

官方仓库的原话很朴素：Jeandle is a Just-in-Time compiler for Java. It is built on OpenJDK and leverages the LLVM compiler infrastructure to generate machine code.

拆开就是一条流水线：**Java 字节码 → LLVM IR → LLVM 优化器 → LLVM 后端 → 机器码**。

关键是它在构建产物里的默认状态：`-XX:+UseJeandleCompiler` 的默认值就是 `true`。你编译出来的那个 JDK，默认就用 LLVM 编译热点方法。这是接管，不是旁路。

![Jeandle 在 HotSpot 里的位置：字节码经复用的 Abstract Interpreter 翻成 LLVM IR，Jeandle 自己写 22 个 pass，其余交给 LLVM 标准流水线，产物写回与 HotSpot 共用的 Code Cache；解释器那一层完全没动](/media/posts/jeandle-llvm-vs-c2/Jeandle_-e104015f.png)

代码分两个仓库：

| 仓库 | 职责 | 基线 |
| --- | --- | --- |
| `jeandle-jdk` | 编译器前端、与 JVM 的集成、构建脚本 | OpenJDK **21** |
| `jeandle-llvm` | IR 优化、代码生成 | LLVM **22.0.0git** |

构建时用 `--with-jeandle-llvm=<dir>` 把两者接起来。两个仓库外加一个安装路径，这个做法本身就说明了它的定位：不把 LLVM 塞进 JDK 源码树，而是把它当上游依赖用。

### 一次方法编译怎么走完

官方 `system-design.md` 给了五步：

1. 编译线程从任务队列取出任务，调用 `JeandleCompiler::compile_method`；
2. 字节码经 **Abstract Interpreter** 翻译成 LLVM IR；
3. 定制优化器对 IR 做优化；
4. IR 交给 LLVM 后端生成目标代码；
5. 返回的二进制被打解析、重定位，写进 HotSpot 的 **Code Cache**。

流程里有三个点决定了 Jeandle 的行为为什么"像 HotSpot"：

**解释器没被换掉。** HotSpot 原生的解释器照旧干活，Jeandle 只接管"方法变热之后"这一层。方法不热就解释执行，热了才走上面那条流水线。所以它的启动行为和原来的 HotSpot 一致，慢的那一半没被挪动。

**复用了 HotSpot 自己的 Abstract Interpreter。** 这个组件本来是给 C2 解析字节码用的，负责维护操作数栈、局部变量表、类型状态。Jeandle 让它改吐 LLVM IR。前端没有重写，这是"两仓库"设计能站住的前提：字节码语义这块最难的活，直接站在 HotSpot 二十年的实现上。

**Code Cache 与 JVM 完全共用。** 编译产物照样进 HotSpot 的代码缓存，被 JVM 的管理逻辑（清理、栈上替换、去优化）当作一等公民。出问题时能被 JVM 原有的机制兜住，它不是挂在旁边的一个旁路。

### 和现有 JIT 摆在一起

| 编译器 | 实现基础 | 定位 |
| --- | --- | --- |
| C1 | C++ / HotSpot 自研 | 编译快、优化浅，分层编译第一级 |
| C2 | C++ / HotSpot 自研 | 峰值性能，HotSpot 的主力"重"编译器 |
| Graal | Java（自举） | 多语言、AOT、可插拔 |
| **Jeandle** | C++ 前端 + LLVM 后端 | **借 LLVM 的优化器与多架构后端** |

顺带说清一件事：一提"新的 JVM JIT"很多人先想到 Graal，但这是两条完全不同的路。

| | Graal | Jeandle |
| --- | --- | --- |
| 编译器用什么写 | Java（自举） | C++ 前端 + LLVM |
| 怎么接进 HotSpot | JVMCI（编译器接口） | 直接接管编译任务 |
| 优化器 | 自研 Graal IR | LLVM 优化器 |
| 后端 | 自研（x86-64 / AArch64） | LLVM 后端 |
| 进场要会什么 | Java + 编译原理 | LLVM IR 与 Pass 机制 |

Graal 赌的是"**用 Java 能写出足够好的编译器**"，顺带把多语言和 AOT 都包进来；Jeandle 赌的是"**编译器这事别再自己写一遍**"。两条路给出的是同一个问题的两个答案：JVM 里那块编译器，还要不要自己写。

## 三、为什么非得是 LLVM：一笔二十年的账

### C2 能打，但太贵

C2 是一台极其精密的机器，也是一笔极其昂贵的资产。它的每一层都是自研：

- **自研 IR**：Ideal Graph，一种 Sea of Nodes 变体，数据依赖和控制依赖不画在同一个框里，调度器自由度极大，看懂它的人力成本也极大；
- **自研指令选择**：把 IR 图匹配成目标指令的模式匹配系统；
- **自研寄存器分配**：线性扫描 + 染色两套，按场景切换。

这些都和架构强绑定：每支持一个新指令集，三层都要再实现一遍。一个直观的例子：要让 HotSpot 支持 RISC-V，C2 的后端得从零写一套，不是配置一下就行的事。更根本的是，优化能力的天花板等于 HotSpot 团队的人力天花板。

### LLVM 刚好有

- **优化器**：GVN、SCCP、LICM、循环旋转/展开、自动向量化、别名分析、内联……被全世界的编译器研究者持续打磨；
- **后端**：x86-64、AArch64、RISC-V 等，`-DLLVM_TARGETS_TO_BUILD` 一个参数切换；
- **生态**：`opt`、`llvm-lit`、`FileCheck` 整套工具，加上围绕 LLVM 的大量人才与论文。

所以 Jeandle 声明支持 **Linux x86、Linux AArch64，RISC-V 进行中**。其中 RISC-V 那一条几乎不需要它自己写代码生成。

补一句严谨的：HotSpot 里除了 JIT 后端，还有解释器、汇编器、运行时桩等一堆东西要支持新架构。Jeandle 省下的是**编译器后端**这一块，不是全部。

### 但 LLVM 不懂 Java

这就是 LLVM 和 Java 之间的根本冲突：

| | LLVM 的默认世界 | Java 的世界 |
| --- | --- | --- |
| 对象 | 分配了就分配了 | 随时可能被 GC 回收 |
| 指针 | 看着没用就优化掉 | GC 时必须能枚举所有活引用 |
| 代码 | 编译完就不动了 | 会被去优化（deopt）、会被栈上替换（OSR） |
| 线程 | 没有"安全点"概念 | 随时可能被 JVM 叫停 |

**Jeandle 的主要工作量，就是在这两个世界之间修桥。** 它自己写了 **22 个 pass**，其余交给 LLVM 标准 pass。按要解决的问题分四类，工程量的分布就看出来了。

## 四、四座桥：让 LLVM 理解 Java

### 桥一：GC —— 用 statepoint 说清"这里的活引用是谁"

LLVM 默认假设程序没有 GC，会毫不客气地把"看起来没用了"的指针优化掉。但 Java 里一个局部变量可能就躺在栈上，同时被 GC 当成根；一旦优化掉，GC 扫栈时扫不到，对象会被错误回收。

LLVM 给的答案是 **statepoint**：`gc.statepoint` 标记"这里可能触发 GC"，并**显式列出**此处的活引用集合（gc-live）；GC 结束后对象可能被搬走了，被移动过的引用用 `gc.relocate` 修正。相当于在 IR 层把"哪些引用是活的"变成编译器可以检查的显式契约，而不是靠约定。

Jeandle 用 `InsertGCBarriers` 插入这些结构，再调用 LLVM 标准的 `RewriteStatepointsForGC` 完成改写。

这层压得有多实，看测试目录就知道：`TestDerivedOop`（派生指针）、`TestCardTableBarrier`（卡表屏障）、`TestReferenceGetDuringConcMark`（并发标记期间读引用）、`TestConcurrentGCBreakpoints`——**全在测"编译出来的代码和并发 GC 能不能安全共处"**。

### 桥二：Safepoint —— JVM 要"处处能停车"

GC、去优化、偏向锁撤销都要求所有线程停在安全点。落在编译代码里，就是循环体里得周期性插 safepoint poll。否则一个跑不出来的长循环，能把整个 JVM 卡死在等它停车上。

无脑插 poll 会拖慢热循环。C2 的老办法是 loop strip mining：把循环拆成"内层不带检查的快循环 + 外层负责检查的慢循环"。Jeandle 在 IR 层把这件事重做了一遍，四个 pass 一起上：

| pass | 干什么 |
| --- | --- |
| `SafepointPollElimination` | 消除冗余的 poll |
| `SafepointStripMining` | 循环条带化，把 poll 从内层提到外层 |
| `SafepointCoverageVerifier` | 反向验证："该有 poll 的地方是不是都有" |
| `SafepointUtils` | 公共设施 |

特意做一个 **Verifier** 是有原因的：safepoint 漏插属于"平时没事、出事就挂死在 GC 里"的 bug，只能靠工具兜住。

### 桥三：类型 —— 一边是编译期，一边是运行时

LLVM 眼里只有 i32/i64/指针/结构体，不知道"这个引用实际是 Dog 而不是 Animal"。而 Java 性能的大头恰恰在这里：checkcast 能不能删、虚调用能不能变直接调用。

| pass | 作用 |
| --- | --- |
| `RecoverTypeInfo` | 从 IR 里恢复 Java 类型信息（流水线第一个优化 pass） |
| `TypeCheckElimination` | 消除被证明冗余的 `checkcast` / `instanceof` |
| `CHADevirtualization` | 类层次分析，虚调用变直接调用 |
| `ProfileDevirtualization` | 按运行时 profile 做单态 / 双态 / 主要接收者分发 |
| `JeandleNarrowOopMarker` `ExpandNarrowOopCast` | 压缩指针在 IR 层的标记与展开 |

这里有个特别能说明问题的真实取舍。实现**部分逃逸分析（PEA）**时，作者在 PR 里写了这么一段：与原论文不同，我们**不**把部分逃逸的分配移动到它的逃逸点，因为那样做会导致我们无法正确构造 deoptimization 的 operand bundle。

说白了：论文里的做法能让优化更彻底，但一旦要把优化后的状态回滚（Java 要支持 deopt，必须能回滚），LLVM 的 IR 里没有"回滚点"这个概念，得自己造。造不出来，就只能少优化一点。

**在 LLVM 上做 Java 优化，难的不是把优化写出来，是写出来之后还得能后悔。**

### 桥四：语义 —— 异常、monitor、一堆 intrinsic

| pass / 组件 | 作用 |
| --- | --- |
| `JavaOperationLower` | Java 语义节点下降为 LLVM 操作 |
| `JavaOperationDeletion` | 删除冗余的 Java 语义节点 |
| `JavaOpLengthFolding` | 长度类操作折叠 |
| `jeandleExceptionHandlerTable` | 异常处理表 |
| `JeandleInliner` | 自带内联策略（`default` / `accessors-only` / `off`） |
| `ArrayCopySpecialization` | `System.arraycopy` 特化 |
| `ConstantFieldFolding` `RepeatedConstantFolding` | 常量字段与重复常量折叠 |
| `TLSPointerRewrite` | 线程本地存储指针改写 |
| `PartialEscapeTransform` `PartialEscapeIterative` | 逃逸与分配优化 |

monitor 那块值得单说：`Object.notify` / `notifyAll` 做成 intrinsic 时，**复用了 HotSpot 自己的 `quick_notify` 快路径**，只在快路径失败时才走 `ObjectSynchronizer::notify()`。这个选择很务实：锁的语义极其微妙，与其在 IR 里重造一遍，不如把 HotSpot 二十年的实现包一层。

这份 22 个 pass 的清单里，GC/safepoint 占 5 个、类型与虚调用占 4 个。这两类正是"静态编译器"和"动态语言"摩擦最大的地方，工程量押在这里不奇怪。

## 五、最硬的发现：慢在哪，IR 里写着

回到第一节那五个 Jeandle 贴着 C1 的基准。原因不在猜测里，在 IR 里。

用 `-XX:+JeandleDumpIR` 导出 `arrread`（int 数组求和，最容易被向量化的形态）：

| 项 | 优化前 | 优化后 |
| --- | --- | --- |
| IR 行数 | 1379 | **119**（缩到 8.6%） |
| `jeandle.safepoint_poll` | 5 | **24** |
| `gc.statepoint` | 0 | **14** |
| 向量类型（`<4 x i32>` / `<8 x i32>`） | 0 | **0** |

![IR 优化做了什么、没做什么：行数从 1379 压到 119（缩到 8.6%），safepoint 轮询从 5 处复制到 24 处、gc.statepoint 从 0 到 14，而向量类型优化前后都是 0](/media/posts/jeandle-llvm-vs-c2/Jeandle_IR_-97333721.png)

优化后的主循环体长这样（原文摘录）：

```llvm
bci_18_boundary_check_pass:                       ; preds = %bci_13
  %array_element_address = getelementptr inbounds nuw i32, ptr addrspace(1) %array_element_base, i64 %indvars.iv
  %9 = load atomic i32, ptr addrspace(1) %array_element_address unordered, align 4   ; 一次只读一个 i32
  %10 = add i32 %9, %2                                                                ; 标量累加
  %indvars.iv.next = add nuw nsw i64 %indvars.iv, 1
  %11 = load volatile i64, ptr addrspace(2) %.tls.ptr, align 8   ; 每次迭代都读 TLS 里的 safepoint 标志
  %12 = and i64 %11, 1
  %.not.i = icmp eq i64 %12, 0
  br i1 %.not.i, label %jeandle.safepoint_poll.exit, label %do_safepoint.i   ; 循环回边带条件分支
```

两件事同时成立：

1. **标量优化非常彻底**：1379 行压到 119 行，边界检查被提升成循环不变式（`boundary_check_pass` / `_fail` 在循环体外就判定了）；
2. **循环体一次只处理一个元素，而且回边上挂着 safepoint 轮询分支。**

第二件就是上不去的原因。LLVM 的循环向量化器有一条铁律：循环体里的内存访问要规整、控制流要干净。面对一个回边带条件分支、循环体里还有 volatile 读的循环，它**直接放弃向量化**，哪怕整数求和完全满足结合律，哪怕 AVX2 就在那等着。

![两种 safepoint 轮询策略对照：Jeandle 每一轮迭代都读 TLS 标志并在回边做条件分支，循环向量化器放弃；C2 的 LoopStripMining 每 4 轮才轮询一次，内层循环干净，可以 4×i32 向量化](/media/posts/jeandle-llvm-vs-c2/Jeandle_IR_-safepoint-9a866c7e.gif)

C2 解决同一个问题用的是 `LoopStripMining`：把轮询提到外层，每 N 次迭代才检查一次，内层循环干净了就能向量化。

**Jeandle 也暴露了 `LoopStripMiningIter`（默认 1000），但实测完全不生效**：

| `LoopStripMiningIter` | arith | arrread | matmul |
| --- | --- | --- | --- |
| 0 | 319.80 | 92.24 | 19.07 |
| 100 | 320.17 | 93.39 | 19.00 |
| 1000（默认） | 320.01 | 92.78 | 18.99 |
| 100000 | 320.05 | 92.46 | 19.04 |
| **C2 对照** | **706.62** | **195.77** | **51.57** |

从 0 调到 100000，数值全在噪声区间里。

![五个基准上 Jeandle 与 C1 几乎重合（差 0.04%~0.61%）：归一化到 C2 = 1.00 后两组柱子等高，离 C2 的水平线还差一半](/media/posts/jeandle-llvm-vs-c2/Jeandle_-C1-4a472b51.png)

这大概就是官方 roadmap 里"Java 定制优化套件"要解决的问题。这份 IR 把两件事分得很清楚：标量优化已经吃到 LLVM 现成的红利，向量化还卡在它自己加的那个 safepoint 轮询上。

## 六、代价不止在吞吐

### 编译：慢 49.9 倍，但代码没变臃肿

| 指标 | C2 | Jeandle | 对比 |
| --- | --- | --- | --- |
| 编译方法数 | 160 | 122 | 0.76× |
| 编译字节码总量 | 15428 B | 5849 B | 0.38× |
| **编译速度** | **48781 B/s** | **978 B/s** | **慢 49.9 倍** |
| nmethod 代码大小 | 80592 B | 83112 B | +3.1% |
| nmethod 总大小 | 121568 B | 134576 B | +10.7% |

![Jeandle 编译流水线的耗时分解：5.980 秒里 LLVM Optimize 占 5.009 秒（84.0%），前端 Abstract Interpret 只占 0.014 秒，时间几乎都花在 LLVM 的优化流水线上](/media/posts/jeandle-llvm-vs-c2/Jeandle_-38f98101.png)

耗时分解（`-XX:+CITime`）：

```
  Total compilation time   :   5.980 s
    Jeandle Compile Time   :   5.961 s
       Abstract Interpret  :    0.014 s     ← 前端：复用 HotSpot 的 Abstract Interpreter
       LLVM Optimize       :    5.009 s     ← 84.0% 的时间在这一行
       LLVM CodeGen        :    0.805 s
       Finalize            :    0.012 s
    (Jeandle compilations  :    122)
```

**编译时间的 84% 花在 LLVM 的优化流水线上。** 这是"借 LLVM 优化器"这个选择的直接账单：换来第五节那种把 IR 压到 8.6% 的标量优化，代价是编译慢 50 倍。

生成代码的体积几乎没变（+3.1%），更重的优化没有换来更臃肿的机器码。

### 启动：慢 2.2 倍

| 配置 | `java -version` 中位数 | 进程峰值 RSS |
| --- | --- | --- |
| C2 only | **31 ms** | 431 MB |
| Jeandle only | **67 ms** | 393 MB |
| C2 分层 | **28 ms** | 553 MB |
| Jeandle 分层 | **68 ms** | 438 MB |

多出来的时间主要花在加载 `libLLVM.so`（LLVM 22 全量）上，翻倍多一点。峰值内存反而略低。

### 升温：C2 要 1~2 轮，Jeandle 要 3~5 轮

| 基准 | 后端 | 第 1 轮 | 到稳态 | 稳态值 |
| --- | --- | --- | --- | --- |
| matmul | C2 | 47.4 | 第 2 轮 | ≈49.5 |
| matmul | Jeandle | 7.7 | 第 3~4 轮 | ≈19.0 |
| arith | C2 | 742.1 | 第 2 轮 | ≈704 |
| arith | Jeandle | 181.7 | 第 5 轮 | ≈320 |
| virt | C2 | 4478 | 第 3 轮 | ≈4200 |
| virt | Jeandle | 676 | 第 3 轮 | ≈3200 |

升温慢和"编译慢 50 倍"是同一件事的两面：方法排队等编译的时间变长了，热点铺开的节奏就整体后移。对短命进程（命令行工具、短任务），这条比稳态差距更要紧，它们可能还没跑到稳态就结束了。

![Renaissance 10 个基准的逐次迭代耗时（各自归一化到末次迭代 = 1.00，对数轴）：C2 的几何平均第 2 轮就降到 1.16，Jeandle 还在 1.22，且 scrabble 要到第 4 轮才平下来](/media/posts/jeandle-llvm-vs-c2/Jeandle_Renaissance_-61a81002.png)

### 真实负载：Renaissance 上慢 2.8 倍

微基准是"同一段代码反复热跑"，预热条件过于理想。换成真实负载（Renaissance GPL 0.15.0，10 个基准，每个 6 次迭代，第 1 次剔除）：

| 基准 | 类型 | C2 稳态 | Jeandle 稳态 | 倍数 |
| --- | --- | --- | --- | --- |
| scrabble | 字符串/集合 | 392.1 | 1438.2 | 3.67× |
| chi-square | 统计（Spark） | 700.3 | 1977.5 | 2.82× |
| gauss-mix | 浮点矩阵 | 865.3 | 5743.8 | **6.64×** |
| log-regression | 浮点回归 | 1128.1 | 2798.8 | 2.48× |
| dec-tree | 决策树 | 1246.3 | 3071.3 | 2.46× |
| fj-kmeans | 并行聚类 | 4731.0 | 7658.3 | 1.62× |
| page-rank | 图（Spark） | 4804.4 | 8982.7 | 1.87× |
| als | 矩阵分解 | 4872.8 | 18880.0 | 3.87× |
| naive-bayes | 分类 | 6937.6 | 14955.4 | 2.16× |
| movie-lens | 推荐（Spark） | 9228.9 | 25551.5 | 2.77× |

单位 ms，越低越好。**几何平均 2.80 倍**（加速比 0.357×），10 个无一例外。

还有一处对比有意思：微基准上 `strcat` 只慢 6%，而真实负载里的 `scrabble`（同样字符串/集合密集）慢 2.87 倍。差别在调用面：微基准反复热的只有一个方法，真实应用要让成百上千个方法挨个过那条慢 50 倍的流水线。

### 一个开关验出真假

单独写了个测试，用 `getCurrentThreadAllocatedBytes()` 精确统计**当前线程**的分配量，分"对象不逃逸"和"对象逃逸"两组：

| 配置 | 不逃逸的对象 | 逃逸对照组 |
| --- | --- | --- |
| C2 | **0 字节**（完全消除） | 32.02 B/次 |
| Jeandle（`JeandleDoPEA=true`） | **0 字节**（完全消除） | 32.02 B/次 |
| Jeandle（`-XX:-JeandleDoPEA`） | **64,000,000 字节**（32.00 B/次） | 32.02 B/次 |

三组的 checksum 完全一致。

开关一关，同一段代码立刻从零分配变成每次 32 字节。这组数据同时回答了两个问题：**Jeandle 的逃逸分析确实在干活**，而且**测量方法本身没问题**。要是 `getCurrentThreadAllocatedBytes()` 读不准，三档数字不可能分得这么齐。

### 开关量化表（官方未公布）

`-XX:+PrintFlagsFinal` 里有一批 Jeandle 专有开关。逐个关掉，跑 8 个相关基准（ops/ms）：

| 配置 | alloc | syncmono | virt | strcat | arrread | matmul | typecheck | hashmap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **默认全开** | 1013.97 | 149.57 | 3060.05 | 197.30 | 95.98 | 19.07 | 41.89 | 9.31 |
| 关 `JeandleDoPEA` | **185.92** | **8.51** | 3070.14 | 162.90 | 95.97 | 19.03 | 35.57 | 9.24 |
| 关 `JeandleEliminateLocks` | 1009.62 | **8.50** | 3061.47 | 195.28 | 96.20 | 19.16 | 41.86 | 9.51 |
| 开 `JeandleUseHotspotIntrinsics` | 1000.17 | 149.85 | 3061.41 | 196.69 | 95.44 | 19.05 | 41.51 | 9.40 |
| 关 `JeandleUseProfiledVirtualCallDevirtualization` | 1009.21 | 149.70 | **240.03** | 194.93 | 95.60 | 19.07 | **131.99** | 7.62 |
| 关 `JeandleUseProfile` | 1008.52 | 150.56 | **834.12** | 196.70 | 95.80 | 18.46 | 40.99 | **6.13** |

![逐个关掉 Jeandle 专有开关对 8 个基准的影响：关 PEA 让 alloc 掉 82%、syncmono 掉 94%；关去虚拟化让 virt 掉 92% 却让 typecheck 涨 215%](/media/posts/jeandle-llvm-vs-c2/Jeandle_-_-02d3f2b9.png)

读出来的四件事：

1. **逃逸分析是 `alloc` 和 `syncmono` 的命脉**：关掉后 `alloc` 掉 82%、`syncmono` 掉 94%；整个进程的累计分配量从 **14810 MB 涨到 57084 MB（3.85 倍）**，GC 压力跟着走高。
2. **锁消除和逃逸分析在同一条链上**：单独关锁消除，`syncmono` 同样掉到 8.5。局部 `new Object()` 要先被判定为不逃逸，锁消除才有对象可消，两个开关都能掐断这条链。
3. **profile 引导的去虚拟化决定 `virt` 的生死**：关掉后 3060 → 240（**−92%**）。
4. **同一个开关在 `typecheck` 上翻了面**：关掉去虚拟化，它从 41.89 涨到 **131.99（+215%）**。profile 引导在那个场景给出了更差的代码。这种负收益在项目早期很常见，测到就记下来。

另外，`JeandleUseHotspotIntrinsics`（用 HotSpot intrinsic 而非 LLVM intrinsic）**几乎没有影响**（所有基准变化 < 2%）。

## 七、官方自己也画了边界

### 时间线与活跃度

| 项 | 值 |
| --- | --- |
| 仓库创建 | 2025-06-25 |
| 正式开源公告 | 2025-08-13 |
| 最近提交 | 2026-09（持续密集） |
| jeandle-jdk stars / forks | 482 / 139 |
| open issues | 83 |
| CI 覆盖 | `tier1_compiler_jeandle` + `tier1_gc`，GCC 10 |

一年做到这个活跃度，说明不是"开个源摆着"。

### 官方 PR 里的真实数据

以下来自合并 PR，属开发者自报，测试条件随附。

**① Profile 引导的虚调用去虚化（PR #586）**

在 **25 个 Renaissance 基准**上对比开关该优化，同一 NUMA 节点跑 5 次取后 3 次平均：21 个提升、4 个回退，**几何平均提升 10.86%**，总运行时间下降 **6.16%**。作者注明：个别回退在后续运行中不稳定，此前报告的 `philosophers` 8.42% 回退未能复现。

**② `Object.notify` / `notifyAll` intrinsic（PR #623）**

| 基准 | Jeandle | 关闭后 | 提升 | 达 C2 比例 |
| --- | --- | --- | --- | --- |
| `notifyOne` | 112.19M | 14.66M | **7.65×** | 95.68% |
| `notifyAll` | 112.20M | 14.72M | **7.62×** | 98.97% |

顺带有个发现：**C2 的 intrinsic 白名单里其实缺了 `Object.notify` / `notifyAll`**，属于社区实现的一个遗漏。

**③ `StringUTF16.getChar` / `putChar` intrinsic（PR #626）**

AArch64 release JDK，JMH 5 热身 / 8 测量 / 3 fork，单位 ns/op（越低越好）：

| 基准 | Jeandle 关 | Jeandle 开 | 改善 | C2 关 | C2 开 | C2 改善 |
| --- | --- | --- | --- | --- | --- | --- |
| `getCharDirect` | 1.130 | **0.831** | 26.5% | 1.358 | 1.081 | 20.4% |
| `putCharDirect` | 1.405 | 1.189 | 15.4% | 1.435 | **0.961** | 33.0% |

`getChar` 上 Jeandle 超过了 C2；`putChar` 还落后，作者归因于 **C2 的控制流更紧凑、safepoint/去优化布局更好**，并点明一个遗留问题：动态下标场景下的显式空检查还没被 `ImplicitNullChecksPass` 消掉。

作者在自己落后的那一项上，把原因点到了实现细节：控制流紧密度、safepoint 与去优化的布局、动态下标下的显式空检查还没被 `ImplicitNullChecksPass` 消掉。这种写法比只报提升幅度的 PR 有信息量。

### 已知短板（官方 `ProblemList-jeandle.txt`）

仓库里有份隔离测试清单，按根因分类，等于官方自己画的边界：

| 类别 | 说明 | 相关用例举例 |
| --- | --- | --- |
| **PGO / 去优化** | 缺少部分基于 profile 的优化，**无法触发 deoptimization** | `TestArrayCopyNoInitDeopt`、`Decompile`、`TestUnstableIfTrap` |
| **OSR** | 栈上替换未完成 | `BlackholeIntrinsicTest`、`HasCompiledCodeForOSRTest` |
| **逃逸分析** | 部分场景未覆盖 | `TestIterativeEA`、`MaterializeVirtualObjectTest` |
| **C2 专有** | 依赖 C2 特定输出（如 `PrintOptoAssembly`） | `TestBit`、`TestVolatilesG1/Parallel/Serial` |

对照 2026 年的 roadmap（Java 定制优化套件、intrinsic、OSR、G1 GC），这份清单基本就是"还没做完"的那一半。

### 想自己跑一遍

官方给了四步：拉 `jeandle-llvm` → 构建 LLVM 装到指定目录 → 拉 `jeandle-jdk` → `bash configure --with-boot-jdk=<JDK21> --with-debug-level=release --with-jeandle-llvm=<上一步目录>` 后 `make images`。产物在 `build/linux-x86_64-server-release/images/jdk/`。

三个坑：boot JDK 必须是 **21**；两个仓库**必须用同一个 debug level**（`Release` 配 `release`）；JDK 的 configure 需要 **X11 全套开发包**（`libXt-devel`、`libXrandr-devel`、`libXi-devel`……只装 `libX11-devel` 不够）。另外 `libjvm.so` 是**动态依赖** `libLLVM.so.22.0git`，分发时要带上这个 so。

跑起来就是加一个开关：`java -XX:+UseJeandleCompiler -jar app.jar`（默认已开），想回到 C2 对照就 `-XX:-UseJeandleCompiler`。

最值得试的是把 IR 挖出来看：

```bash
java -XX:+JeandleDumpIR -XX:JeandleDumpDirectory=/path/to/out \
     -Xcomp -XX:-TieredCompilation \
     -XX:CompileCommand=compileonly,ClassName::methodName ClassName
```

再加 `-XX:+JeandleRecordVMCallbacks` 会录下 VM 回调，之后可以用标准 `opt` 脱离 JVM 回放：

```bash
opt --jeandle --jeandle-vm-callback-log=path/to/log.cblog -S input.ll -o output.ll
```

**这条路把"JVM 里的编译器"变成了"一个能用 LLVM 工具链单独调试的东西"**。排查优化 bug 时，比在 JVM 里下断点舒服太多。

## 八、选型决策表：它现在能站在哪

前面所有实测和官方边界，最后落在两个问题上：你的场景吃不吃得到 LLVM 的长处，付不付得起它的代价。

**可以认真跟的场景：**

| 场景 | 依据 |
| --- | --- |
| 新架构上的 Java（RISC-V 等） | LLVM 后端是现成的，省掉整块代码生成的工程量 |
| 计算密集、循环向量化友好的热点 | LLVM 优化器的主场，但要等第五节那个向量化问题解决才有收益 |
| 想验证"LLVM 的优化在 Java 上值多少钱" | 目前唯一把 HotSpot 前端 + LLVM 后端打通的路 |
| 编译器技术学习 | 比读 C2 那套 20 年沉淀的代码库友好得多，且有 `opt` 工具链 |

**现在别碰的场景：**

| 场景 | 原因 |
| --- | --- |
| 生产环境直接替换 C2 | 一年期的项目 vs 二十年的 C2，成熟度差距摆在那 |
| 依赖 OSR / 深度 PGO 的应用 | 这两块在官方已知问题清单里 |
| 对启动/预热敏感的短命服务 | 启动慢 2.2 倍 + 升温要 3~5 轮，可能到死都没到稳态 |
| 要求"任何合法 class 文件都能跑" | 全量 bytecode 支持仍在收敛 |

中间的那一档是**长生命周期、热点方法面很宽的服务**（典型如常驻网关、中间件）。这类服务预热完就不重启，0.728 的稳态差距才是它要付的真实代价；但另一个方向的账更麻烦：`typecheck` 那种 +215% 的反转，放到生产网关上就是一次找不到原因的毛刺。对这类场景，每季度跟一次 release note，先跑影子流量，别急着切。

## 总结

**第一，Jeandle 的看点现在是"桥"，暂时还不是"快"。** 值得盯的是 statepoint、safepoint、类型、Java 语义这四座桥是不是真通了。桥通了，剩下的优化是堆人力往上加的事；桥不通，加多少都会在 deopt 和并发 GC 上翻车。

**第二，JVM 编译器的门槛被它拉低了一档。** 以前要碰 JVM JIT，得先把 C2 那套自研 IR 和寄存器分配啃下来；现在可以在 LLVM IR 这一层理解、实验、改。PR #586 里那句"因无法正确构造 deopt operand bundle 而放弃论文里的做法"，就是这条路走到一半的样子。

**第三，反哺可能比替换先落地。** "让 LLVM 支持带 GC 的语言运行时"这件事，Jeandle 走得比多数项目都深。它在 LLVM statepoint 上踩平的坑会回流到 LLVM 社区，也会被后来者直接拿走。

一年时间，从零到 Renaissance 上 10.86% 的几何平均提升，这个进度不慢；`ProblemList` 里那四类问题也写得清楚。广度上的收益现在就能兑现，速度上的差距得等 22 个 pass 之后的优化补齐。现阶段它更合适的身份是一个能跑起来的实验平台，不是一个能上线的编译器。

---

测试环境：Jeandle 基线 jeandle-jdk（JDK 21）+ jeandle-llvm（LLVM 22.0.0git，2026-10 实测 main 分支）；官方 CI 使用 GCC 10，支持 Linux x86 / AArch64，RISC-V 进行中。

数据来源（官方）：jeandle-jdk / jeandle-llvm 仓库文档（`getting-started.md`、`system-design.md`、`debugging-guide.md`、`jeandle-jdk-flags.md`、`jeandle-llvm-options.md`、`ProblemList-jeandle.txt`）与合并 PR（#586、#623、#626、#573）；性能数字为开发者在 PR 中自报，测试条件随附。

数据来源（自测）：自行构建的 jeandle-jdk（`21.0.7-internal-adhoc.root.jeandle-jdk`）+ jeandle-llvm（22.0.0git），对照系统 OpenJDK 21；测试机 4 核 / 7.4 GB / OpenCloudOS 8.10，gcc-toolset-11 + cmake 3.26.5，LLVM 与 JDK 合计构建约 1.5 小时。测量为时间驱动（每次固定 500 ms 统计操作数）、5 次重复取中位数、每配置独立 JVM 进程；15 个基准的整数类 checksum 在 6 种配置下逐位一致；编译器归属由 `-XX:+LogCompilation` 的 `compiler` 字段核验（190 vs 73，零交叉）；Renaissance 数据来自 renaissance-gpl-0.15.0。工程与原始数据：`drafts/jeandle-demo/`。
