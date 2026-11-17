---
title: "JDK 8 的profiling会触发进程crash，社区无修复，建议升级jdk"
slug: jdk8-profiling-crash
date: 2026-11-07
category: "CPU 与采样分析"
tags:
  - "JVM"
  - "JFR"
  - "火焰图"
  - "排障"
summary: "两次 profiling 崩溃都崩在 libjvm.so 里：async-profiler 和 JFR 都在 JVM 的过渡状态上踩了空指针。三处修复在 JDK 17、11 上都有，JDK 8 上一处都没有。"
---

那份 hs_err 出现在凌晨。

一个 Spark 任务的 Executor 挂了，机器上留下几十兆日志。前面几千行都是正常的 GC 记录，翻到最底下才看见那行 `SIGSEGV (0xb)`。调度器把任务拉起来接着跑，第二天早上看结果，数据是全的，只有中间那十几分钟空着。

集群上装了 Pyroscope 的 agent，每半分钟抓一次火焰图。崩的那一次，正好是它去 dump 的时候。这台机器 325 秒里做了 82 次 Full GC，堆和 Metaspace 一直在反复收拾，agent 就在这个节奏里反复调 `AsyncProfiler.stop()`。最后那次，没回来。

JDK 8u392，开着 CMS 和类卸载。栈长这样：

```
SIGSEGV (0xb) at pc=0x00007fa6805544c2
Problematic frame:
V  [libjvm.so+0x7924c2]  oopDesc::is_a(Klass*) const+0x22

V  [libjvm.so+0x7924c2]  oopDesc::is_a(Klass*) const+0x22
C  [libasyncProfiler.so+0x37301]  Recording::writeCpool(Buffer*)+0x2041
C  [libasyncProfiler.so+0x3922d]  Recording::finishChunk()+0x65d
C  [libasyncProfiler.so+0x39718]  FlightRecorder::stop()+0xa8
C  [libasyncProfiler.so+0x39af5]  Profiler::stop(bool)+0x1e5
j  one.profiler.AsyncProfiler.stop0()V+0
```

栈顶那一帧是 `oopDesc::is_a`，读对象头做类型判断，它下面五层全是 profiler。看到这个组合，第一反应很自然：第三方 profiler 埋的雷，那就别用它。

于是 agent 摘了，改用 JDK 自带的 JFR。采样、线程、锁都能录，`jcmd` 一条命令开录制，机器上不用再挂别的库。换上之后跑了一段时间，又没了。

第二次崩得更干脆：没有 dump 失败，没有异常栈，整个进程直接 crash。工具没挂，进程没了，留下的只有一份 hs_err。

这次的栈和 OpenJDK bug 库里那条一模一样。bug 里的记录更全，连 gdb 展开的关键帧都在，讲的时候就直接用那份（报的是 11u，明确写了 8 和 17 一样受影响）：

```
V  [libjvm.so] java_lang_Thread::thread_id(oopDesc*)+0xf
V  [libjvm.so] JfrCheckpointThreadClosure::do_thread(Thread*)+0x2f5
V  [libjvm.so] Threads::threads_do(ThreadClosure*)
V  [libjvm.so] JfrThreadConstantSet::serialize(JfrCheckpointWriter&)
V  [libjvm.so] JfrTypeManager::write_safepoint_types(JfrCheckpointWriter&)
V  [libjvm.so] JfrRecorderService::safepoint_write()
V  [libjvm.so] VM_Operation::evaluate()
```

VMThread 在安全点里写 checkpoint 的类型常量池，遍历线程的时候挂了。gdb 展开关键帧，`this=0x0`，`addr=0x28`。十进制 40，正好是 `java.lang.Thread.tid` 的字段偏移。基数 0 加偏移去做 load，就是拿 NULL 当对象用。排掉内存踩踏和野指针之后，解释只剩一个：有人把空指针传进去了。

![两起崩溃的栈帧归属：栈顶看起来在 profiler 里，真正崩溃的帧都在 libjvm.so](/media/posts/jdk8-profiling-crash/JDK8Prof_-62085627.png)

