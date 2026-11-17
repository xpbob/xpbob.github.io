---
title: "异步 GC 日志：把被 I/O 拖长的停顿还回去"
slug: async-gc-log-pause
date: 2026-10-18
category: "JVM 内存与 GC"
tags:
  - "JVM"
  - "GC"
  - "停顿"
  - "排障"
summary: "一次 Young GC 报 291 毫秒，CPU 统计却是 User=0.00s Sys=0.00s——时间全花在等 write 返回，而写日志的正是持有 safepoint 的 VMThread。-Xlog:async 把 I/O 交给专用线程，p99 从 299.74 ms 回到 0.56 ms；代价是缓冲满整段丢日志、kill -9 丢掉最后几秒、正常退出多等十几秒。"
---

今天解决了一个用户gc停顿时间长的问题，场景模拟如下：

一次 Young GC 报了将近 300 毫秒。同一条 GC 的 CPU 统计行是这样的：

```
GC(179) User=0.00s Sys=0.00s Real=0.29s
```

291 毫秒的墙钟时间，`User` 和 `Sys` 两项都是 0.00s，CPU 加起来不到 10 毫秒。也就是说，这 291 毫秒里 GC 线程几乎没执行任何指令。它在等。

GC 日志是 VMThread写出的，那次 `write(2)` 落在一条慢下来的管道、网络盘或者日志代理后面时，等 I/O 的时间就原封不动地记进了 GC 停顿。

这篇文章顺着一条线走：先看现象长什么样，再看 OpenJDK 给出的方案、这套方案在源码里怎么落地、落地方式带来了哪些局限，最后是参数和场景。源码以 openjdk/jdk 的 master 分支为准（2026 年 10 月）。

## 一、现象：291 毫秒里 GC 一点活都没干

先看一次没出问题的 Young GC。盘是健康的，日志开到 `-Xlog:gc*`，一次普通 GC 完整长这样（14 行）：

```
GC(180) Pause Young (Normal) (G1 Evacuation Pause)
GC(180) Using 3 workers of 4 for evacuation
GC(180)   Pre Evacuate Collection Set: 0.08ms
GC(180)   Merge Heap Roots: 0.03ms
GC(180)   Evacuate Collection Set: 0.06ms
GC(180)   Post Evacuate Collection Set: 0.14ms
GC(180)   Other: 0.05ms
GC(180) Eden regions: 75->0(75)
GC(180) Survivor regions: 1->1(10)
GC(180) Old regions: 3->3
GC(180) Humongous regions: 0->0
GC(180) Metaspace: 85K(320K)->85K(320K) ...
GC(180) Pause Young (Normal) (G1 Evacuation Pause) 76M->1M(128M) 0.470ms
GC(180) User=0.00s Sys=0.00s Real=0.01s
```

这 14 行不是 GC 收工后顺手补的一句注脚。用 strace 数过：每一次 Young GC 的 14 行，就是 14 次独立的 `write(2)`——写文件和接管道都是严格的 1 行对 1 次（273 次 GC × 14 行 = 3822 次 write，没有任何一次 write 合并了两行）。原因是每条消息写完都要 `fflush()` 一次，stdio 那 4 KB 缓冲根本来不及把消息攒成批。唯一的例外是打到 stderr：stderr 不带缓冲，一次日志会被拆成 6 次 write，4 个装饰器各一次。

从 G1 侧看，这 14 行分三批写出：`GCTraceTime` 在 pause 开始时打出标题行；pause 内部依次打出 worker 数、5 个阶段耗时、4 个 region 计数和 Metaspace 行；最后 `GCTraceTime` 析构打出带总耗时的那行，`GCTraceCPUTime` 析构打出 CPU 行。前 12 行都写在 pause 的计时窗口之内，它们的耗时会计进这次停顿。

所以这一次停顿的总时间，其实是两块拼起来的：

