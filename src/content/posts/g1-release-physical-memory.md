---
title: G1 释放物理内存：避免长期无效占用
slug: g1-release-physical-memory
date: 2026-04-19
category: JVM 内存与 GC
tags:
  - GC
  - 内存
  - JVM
summary: "白天有流量、夜间几乎空闲的服务，堆内存一直占着不放。这需要区分「JVM 已回收」和「操作系统已回收」两件事，G1 的周期性 uncommit 与 region 归还策略决定了后者什么时候发生。"
---

## 背景

用户咨询了一个内存资源利用的场景。场景如下：

1. 他们的 java服务主要是白天有访问，晚上量很少。
2. 有一些零散的任务需要运行。

他们的想法是把这些零散的任务在晚上放在 java 服务的机器上运行，这样就可以在不买新的机器的情况下，处理的事情更多了。

他们在实施上遇到了问题：java 服务为什么不能释放物理内存，这个导致他们晚上的程序因内存不足起不来。

这种场景是有解决办法的，jdk 社区做了不少功能来支持这个场景，释放内存的能力每种 gc 都不相同，并且是不同的参数来控制。  
下面我以 G1 为例来讲讲 jdk 支持的实现方式。选择G1 的原因如下：

1. jdk9 之后的默认 GC。
2. 支持的场景更丰富。
3. 释放的效果相对较好。

## 实现

下面的 code 来自 jdk25。不同版本看到的结果会有差异。

我们围绕两个角度来进行分析。

1. 释放内存的策略
2. 释放内存的时机

### 释放内存的策略

内存释放的策略和内存增长的策略都在同一个方法中。

```c++
size_t minimum_desired_capacity = target_heap_capacity(used_after_gc, MinHeapFreeRatio);

size_t maximum_desired_capacity = target_heap_capacity(used_after_gc, MaxHeapFreeRatio);

minimum_desired_capacity = MIN2(minimum_desired_capacity, _g1h->max_capacity());

maximum_desired_capacity = MAX2(maximum_desired_capacity, _g1h->min_capacity());
```

计算预期目标内存大小的核心就是上面 4 行。先根据 gc 之后内存作为计算参考，转化成预期的内存上下界，在把范围控制在 xms 和 xmx之间。也就是说内存最大能申请到 xmx，最小能缩减到 xms。如果当前的内存在范围内，则本次不调整 内存。

target\_heap\_capacity的计算代码如下，主要就是根据内存根据比率来计算边界。

```c++
const double desired_free_percentage = (double) free_ratio / 100.0;

const double desired_used_percentage = 1.0 - desired_free_percentage;

double used_bytes_d = (double) used_bytes;

double desired_capacity_d = used_bytes_d / desired_used_percentage;
```

预期释放的内存大小就是上面计算 两者的差值。

```c++
size_t shrink_bytes = capacity_after_gc - maximum_desired_capacity;
```

可以释放的内存大小是计算出来了，但是实际是否能释放还得看实际情况。这里是 G1 自身内存管理带来的限制，他本身是 region 管理，所以释放的单位就是 region。

```c++
uint num_regions_to_remove = (uint)(shrink_bytes / G1HeapRegion::GrainBytes);
```

根据shrink\_bytes转化成释放的 region 个数。既然是整体 region 释放，region 中肯定是不能存在对象的。

```c++
while ((removed < num_regions_to_remove) &&

(num_last_found = find_empty_from_idx_reverse(cur, &idx_last_found)) > 0) {

uint to_remove = MIN2(num_regions_to_remove - removed, num_last_found);

shrink_at(idx_last_found + num_last_found - to_remove, to_remove);

  

cur = idx_last_found;

removed += to_remove;

  

}
```

G1 在计算出 region 数之后，会通过find\_empty\_from\_idx\_reverse从后找完全空闲的 region，实际能释放的内存量是这边找出的 region 个数。如果有大对象占用一半多 region导致了空间的碎片，就无法释放这个 region 了。

### 释放内存的时机

下面释放的时机主要讲的是平稳释放的路径。G1在 full gc 的时候也会触发检测逻辑，是可以通过这个路径来释放，但是 full gc 对在线服务的影响比较大，这个路径不在本次的讨论中。