两次尝试，两个工具，两根栈。崩点一帧都没落在工具自己的逻辑上，全在 `libjvm.so` 里。

## 一、两条路，崩在同一个动作上

两种 profiling 的实现路子差得挺远。

async-profiler 把采样拿到的 `jmethodID` 交回 JVM，让 JVM 告诉它这个 ID 对应哪个方法，再自己拼成火焰图。JFR 不用问谁，它本身就在 JVM 里，写 checkpoint 的时候直接遍历线程链表、类加载器、方法表。

路子不同，可两条路都要在同一个时刻干同一件事：把正在跑的状态抄一份出来。抄的时候得读一大批引用，方法 ID、Class 镜像、线程的 Java 对象。这些引用平时都是好的。

麻烦在于 JVM 里有一类中间状态：引用已经交出去了，它指向的东西却还没准备好，或者已经被处理掉了。两次崩溃都落在这类状态上，栽的地方也一样，都在"抄"这个动作里。

## 二、第一条路：profiler 回来问 JVM

`jmethodID` 是 JVMTI 和 JNI 暴露给外部的方法句柄，本质是 `Method*` 的一个间接槽位。槽位放在类的缓存里，由 `ClassLoaderData`（下称 CLD）管着。

规范写得很清楚：类一旦卸载，它名下的 `jmethodID` 立刻失效，后面谁再拿它调 JVMTI，都该收到 `JVMTI_ERROR_INVALID_METHODID`。

修之前，这件事被拆成了两半。类卸载和槽位清理不在同一个时刻发生：

1. GC 判定某个类不再存活，标为已卸载；
2. 该类的 `java.lang.Class` 镜像变成垃圾，内存可以被回收，也可以被别人覆写；
3. 过一阵子 CLD 被析构，这时候才真正把 `jmethodID` 槽位清空。

第 2 步和第 3 步之间留着一段空档。空档里的 `jmethodID` 没被置空，也没被标成失效，JVMTI 那边完全看不出它已经死了。

profiler dump 的时候要把采样期间的 `jmethodID` 还原成方法名，走的是三步 JVMTI 调用。这三步在空档里全部"成功"了。

**第一步，前置校验放行。** async-profiler 有个 `isStaleMethodId`：

```cpp
static bool isStaleMethodId(jmethodID id) {
    if (!_can_dereference_jmethod_id) return false;
    VMMethod* vm_method = *(VMMethod**)id;
    return vm_method == NULL || vm_method->id() == NULL;
}
```

它查的是"`Method*` 这条路断没断"。空档里 `Method*`、`ConstMethod`、`ConstantPool`、holder 上的缓存全都好好的，`id()` 返回非空，判定有效，放行。

**第二步，拿到一个已经死掉的镜像。** `GetMethodDeclaringClass` 只是从 `Method` 里取出 holder 的 `java_mirror` 字段，它不做存活性检查。这个 `jclass` 局部引用就这么交出来了。

**第三步，对死对象做类型校验。** `GetClassSignature` 要先确认传进来的是 `java.lang.Class`，于是执行 `k_mirror->is_a(Class_klass)`，去读对象头里的 `Klass*`。那块内存已经被回收或者覆写，读出来不是合法指针，再解一次就是 SIGSEGV。

三步单独看都合理，串起来就出事，出在中间那段空档上。

现象上有个容易迷惑人的地方：同一个进程可能一连几天不出事，重启换台机器又崩了。撞不撞上取决于那次 dump 正好赶上哪一批类刚被卸载、CLD 还没析构，跟机器配置关系不大。

但这段空档并不窄。8268364 的回移植 PR 里带了个复现器：`javac` 编译一个反复生成、丢弃类的 `Main`，挂上一个小 JVMTI agent，开启 CMS 和类卸载，跑起来 1 秒左右就崩；打上补丁就正常。1 秒的意思是，它不属于那种要跑几天才撞一次的竞态。生产环境里撞得慢，是因为 dump 频率低、动态类生成没那么密，窗口本身一直都在。