- GC 真正干活的部分：5 个阶段合计 **0.36 ms**（0.08 + 0.03 + 0.06 + 0.14 + 0.05）
- 把这些过程写出去的部分：其余约 **0.11 ms**

盘健康的时候，第二块小到可以忽略，但它一直在账上。写日志本来就是 GC 流程里的一个环节，只不过平时快得让你注意不到。

再看同一份负载、让那次 `write(2)` 慢下来之后的同一次 GC。还是 14 行，5 个阶段的耗时合计还是 0.36 ms，堆变化还是 76M->1M：

```
GC(179)   Pre Evacuate Collection Set: 0.07ms
GC(179)   Merge Heap Roots: 0.03ms
GC(179)   Evacuate Collection Set: 0.06ms
GC(179)   Post Evacuate Collection Set: 0.16ms
GC(179)   Other: 0.04ms
GC(179) Metaspace: 85K(320K)->85K(320K) ...
GC(179) Pause Young (Normal) (G1 Evacuation Pause) 76M->1M(128M) 291.526ms
GC(179) User=0.00s Sys=0.00s Real=0.29s
```

**流程一点没变，总时间从 0.470 ms 变成了 291.526 ms。**

多出来的 291 ms 卡在哪儿，日志自带的时间戳指得很准：

```
[1.446s][info][gc,metaspace] GC(179) Metaspace: 85K(320K)->85K(320K) ...
[1.737s][info][gc          ] GC(179) Pause Young ... 76M->1M(128M) 291.526ms
[1.737s][info][gc,cpu      ] GC(179) User=0.00s Sys=0.00s Real=0.29s
```

前 11 行都还停在 1.446 s，第 12 行直到 1.737 s 才写出去。中间那 291 ms，没有产生任何一行新日志，也没有任何计算——VMThread 停在了一次 `write()` 里，等它返回。作为对照，健康组在同一位置相邻两行的时间间隔中位数是 0 ms，最大 1 ms。

CPU 行从另一个角度说的是同一件事：`Real=0.29s` 配 `User=0.00s Sys=0.00s`，291 毫秒墙钟里 CPU 不到 10 毫秒。**这 291 毫秒不是算出来的，是等出来的。**

要复现它只需要一个条件：**让那次 `write(2)` 不能马上返回**。

被测程序是分配型负载，128 MB 堆跑 12 秒；GC 日志走 stdout。为了让那次 write 慢下来，启动命令里加了一根管道：

```
java ... -Xlog:gc* GcLogLoad 12 | python3 slowconsumer.py 0.5 65536 gc.log
```

管道就是 shell 那个竖线建出来的：JVM 的 fd 1（stdout）接在写端，读端是 slowconsumer 的 fd 0。实测能直接看到这两头是同一根管道——`readlink /proc/<java>/fd/1` 和 `readlink /proc/<consumer>/fd/0` 都指向 `pipe:[152731710]`。

管道有个固定容量。Linux 上的匿名管道默认 64 KB，用 `fcntl(F_GETPIPE_SZ)` 查出来是 65536 字节：写进去的字节要等读端取走才腾得出空间，写到第 65537 字节时就写不动了。于是 write 的返回时间只取决于一件事——管道里还有没有空格：

- 有空间 → `write(2)` 立刻返回，一切正常；
- 没空间 → 阻塞模式下 `write(2)` 就地等待，直到读端取走一块腾出地方（非阻塞模式则是返回 EAGAIN）。

这个等待有多实在，可以单独量：把管道写满，读端睡 500 ms 再来读，写端那次 write 的返回时间就是 **501 ms**。

回到这个负载：GC 日志按约 320 KB/s 产生，而读端每读 64 KB 就停 500 ms，平均只排空 128 KB/s。进得多、出得少，管道很快填满；填满之后每一次 `write(2)` 都得等读端睡醒，前面那 291 ms 就是这么来的。

容器里的形状完全一样——stdout 后面的读端是容器 runtime 或日志代理，网络盘上那次 write 则取决于一次网络往返，它们慢下来时 VMThread 遇到的就是同一种等待。反过来也解释了表格第一行：写本地文件时 write 落到 page cache 就返回，所以 2651 次 pause 一次都没超过 100 ms。