jdk 会启动一个定时任务来做检测和触发。  
\`\`

```c++
void G1PeriodicGCTask::execute() {

check_for_periodic_gc();

schedule(G1PeriodicGCInterval == 0 ? 1000 : G1PeriodicGCInterval);

}
```

检测的 2 个判定条件，第一个判定条件是 gc 间隔

```c++
uintx time_since_last_gc = (uintx)g1h->time_since_last_collection().milliseconds();

if ((time_since_last_gc < G1PeriodicGCInterval)) {

log_debug(gc, periodic)("Last GC occurred %zums before which is below threshold %zums. Skipping.",

time_since_last_gc, G1PeriodicGCInterval);

return false;

}
```

我们期待的是业务量很低或者没有的时候来回收内存，gc 的间隔代表的是业务的内存申请量，如果内存一直申请，一直做 gc，说明并不适合做内存释放，这个配置可以自己设置。

第二个判断条件是 cpu 的 load。

```c++
double recent_load;

if (G1PeriodicGCSystemLoadThreshold > 0.0) {

if (os::loadavg(&recent_load, 1) == -1) {

G1PeriodicGCSystemLoadThreshold = 0.0;

log_warning(gc, periodic)("System loadavg() call failed, "

"disabling G1PeriodicGCSystemLoadThreshold check.");

} else if (recent_load > G1PeriodicGCSystemLoadThreshold) {

log_debug(gc, periodic)("Load %1.2f is higher than threshold %1.2f. Skipping.",

recent_load, G1PeriodicGCSystemLoadThreshold);

return false;

}

}
```

这个是为了兼容计算场景，如果分配内存少，但是cpu 一直运行，得用户自己来判断，如果计算时候还是大量申请内存，其实并不适合释放内存，因为后面还要申请内存，内存来回申请和释放也是一种性能问题。这个参数是可配置参数，如果不配置默认不检测 cpu。

在满足上述条件的情况下，G1 会发起一次 gc，并把原因标注为G1 Periodic Collection。

```c++
g1h->try_collect(0 /* allocation_word_size */, GCCause::_g1_periodic_collection, counters)
```

*g1*periodic\_collection根据G1PeriodicGCInvokesConcurrent会有不同的表现，默认是触发一次 concurrent，也可以通过参数改成 fullgc，但是不建议。

```c++
  

bool G1CollectedHeap::should_do_concurrent_full_gc(GCCause::Cause cause) {

switch (cause) {

case GCCause::_g1_humongous_allocation: return true;

case GCCause::_g1_periodic_collection: return G1PeriodicGCInvokesConcurrent;

case GCCause::_wb_breakpoint: return true;

case GCCause::_codecache_GC_aggressive: return true;

case GCCause::_codecache_GC_threshold: return true;

default: return is_user_requested_concurrent_full_gc(cause);

}

}
```

在ConcurrentMark的过程中会根据是否是Periodic来触发内存的调整逻辑。

```c++
if (_g1h->last_gc_was_periodic()) {

_g1h->resize_heap_after_full_collection(0 /* allocation_word_size */);

}
```

释放内存的方式也很安全munmap

```c++
static int anon_munmap(char * addr, size_t size) {

if (::munmap(addr, size) != 0) {

ErrnoPreserver ep;

log_trace(os, map)("munmap failed: " RANGEFMT " errno=(%s)",

RANGEFMTARGS(addr, size),

os::strerror(ep.saved_errno()));

return 0;

}

return 1;

}
```

## 实践

我们通过 gc 日志来展示效果，gc 日志比较直观，可以看到上述的过程。第一步先把 xms 和 xmx 设置不一样。这个是最重要的步骤，很多早期的 java 实践都是要把 xms 和 xmx 设置一样，来避免内存一直停留在 xms 上，这条经验在现在的 G1 上不适用。

这是最后一次业务正常的 gc。可以看到 heap 是 60m。

```
[5.952s][info ][gc ] GC(4026) Pause Young (Concurrent Start) (G1 Humongous Allocation) 25M->1M(60M) 1.032ms
```

这里我通过 jinfo 来动态设置触发。

```
jinfo -flag G1PeriodicGCInterval=10000 pid
```

我把间隔设置成 10s，这里作为一个参考建议，不建议设置太长，因为程序一般有心跳检测，会分配一些对象，这就导致了 gc 间隔不会特别长。

先触发了一次Undo Cycle，这个是 G1 的一个优化，避免浪费资源的Concurrent，这里有启发式逻辑，不一定会真实遇到。

```
[5.952s][info ][gc ] GC(4027) Concurrent Undo Cycle