同一个根因还有个变体。`GetMethodDeclaringClass` 交出来的是 JNI 局部引用，指向已死对象，GC 遍历句柄表的时候一样会踩到。这种崩法栈里一帧 profiler 都看不到，表面上就是 GC 线程自己崩了。

profiler 自己补过两次，方向也能说明问题：

| 提交 | Issue | 做了什么 | 起始版本 |
| --- | --- | --- | --- |
| `ff0d86b` | #831 | 解析前先检测 `jmethodID` 是否失效，失效就输出 `stale_jmethodID`，不再调 JVMTI | 3.0 |
| `b9a3737` | #981 | 拿到 `GetMethodDeclaringClass` 后立即 `DeleteLocalRef`，不让死镜像的局部引用在整个 dump 期间堆积 | 4.0 |

为什么还是挡不住？#831 的前提是 `Method` 那条路断了，空档里路是好的，检测会放行。#981 缩短的是局部引用的存活时间，治的是上面那个 GC 线程变体，管不到 `GetClassSignature` 自己去解引用死镜像。

两个补丁动的是撞上窗口的概率，窗口还在。

还有个更常见的误判：换输出格式。既然崩在 JFR writer 里，改成 `collapsed`、`flamegraph` 这类文本格式，总该绕过去了吧。

绕不过。文本格式解析方法名走 `frameName.cpp` 的 `FrameName::javaMethodName()`，和 JFR 路径的 `Lookup::fillJavaMethodInfo()` 一步对一步：

![两条解析路径的每一步都一样：换输出格式改变的只是写文件的样子](/media/posts/jdk8-profiling-crash/JDK8Prof_-c8367017.png)

同一批 `jmethodID`，同一组 JVMTI 调用，同一个 dump 时刻。变的只是 hs_err 里印出来的函数名。

`mcache` 也一样，默认关着，就算开了，第一次解析仍然要调 JVMTI。降低采样频率同样没用，崩在 dump 阶段，不在采样阶段。真正该调的是 dump 间隔。

## 三、第二条路：JFR 自己写 checkpoint

回到那根 `JfrCheckpointThreadClosure::do_thread` 的栈。这一起更彻底，从崩溃帧一路到 VMThread，没有一帧第三方库。它在 11u 上以 11.0.21 报出，11.0.24 修掉，受影响的版本包含 8 和 17。

JNI 调 `AttachCurrentThread` 之后，JVM 做的事分成三步：

1. 建一个 `JavaThread`，状态置 `is_attaching_via_jni`；
2. `Threads::add` 把它加进全局 `ThreadsList`；
3. 继续初始化，调 `allocate_threadObj()` 填上 `_threadObj`。

第 2 步和第 3 步之间又是一段空档。这期间线程**已经在全局链表里了**，可它的 Java 层对象还不存在。

JFR 的 safepoint 操作要是正好在这个时刻写 checkpoint，`Threads::threads_do()` 遍历链表，对每个 `JavaThread` 调 `do_thread()`，里面读 `java_lang_Thread::thread_id(jt->threadObj())`。`_threadObj` 是 NULL，基数 0 加偏移 40，又回到那个 `addr=0x28`。

hs_err 里干活的线程是 VMThread，业务侧看到的只是一次重启。这一起的窗口比第一起窄得多，从进链表到填对象是微秒级的事，官方是在 RunThese24H 那种 24 小时压力测试里碰到的，日常负载下可能很久都不出现。只要开着 JFR 录制就有机会，而队列、连接池这类短命线程多的地方，attach 的频率天然更高。

修复是一行：

```diff
-    _writer.write(java_lang_Thread::thread_id(jt->threadObj()));
+    _writer.write(jt->threadObj() != NULL ? java_lang_Thread::thread_id(jt->threadObj()) : 0);
```

读不到就写 0，不崩。语义上这个线程的 `javaThreadId` 记成 0，属于信息缺失，不算信息错误，JFR 解析侧能接。

同一个函数的下一行 `JfrThreadGroup::thread_group_id(jt, ...)` 有一模一样的解引用风险，由另一个 issue（JDK-8276125）修。这条修复链在三处各修一半，凑齐才算完。

## 四、同一个形状