用 `strace -T` 可以直接量到每一次 `write(2)` 的耗时（strace 自己会拖慢 JVM，这里只看它卡在哪一格，不看绝对值）：15232 次 GC 日志写入的中位是 0.020 ms，其中 23 次卡在 100~183 ms；而这几格前后相邻的 write 依然只有 0.02~0.03 ms——卡住的是某一次 write，不是一批一起变慢。

同一份负载，三种接法各跑一次，把每次 Young GC 的耗时全部记下来：

| 接法 | pause 次数 | 中位数 | p99 | 最大 | 超过 100 ms |
| --- | --- | --- | --- | --- | --- |
| 同步 → 本地文件 | 2 651 | 0.41 ms | 0.63 ms | 4.4 ms | 0 次 |
| 同步 → 慢管道 | 1 128 | 0.40 ms | **299.74 ms** | **307.1 ms** | **18 次** |
| 异步 → 慢管道 | 1 339 | 0.35 ms | 0.56 ms | 3.5 ms | 0 次 |

注意第二行的中位数：**0.40 ms，和另外两组几乎没有区别**。

这正是它难被发现的原因。日志卡 GC，不是让每一次 GC 都变慢，而是在某几次上炸一下：1128 次 pause 里只有 18 次跳到 289~307 ms，占 1.6%，其余 1110 次完全正常。平均值看不出来，中位数也看不出来，只有 p99 和最大值能把它拽出来。

![同一个负载下每次 Young GC 的耗时分布，中位数全都健康，问题只在尾部](/media/posts/async-gc-log-pause/GClogImpl_pause-02c8cd92.png)

图里第三组是开了 `-Xlog:async` 之后：同样一条慢管道，同样一次卡住的 `write`，那 18 个尖刺全部消失。

所以要判断是不是这个问题，其实只看一个信号就够了：**`gc,cpu` 行里 `Real` 与 `User+Sys` 的差**。`Real=0.29s` 配 `User=0.00s Sys=0.00s`，说明这 291 毫秒不在算，而在等。

## 二、成因：GC 日志不走应用日志那条路

只看应用代码的话，很容易得出“GC 和日志不相干”的结论——日志是应用打的，GC 是 JVM 干的。但 GC 日志不在这个范畴里：它是 JVM 自己在 pause 期间写的。

一条 GC 日志从产生到落盘，只经过三个函数：

```
VMThread ──▶ LogTagSet::log() ──▶ LogFileStreamOutput::write() ──▶ write(2) ──▶ 文件描述符
```

`LogTagSet::log()` 把消息分发给这个 tagset 上挂的每个 output，`LogFileStreamOutput::write()` 负责真正写下去。同步模式下这两步都由调用方线程自己完成——打这条日志的是 VMThread，写它的也是 VMThread，一次 `write(2)` 加一次 `fflush`。

而应用日志走的是另一条路：

```
应用线程 ──▶ logback / log4j ──▶ Appender ──▶ 文件
```

GC 日志不经过上面任何一个环节，它是 HotSpot 内部直接往文件描述符里写。

这里还有一层放大：同步模式下打这些日志的是 VMThread，而它正持有 safepoint。一个普通业务线程卡在 `write()` 里，受影响的只有它自己；VMThread 卡住，JVM 里所有 Java 线程都在等这次 pause 结束。所以 `write()` 里那 291 毫秒的等待，被放大成整个应用 291 毫秒的停顿。

还有一个容易被忽略的放大项：**日志开得越详细，一次 pause 里的写次数越多**。只开 `-Xlog:gc` 时一次 pause 只有 1 行，开 `-Xlog:gc*` 是 14 行。排障期间临时加上 `gc*`，恰好也是这条链路最脆弱的时候——写次数放大 14 倍，撞上一次慢 `write` 的概率也跟着放大。