[5.952s][debug][gc,task ] G1 Service Thread (Card Set Free Memory Task) (run: 0.537ms) (cpu: 0.046ms)

[5.952s][debug][gc,stats ] Mark stats cache hits 801 misses 0 ratio 100.000

[5.952s][info ][gc,marking ] GC(4027) Concurrent Clear Claimed Marks

[5.952s][info ][gc,marking ] GC(4027) Concurrent Clear Claimed Marks 0.003ms

[5.952s][info ][gc,marking ] GC(4027) Concurrent Cleanup for Next Mark

[5.952s][debug][gc,ergo ] GC(4027) Running G1 Clear Bitmap with 1 workers for 1 work units.

[5.952s][info ][gc,marking ] GC(4027) Concurrent Cleanup for Next Mark 0.042ms

[5.952s][info ][gc ] GC(4027) Concurrent Undo Cycle 0.104ms
```

下次开始了因Concurrent触发的一次 ygc，这就回到了正常的 G1 流程里来了，先来一次 ygc，接下来就是Concurrent Mark Cycle。

```
[23.030s][info ][gc ] GC(4028) Pause Young (Concurrent Start) (G1 Periodic Collection) 26M->1M(60M) 2.041ms

  

[23.030s][info ][gc ] GC(4029) Concurrent Mark Cycle
```

Concurrent阶段我们就看到了标记可以释放的 region

```
[23.033s][debug][gc,ergo,heap ] GC(4029) Attempt heap shrinking (capacity higher than max desired capacity). Capacity: 62914560B occupancy: 4194304B live: 1271544B maximum_desired_capacity: 13981013B (70 %)

[23.033s][debug][gc,heap,region ] GC(4029) Deactivate regions [56, 58)

[23.033s][debug][gc,heap,region ] GC(4029) Deactivate regions [19, 55)

[23.033s][debug][gc,heap,region ] GC(4029) Deactivate regions [10, 18)

[23.033s][debug][gc,ergo,heap ] GC(4029) Shrink the heap. requested shrinking amount: 48933547B aligned shrinking amount: 48234496B actual amount shrunk: 48234496B

[23.033s][debug][gc,heap ] GC(4029) Uncommittable regions after shrink: 46
```

在Remark阶段已经看到了 heap 从60m变成了 14m。这里只是把heap 的边界修改了。

```
[23.033s][info ][gc ] GC(4029) Pause Remark 1M->1M(14M) 0.994ms

[23.033s][info ][gc,cpu ] GC(4029) User=0.01s Sys=0.00s Real=0.00s
```

G1 Uncommit Region Task开始做真正的Uncommit，到这里内存才真正的释放，我们可以通过系统监控的 rss 中看到内存降低了。

```
[23.034s][debug][gc,heap,region ] Uncommit regions [10, 18)

[23.036s][debug][gc,heap,region ] Uncommit regions [19, 55)

[23.036s][info ][gc,marking ] GC(4029) Concurrent Rebuild Remembered Sets and Scrub Regions 2.733ms

[23.036s][debug][gc,heap,region ] Uncommit regions [56, 58)

[23.036s][debug][gc,heap ] Concurrent Uncommit Summary: 47104K, 46 regions, 2.793ms

[23.036s][debug][gc,task ] G1 Service Thread (G1 Uncommit Region Task) (run: 2.968ms) (cpu: 2.795ms)
```

## 总结

在 G1 的使用中，重点关注如下参数

```
-XX:G1PeriodicGCInterval
-XX:G1PeriodicGCSystemLoadThreshold
```

同时考虑自己的真实场景，要避免短时间内频繁的申请和释放物理内存。