两个 bug 摆在桌上，形状是一样的：

![两道缝，同一种形状：对象或线程已经进入全局可见的结构，自己的字段还没初始化完，遍历者假定它已经完整](/media/posts/jdk8-profiling-crash/JDK8Prof_-e3c86bd1.png)

**对象或者线程已经进了全局可见的结构，自己的字段还没初始化完，遍历的人默认它已经完整。**

safepoint 里要遍历全量结构的地方不少，线程链表、CLD 图、`jmethodID` 表。每一处都得假定表里的元素可能停在任意过渡态。哪一处少判一个空，哪里就是一条能杀掉进程的缝。

对使用者来说这里没有操作空间。你没法靠"用得更小心"绕开它，因为你不知道它什么时候张开。dump 频率低、动态类生成不密，只是撞上的次数少。

## 五、修复是有的，8 上没有

到这里很自然会想：那就打补丁。两个问题都有现成的修复，代码量加一起不到三十行。

第一个问题的修复本体小得惊人。`Method::clear_jmethod_ids(this)` 这一句，从 `ClassLoaderData::~ClassLoaderData()` 挪到了 `ClassLoaderData::unload()`。两个文件，`+23 −16` 行。类卸载那一刻就把 `jmethodID` 置空，空档没了。第二个问题是一行判空。三处修改合计，比一个业务方法还短。

工具侧没法等价实现，这一点决定了只能等 JVM 自己修。profiler 拿不到"这个类已经死了"的信息，JVM 也没打算告诉它。JNI 规范写的是"类卸载后方法 ID 失效"，而失效从哪一步开始生效，取决于 JVM 在哪一步把槽位置空。

修复在 mainline 上落地是 2021 年 7 月，往下传导得很慢：

![同一个修复从 JDK 18 到 17.0.14 用了 3 年 2 个月，JDK 8 至今没有](/media/posts/jdk8-profiling-crash/JDK8Prof_-b2c8cef7.png)

| 版本 | 状态 |
| --- | --- |
| JDK 18（mainline） | 18 b05，2021-07-02 完成 |
| JDK 17 | JDK-8340207 回移植，17.0.14 拿到 |
| JDK 11 | JDK-8345479 回移植，11.0.27 拿到 |
| JDK 8 | Backports 字段里没有这一项 |

11u 的回移植申请里，理由写得很直接：

> The fix is required to allow JVMTI tools, especially profilers, to run safely with class unloading enabled.

回移植申请一般只谈风险和对 VM 的影响，很少点到具体某个第三方工具。这句直接写了 profilers。翻过来就是：这个问题不修，profiler 在开类卸载的环境里没有安全保障。

到 JDK 8 这一层，两个 bug 的处境是两种，结局一样：

![8u 的两次落空：一个没人提，一个提了没人批](/media/posts/jdk8-profiling-crash/JDK8Prof_8u-b661668f.png)

**8268364 压根没人提。** jdk8u-dev 仓库里搜不到任何相关的回移植请求，issue 的 Backports 字段也是空的。去翻 8u 的主干源码，`classLoaderData.cpp` 第 391 行，`Method::clear_jmethod_ids(this)` 还好端端地躺在 `ClassLoaderData::~ClassLoaderData()` 里面，一句都没挪。

**8322511 有人提了，但没批下来。** 2024 年 4 月 23 日，jdk8u-dev 上开了 PR #486，是一个干净回移植。当天就有 reviewer 确认 `/clean`，原话是"只是文件位置不同"；CI 上挂的那批，据 reviewer 判断是基础设施问题，加上一些看起来无关的测试失败。作者 6 月 26 日提交 maintainer approval 请求，PR 里写的是"用 JFR 时 JVM 会崩，回移植是干净的"。

然后就开始等。7 月 25 日问一次，9 月 2 日问一次，9 月 30 日又问一次，都是同一句话：谁能帮忙批一下。没人回。11 月 28 日，机器人按"8 周无活动"的规则把这个 PR 自动关掉了。到今天，8u 主干的 `jfrType.cpp` 第 108 行还是那句裸的 `_writer.write(java_lang_Thread::thread_id(jt->threadObj()))`，下一个问题 `thread_group_id` 那一半（JDK-8276125）同样没进来。