## 三、方案：`-Xlog:async`，让 GC 线程不再自己写日志

碰到“GC 被日志卡住”，能动手的方向其实只有四个。前三个都在跟“那次 `write()` 有多慢、会发生几次”较劲，只有最后一条换了一件事——**谁来做这次 I/O**。

| 做法                  | 改掉的是什么      | 什么没变               |
| ------------------- | ----------- | ------------------ |
| 换更快的盘               | 单次 write 的耗时 | 写的人还是 VMThread    |
| 再加一块盘，让 GC 日志单独写    | 与其他写者的争抢    | 盘自身的抖动、stdout 后面的代理 |
| 减少日志输出              | 撞上慢 write 的次数 | 撞上一次，就是一整次停顿      |
| **`-Xlog:async`（异步写日志）** | 谁来做这次 I/O  | —                  |

**换更快的盘**，实测确实支持它：同一份负载写本地文件，2651 次 pause 一次都没超过 100 ms；接到慢管道上，p99 跳到 299.74 ms。但盘再快，也只是把那次 write 的耗时压缩了，VMThread 仍然要自己等它返回。只要有一次 write 撞上抖动，那一次等待还是原封不动地记进停顿。云上还有两个绕不开的现实：盘型不由你定；GC 日志走 stdout 时，写端后面根本不是盘，而是容器 runtime 和日志代理，换盘对它毫无影响。

**再加一块盘，让 GC 日志单独写**，针对的是另一件事：争抢。日志和业务写盘挤在同一个设备队列上，业务那一侧把带宽或 IOPS 吃满，日志这次 write 就得排在后面等。把日志挪到独立设备，这一份排队就消失了。但它能消掉的也只有“争抢”这一项——盘自己的抖动、网络盘的一次往返、stdout 后面那个代理，一样都躲不开。而且云上能不能挂第二块盘、挂上去是不是真的独立（很多云盘只是同一个后端存储上的不同 LUN），都不由你决定。

**减少日志输出**改的是概率，不是后果。默认 `-Xlog:gc` 一次 pause 只写 1 行，开 `-Xlog:gc*` 是 14 行——写次数放大 14 倍，撞上一次慢 write 的概率也跟着放大 14 倍；反过来把详细度降下来，撞上的机会就小了。但一旦撞上，那一次仍然是 291 ms，一毫秒不少。而且降详细度是要付代价的：GC 各阶段的耗时、region 的变化、Metaspace 的占用全没了，恰恰是出事时最想看的那部分。顺带说一句，`filesize` 和 `filecount` 跟这件事没关系，它们管的是文件轮转，不是写缓冲。

**`-Xlog:async`** 是四条里唯一改性质的：它让写日志这件事不再由打日志的线程自己做。前三条都在让那次 write 更快或者更少，只有它把 write 从 VMThread 手里挪走了——VMThread 只把消息放下就返回，慢不慢都不再进 pause 的计时。

它的样子是被三个约束挤出来的。理解这三个约束，比记住参数重要得多。

**约束一：打日志的线程不能等 I/O。** 这是硬要求——等 I/O 的可能是 GC 线程，也可能是持有 safepoint 的线程，一旦阻塞，整个 JVM 都跟着受影响。所以必须把写操作挪到别的线程，logsite 只负责“把消息放下”。

**约束二：缓冲必须有界。** 无限缓冲等于把延迟风险换成 OOM 风险。一个被打满的日志队列能轻易吃掉几 GB 堆外内存，而且往往是在系统已经出问题的时候。

**约束三：有界就一定会满，必须提前规定满了怎么办。** 这一条最容易被设计者回避，但它决定了这个功能能不能用——缓冲满的那一刻，要么丢消息，要么让生产者等着，没有第三种选择。

JDK 的 CSR 里对这一点写得非常直白：

> On buffer exhaustion the enqueuing message is discarded so that under no circumstances will logging block threads.