一个没人提，一个提了没人批。差别只在过程，结果都是：**JDK 8 上这三处修复，一处都没有。** 所以 8 上任何"继续做持续 profiling"的方案，底下都压着这两颗雷。它们不会因为换了工具、调了参数、改小了采样率而消失。

## 六、建议

真正能选的路只有三条，从最省事排到最不推荐。

![三条路：买确定性、自己扛维护、或者换个采法](/media/posts/jdk8-profiling-crash/JDK8Prof_-ccc76283.png)

**第一条，升级 JDK。** 换回来的是确定性：这一类崩溃直接不存在，不是概率上少一点，撞窗口、dump 频率、动态类密度这些变量全部退出考虑。三处修复一次拿全。

代价也明确。

**跨大版本的迁移工作量。** JDK 8 到 17 或 21，不是换个 `JAVA_HOME`。内部 API 的封装收紧了，依赖的 agent 和 native 库要跟着换，都得重新验证。

**版本号别选错。** 要拿到 8268364，最低得是 **17.0.14** 或 **11.0.27**。停在 17.0.9、11.0.20 这类早期更新上的，等于没升，修复还没进来。第二个问题（JDK-8322511）在 11 上是 11.0.24 起，17 走的是另一条合入路径。

排期落地之前，能做的只是把 dump 间隔拉长、把类卸载关掉。这几条的本质是把 profiling 变小，而 profiling 存在的意义，就是出问题时你人在现场看得见。换输出格式、降采样频率、开 mcache 都试过，无效。

**第二条，自己 backport，自己编 JDK 8。**

要搬的是三处：11u 的两个提交（`29f300eb` 修 `thread_id`、`a4a5c7fe` 修 `thread_group_id`），加上 18 b05 里把 `clear_jmethod_ids` 挪位置那个改动。

三处难度不一样。8322511 在 8u 上是干净移植，PR #486 只差文件位置，编译能过；8276125 在 11u 都要改写（11 不能用 `nullptr`，`Handle` 跟 `NULL` 比较要显式转换），搬到 8u 也得自己动手；8268364 是挪一句调用，改动最小，但要自己判断 8u 的 CLD 结构能不能直接套，8u 的 `ClassLoaderData` 还背着 Metaspace，跟 11 之后不是一回事。

真正的成本不在改代码，在之后的日子。你手上会多一个私有 JDK：每次 8u 季度更新都要 rebase 一遍，回归和压测得自己跑，线上出问题第一个被怀疑的也是"你们改过的 JDK"。集群够大、短时间确实升不动、内部又有人能兜住这份构建，这条路才划算。

**第三条，换 perf-map agent。不建议。**

它的思路是绕开 JVMTI 那条路：perf 直接采 CPU，JVM 把"代码地址到方法名"写成一份映射文件（`/tmp/perf-<pid>.map`），离线再用脚本把地址翻译成方法名。

麻烦出在翻译这一步。映射表只覆盖 JIT 编译过的方法，解释执行的、stub、正在去优化的代码都没有条目；方法内联之后，栈上根本没有 caller 那一帧，翻译出来只剩叶子。而一层层往上走靠的是帧指针，需要提前开启 `-XX:+PreserveFramePointer` 这个开关，并且解释器执行的代码不生效。

拿到手的火焰图会是这个样子：底下一大片 `[unknown]`，中间几段孤立的 Java 方法名，看不出谁调谁。线程池、动态代理、反射调用密集的服务里，unknown 的比例还会更高。

再叠两条运维上的麻烦。`perf_event_open` 在容器和云主机上常被 `perf_event_paranoid` 挡住，拿不到就是零数据；map 文件是每进程一份、每次 JIT 编译追加几行，长时间跑的服务得自己管增量和轮转。

更根本的一点：它换的是采样方式，JVM 里那两段空档还在原地，只是这个工具不去读那些引用。持续采集要的是"随时能看到"，这条路给的是"偶尔能拼出一张图"。