三个约束，对应三个设计决定：**有界缓冲 + 单个专用写线程 + 默认丢弃**。第四章讲它怎么实现，第五到第八章讲它付出了什么代价，都是这三句话的展开。

`-Xlog:async` 把 logsite 的动作从“写文件”换成了“入队”：

```
GC 线程 / VMThread ──入队──▶ 缓冲 ──swap──▶ AsyncLog Thread ──write(2)+fflush──▶ 文件或管道
```

![同一条日志的两条路径：同步时 GC 线程必须穿过 write()，异步时只把消息放进缓冲](/media/posts/async-gc-log-pause/GClogImpl_-48218d30.gif)

图中上排是同步：GC 线程要穿过 `write()` 这道关卡，卡住时 pause 计时一直在涨。下排是异步：logsite 放下消息就返回，缓冲涨到满为止。

## 四、实现：三个函数，两个缓冲，没有定时器

一条日志从产生到落盘，在 HotSpot 里只经过三个函数。同步和异步的分岔，出现在一个虚函数调用上。

`LogTagSet::log()` 负责把消息分发给这个 tagset 上挂的所有 output：

```cpp
void LogTagSet::log(LogLevelType level, const char* msg) {
  LogOutputList::Iterator it = _output_list.iterator(level);
  LogDecorations decorations(level, *this, _decorators);
  for (; it != _output_list.end(); it++) {
    (*it)->write(decorations, msg);      // 有几个 output 就调几次
  }
}
```

`LogFileStreamOutput::write()` 就是那个分岔点：

```cpp
int LogFileStreamOutput::write(const LogDecorations& decorations, const char* msg) {
  if (AsyncLogWriter::enqueue(*this, decorations, msg)) {
    return 0;                                    // 入队成功，调用线程立刻返回
  }
  return write_blocking(decorations, msg);       // 否则自己动手写
}
```

真正干活的是 `write_blocking()`：

```cpp
int LogFileStreamOutput::write_blocking(const LogDecorations& decorations, const char* msg) {
  FileLocker flocker(_stream);
  int written = write_internal(decorations, msg);
  return flush() ? written : -1;                 // fflush，到 page cache 就返回
}
```

`flush()` 走的是 `fflush()`，全程没有 `fsync`。这有实际意义：数据交给内核就返回，所以同步模式下就算进程被 `kill -9`，已经写出去的日志也不会丢。

把分岔放在输出层还有个好处：**异步是一个可选分支，不是另起一条平行链路**。所以所有 output 共用同一套装饰器、过滤和轮转逻辑，开了 `-Xlog:async` 之后 `filesize`、`filecount` 照常生效。

入队听起来要抢锁，但临界区极小。`AsyncLogWriter` 维护两个 Buffer，构造函数里把参数一分为二：

```cpp
size_t size = AsyncLogBufferSize / 2;
_buffer = new Buffer(size);
_buffer_staging = new Buffer(size);
log_info(logging)("AsyncLogBuffer estimates memory use: %zu bytes", size * 2);
```

也就是说 **`-XX:AsyncLogBufferSize=2M` 是两个缓冲合计 2 MB，各 1 MB**，不是各 2 MB。

消费者线程的主循环长这样：

```cpp
while (true) {
  {
    ConsumerLocker clocker;
    while (!_data_available) {
      clocker.wait();
    }
    // 锁内只做两件事：换缓冲、搬丢弃计数
    _buffer_staging->reset();
    swap(_buffer, _buffer_staging);
    // ... stats 搬到 snapshot
    _data_available = false;
  }
  bool saw_flush_token = write(snapshot);    // 锁外做全部 I/O
}
```

源码里的注释写得很直白：“Only doing a swap and statistics under the lock to guarantee that I/O jobs don't block logsites.”

生产者侧对应的是 `push_back` + `notify`：

```cpp
if (_buffer->push_back(output, decorations, msg, msg_len)) {
  _data_available = true;
  clocker.notify();
  return;
}
```

一次入队的全部动作就是：拿锁、拷一条消息、改一个标志位、唤醒消费者。没有 I/O，也没有真正落盘。

![双缓冲交换：锁内只换指针，锁外才是真正的写](/media/posts/async-gc-log-pause/GClogImpl_-ea595c4a.png)

用两个缓冲而不是一个，目的是让生产者在消费者写盘期间还能继续入队。如果只有一个缓冲，消费者写盘时就得一直占着锁，logsite 还是要等——那就等于没解决。

关于“批”，有个常见误解。很多人以为异步日志是攒一批再写，既然是攒，总得有个时间间隔吧。其实没有。消费者等的是无超时的条件变量：

```cpp
while (!_data_available) {
  clocker.wait();        // PlatformMonitor::wait(0)，0 表示不限时
}
```

生产者每入队一条就 `notify()`。所以**没有超时、没有“攒够 N 条”、也没有“攒够 X 毫秒”**。消息入队即被唤醒，正常情况下一条日志的落地延迟就是一次上下文切换加一次 `write`。

实测（静置 2 秒后只触发一次 `System.gc()`，再以 2 ms 间隔 stat 文件，与该行的 `uptimemillis` 相减）：

| 模式 | 单条日志从产生到出现在文件里（各 6 个样本） |
| --- | --- |
| 同步 | 中位 3.55 ms |
| 异步 | 中位 4.38 ms，全部落在 3.1~4.7 ms |

如果真有秒级的批量刷盘，这些数字会散布在 0~1000 ms 之间。它们没有。

那“批”从哪来？它是消费者被 I/O 卡住之后被动攒出来的：卡住多久，乘以这期间日志产生的速率，就是下一次 swap 时缓冲里积压的量。这不是设计出来的批处理，而是阻塞的副产品。

这也解释了一个反直觉的现象：**缓冲越大，单条日志的延迟并不变**，变的只是“能扛住多久的阻塞才开始丢”。

## 五、局限

### 缓冲满之后只有两种选择

缓冲必须有界，有界就一定有满的那一刻。真满了，只剩两条路可走。

**默认行为是 drop：满了就丢，但会计数。** 计数会在下一次 swap 时，以一条警告的形式写进发生丢弃的那个 output：

```
 10304 messages dropped due to async logging
```

丢是能发现的，但丢起来是整段整段地丢，不是零星丢。实测 2 MB 缓冲 + 慢管道，日志内容停在 9.3 秒，而负载要一直跑到 12 秒——后面这 2.7 秒一条都没留下。

**另一种选择是 stall：满了就让生产者等。** 它不丢日志，代价是把等待还给了调用线程：

| 模式 | 参数 | 行为 | 适用 |
| --- | --- | --- | --- |
| drop（默认） | `-Xlog:async` | 满了丢，记数，继续跑 | 保停顿优先，能接受丢 |
| stall | `-Xlog:async:stall` | 满了让生产者等 | 一条都不能丢 |
| off | `-Xlog:async:off` | 显式关闭 | 发行版默认开启时用来关掉 |

`stall` 不是“既快又不丢”的答案。2 MB 缓冲配慢管道实测：p99 只有 0.62 ms，看着漂亮，但**最大停顿 4396.9 ms**，三次重复都能稳定复现。它是个双峰分布——绝大多数时候不等，一旦缓冲满，就等足一次完整的排空。而 100 KB 缓冲的 stall 组干脆退化成了同步（p99 297.9 ms，跟同步的 299.7 ms 几乎一样）。

所以 stall 模式下缓冲容量很微妙：**太小就退化成同步，太大则一次等很久**。

版本上还要注意：`-Xlog:async` 是 JDK 17 引入的（JDK-8229517），不是新特性。`:stall` 是 JDK 25 起的（JDK-8323807，2025 年 2 月集成），`:off` 是 JDK-8392140，2026 年 9 月底才进 master，目标版本 28。如果你在 JDK 21 上，只能写 `-Xlog:async`，加任何后缀都会得到 `Invalid tag 'async' in log selection`。

### 四条会静默退回同步的路径

回到第四章那个分岔点。`write()` 的逻辑是“入队失败就自己写”，而入队失败不只是缓冲满这一种——它先要判断当前能不能入队：

```cpp
bool AsyncLogWriter::enqueue(...) {
  if (!is_enqueue_allowed()) {
    return false;                    // 返回 false，调用方退回 write_blocking
  }
  ProducerLocker plocker;
  AsyncLogWriter::instance()->enqueue_locked(&output, decorations, msg);
  return true;
}
```

`is_enqueue_allowed()` 有四个分支返回 `false`：

| 分支 | 源码条件 | 什么情况下会命中 |
| --- | --- | --- |
| 1 | `this_thread == nullptr` | 线程没有 attach 到 VM |
| 2 | `holding_thread == this_thread` | 已在入队路径里又打了一条日志（递归） |
| 3 | `alw == nullptr` | 异步线程还没起来，或创建失败 |
| 4 | `this_thread == alw` | AsyncLog Thread 自己在打日志 |

只要命中任何一条，这条日志就原地同步写出去，跟没开异步一模一样。

麻烦的地方在于：这四个分支**不报错、不计数、也不改变日志内容**。光看日志，你分不出哪一条走了同步路径——差别只体现在落盘时刻与消息自带时间戳之间的那点间距上。

![四条降级路径：任一命中就退回同步写，且不留痕迹](/media/posts/async-gc-log-pause/GClogImpl_-9cf215aa.png)

其中第 2 条最值得警惕。它是“打日志的过程中又打了一条日志”的重入，`ASSERT` 构建下会直接 `ShouldNotReachHere()`，但 product 构建里只是悄悄退回同步。如果这个重入恰好发生在 pause 期间，那一次 pause 就回到了被 I/O 卡住的老路上——而且只在特定负载下偶发，几乎没法从日志里定位。

第 3 条也有实际影响：`AsyncLogWriter::initialize()` 在 `runtime/init.cpp` 里被调用，位置排在 `universe_init` 之后。也就是说，**VM 初始化早期产生的日志仍然是同步写的**，异步要到那个点之后才接管。启动阶段日志量小，通常无所谓；但如果启动参数里开了很详细的 `-Xlog`，这一段就不在异步的保护范围内。

###  缓冲是总预算，不是每个 output 一份

还记得 `LogTagSet::log()` 里那个循环吗？有几个 output，就调几次 `write()`。每一份都是一条独立的消息，都要在缓冲里占地方。

`-XX:AsyncLogBufferSize` 默认 2 MB，范围 100 KB 到 50 MB。它是**整个 VM 的总预算**，而且启动即分配：

```
$ java -Xlog:async -Xlog:logging=info -version
[info][logging] AsyncLogBuffer estimates memory use: 2097152 bytes
```

用 NMT 看更直接：开了异步，`Logging` 段是 `reserved=2097200, committed=2097200`；不开，这一段根本不出现。所以只要加了 `-Xlog:async`，就等于无条件多占 2 MB 堆外内存，跟日志量多少无关。

实测多挂 output 的代价（200 KB 缓冲、同样的慢管道、同样 12 秒负载）：

| 挂几个 output | 慢 output 丢弃 | 快 output 丢弃 |
| --- | --- | --- |
| 只挂慢管道 | 14 978 | — |
| 慢管道 + 一个本地文件 | 15 762 | 15 775 |

想多挂一个本地文件“兜底”，缓冲消耗直接翻倍，而两边丢掉的数量几乎一样（差 13 条，0.08%）。原因是同一行日志的两份在缓冲里是相邻的，缓冲被填满时它们一起被拒。

所以“再写一份到本地文件保险一点”这个做法在异步模式下不成立——它不增加安全性，只是让缓冲更快耗尽。

### 阻塞没有消失，只是换到了退出路径

没有定时器，flush 又只有两个调用点，合起来的后果是：缓冲里的东西不会自己流出去，只在特定时刻被排空。

`flush()` 的调用点只有 `configure_output()`（改配置前）和 `disable_outputs()`（JVM 正常退出）。`kill -9` 不属于任何一种。50 MB 缓冲 + 慢管道实测：

| 结束方式 | 进程总耗时 | 日志末条 uptime |
| --- | --- | --- |
| `kill -9` | 13.2 s | 5.414 s |
| `kill -TERM` | 30.3 s | 12.072 s |

`kill -9` 少了 6.6 秒的记录，丢的恰恰是出事前最想看的那一段。

`kill -TERM` 一条不丢，代价是退出多等了 17 秒——那 17 秒全花在排空缓冲上。如果是在 K8s 里滚动发布，`terminationGracePeriodSeconds` 默认 30 秒，这个量级能吃掉一大半。

同一个机制还会咬到运维操作：**`jcmd` 改配置前会先排空缓冲**。积压状态下实测这条命令要 **11 257 ms** 才返回，健康盘上只要 278 ms。如果把它放进健康检查或自动化脚本，超时设置要留够。

## 六、怎么用：静态参数与动态配置

静态配置就是启动时加一项，位置不讲究，放在 GC 参数前后效果一样：

```bash
java -Xlog:async -XX:AsyncLogBufferSize=8M \
     -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=5,filesize=64m \
     -jar app.jar
```

两点提醒：`-XX:AsyncLogBufferSize` 既接受 `8M` 这种后缀写法，也接受字节数；轮转照常工作，`filecount`、`filesize` 是在 output 层生效的，跟异步与否无关。

另外 `-Xlog:async` 是**全局开关**，不是某个 output 的属性。想只让 GC 日志异步、别的日志保持同步，做不到。

动态这一侧能做的事有限。`jcmd VM.log` 改不了 async：

```
$ jcmd <pid> VM.log output_options='async=true'
Invalid option 'async'
```

新加的 output 会继承启动时的 async 状态，所以动态加一个 GC 日志输出是可行的。但有个坑：**只传 `output='#N'` 而不给 `what`，会把 `all=info` 合并进去**；而 `what` 只能合并、不能删减。改完就回不去了，只能重启：

```
$ jcmd <pid> VM.log output='#2'
#2: file=gc.log all=info ...          ← 从这一刻开始输出全量日志
$ jcmd <pid> VM.log output='#2' what='gc*=info'
#2: file=gc.log all=info ...          ← 依然是 all=info
```

正确的做法是先 `disable` 再完整重建，重建出来的 output 照样继承 `async=true`。

## 七、场景总结

判断要不要开，其实只有一个问题：**这条日志链路会不会阻塞**。不会阻塞就没有收益，会阻塞才需要取舍。

| 场景 | 建议 | 理由 |
| --- | --- | --- |
| GC 日志落本地盘，I/O 正常 | 不开 | 实测和同步无差异 |
| 容器 stdout + 日志代理 | `drop`，8~16 MB | 代理卡住时保住停顿 |
| 网络盘 / 挂载点 | `drop`，32~50 MB | 单次写取决于网络往返 |
| 一条日志都不能丢 | `stall`，缓冲别太小 | 用停顿换完整，但可能一次几秒 |
| 靠最后几行做崩溃分析 | 不开，或改用 JFR | 异步崩溃时会滞后几秒 |
| 滚动发布，宽限期很紧 | 慎开 | 退出可能多等十几秒 |

缓冲给多大，取决于你想让它扛住多久写不出去。一个能用的粗算法是：**缓冲 ≥（日志产生速率 − 排空速率）× 想扛住的时长**。本文这个负载下，日志产生约 3.9 MB / 12 s（约 320 KB/s），而这条慢管道每 500 ms 只被读走 64 KB（128 KB/s），净积累约 195 KB/s，2 MB 缓冲算下来能扛 10.8 秒——实测撑到 9.3 秒开始丢，同一量级。

