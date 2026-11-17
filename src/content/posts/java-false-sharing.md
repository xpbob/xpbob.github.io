---
title: Java 伪共享问题的稳定解法
slug: java-false-sharing
date: 2026-04-12
category: CPU 与采样分析
tags:
  - CPU
  - JVM
  - 排障
summary: "用 padding 填充 long 字段隔离两个 volatile 变量，实测却毫无提升——因为填充解决的是「同一缓存行内不同字段」的竞争，而伪共享的判定要退到 MESI 协议与缓存行对齐去看。这篇给出可复现的判定顺序。"
featured: true
---

## 背景

用户咨询了一个java中cpu缓存伪共享场景， 他通过padding多个long 字段隔离 2 个volatile字段，但是实测效果没有提升。  
这是个比较有趣的场景，在 jdk8 有更稳定的方案去解决伪共享带来的性能问题。  
下面我们展开介绍

1. 伪共享问题是什么
2. 用户padding方案为何失效
3. jdk 的新解法、实现方式和最佳实践

## 伪共享问题

伪共享（False Sharing）就是多个线程修改位于同一缓存行内的不同变量，导致缓存频繁失效，拖累系统性能。  
举个例子：  
当两个不相关的变量 A 和 B 恰好落在同一个缓存行时，如果 CPU 核心 1 修改了 A，会导致 CPU 核心 2 的缓存行失效。即使核心 2 只是在操作 B，也必须重新从内存加载数据，这会产生巨大的性能损耗。

引发上面现象的原因是Cache Line，CPU 读取内存时，不是按字节读的，一般是以 64 字节 为单位读入缓存，变量地址很近，会在同一个Cache Line里，哪怕后面的变量不会被当前代码执行，也会被加载。Cache Line大小不同环境会有差异，我们可以用如下命令来确认。

```
cat /sys/devices/system/cpu/cpu0/cache/index0/coherency_line_size
```

这里只做简述，网上有更详细的图解。

在了解cpu伪共享形成的原因后，解决方法也就很多了。  
4. 对象不变，减少不必要的并发。  
5. 增加冲突对象的地址距离。

2 的修改比 1 简单，也是最常见的解法，上述用户的修改也是 2 的方式。

## 用户padding方案失效原因

我把用户的代码做了精简。

```java
public class DataSharingTest {
   public volatile int m;
   public volatile long valueA = 0L;
   public long p1, p2, p3, p4, p5, p6, p7;
   public volatile long valueB = 0L;
   public volatile int j;
}
```

有并发冲突的是开头的 m 和结尾的 j。他中间加了 long，一个 long 在 java里是 8 字节。中间这么多 long 类型，长度已经超过了 64 字节。  
这种写法用户是参考了同事的，并且在他同事那边验证是有效的。

从跑的实际结果上看对象的内存地址是没有分开的。这里被 java 的2 个特性给误导了。  
写过c++的同学都经历过计算对象大小的时期，相同的成员变量存在长度不同时，不同的顺序会导致整体对象大小有差异。java 似乎没有要求成员变量顺序，是因为 java自己做了字段重排序，重排成一个最省内存的版本。这就导致了代码的编写和实际运行产生的差异。

我们打出内存对象结构。

```
com.contended.DataSharingTest object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
 0   8        (object header: mark)     N/A
 8   8        (object header: class)    N/A
16   8   long DataSharingTest.valueA    N/A
24   8   long DataSharingTest.p1        N/A
32   8   long DataSharingTest.p2        N/A
40   8   long DataSharingTest.p3        N/A
48   8   long DataSharingTest.p4        N/A
56   8   long DataSharingTest.p5        N/A
64   8   long DataSharingTest.p6        N/A
72   8   long DataSharingTest.p7        N/A
80   8   long DataSharingTest.valueB    N/A
88   4    int DataSharingTest.m         N/A
92   4    int DataSharingTest.j         N/A
Instance size: 96 bytes
Space losses: 0 bytes internal + 0 bytes external = 0 bytes total
```

可以看到 m 和 j 还是排在一起的。类似的代码为什么他同事的是有效的呢，主要来自另外一个特性，指针压缩。

上面object header: class指针压缩时大小只有 4。

```
com.contended.DataSharingTest object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
 0   8        (object header: mark)     N/A
 8   4        (object header: class)    N/A
12   4    int DataSharingTest.m         N/A
16   8   long DataSharingTest.valueA    N/A
24   8   long DataSharingTest.p1        N/A
32   8   long DataSharingTest.p2        N/A
40   8   long DataSharingTest.p3        N/A
48   8   long DataSharingTest.p4        N/A
56   8   long DataSharingTest.p5        N/A
64   8   long DataSharingTest.p6        N/A
72   8   long DataSharingTest.p7        N/A
80   8   long DataSharingTest.valueB    N/A
88   4    int DataSharingTest.j         N/A
92   4        (object alignment gap)    
Instance size: 96 bytes
Space losses: 0 bytes internal + 4 bytes external = 4 bytes total
```

这里他同事的最终结果。m 和 j 在内存地址上就是分开的。

java 是同时包含了编译、解释、jit 的语言。使用手动增加变量的方式，弄不好哪个特性或者优化就会导致失效。

## jdk的特性和实践

jdk 本身也要编写高并发的库，他也会遇到伪共享问题，在 jdk8中提供了一种稳定的方式来增加内存地址距离。这就是@Contended注解。

### jvm虚拟机支持注解

jvm 虚拟机在遇到@Contended注解时会自动增加空白的内存块。

```c++
void FieldLayoutBuilder::compute_regular_layout() {
 bool need_tail_padding = false;
 prologue();
 regular_field_sorting();

 if (_is_contended) {
   _layout->set_start(_layout->last_block());
   insert_contended_padding(_layout->start());
   need_tail_padding = true;
 }
...  
   if (!_contended_groups.is_empty()) {
   for (int i = 0; i < _contended_groups.length(); i++) {
     FieldGroup* cg = _contended_groups.at(i);
     LayoutRawBlock* start = _layout->last_block();
     insert_contended_padding(start);
     _layout->add(cg->primitive_fields(), start);
     _layout->add(cg->oop_fields(), start);
     need_tail_padding = true;
   }
 }
 }
```

insert\_contended\_padding就是在加入空白块。

```c++
void FieldLayoutBuilder::insert_contended_padding(LayoutRawBlock* slot) {
 if (ContendedPaddingWidth > 0) {
   LayoutRawBlock* padding = new LayoutRawBlock(LayoutRawBlock::PADDING, ContendedPaddingWidth);
   _layout->insert(slot, padding);
 }
}
```

ContendedPaddingWidth就是块的大小。默认为 128。

```
  product(int, ContendedPaddingWidth, 128,                                  \
         "How many bytes to pad the fields/classes marked @Contended with")\
         range(0, 8192)                                                    \
         constraint(ContendedPaddingWidthConstraintFunc,AfterErgo) 
```

### @Contended注解用法

@Contended算是有 3 种用法。  
第一种就是加在字段上。

```java
public class Monitoring {
   @Contended
   long readCount;
   @Contended
   long writeCount;

   long otherData; 
}
```

对象内存布局变化如下

```
OFF  SZ   TYPE DESCRIPTION               VALUE
 0   8        (object header: mark)     N/A
 8   4        (object header: class)    N/A
12   4        (alignment/padding gap)   
16   8   long Monitoring1.otherData     N/A
24 128        (alignment/padding gap)   
152   8   long Monitoring1.readCount     N/A
160 128        (alignment/padding gap)   
288   8   long Monitoring1.writeCount    N/A
296 128        (object alignment gap)    
Instance size: 424 bytes
Space losses: 260 bytes internal + 128 bytes external = 388 bytes total
```

加了注解的字段前会加入 128 的内存块。  
第二种就是组管理

```java
public class Monitoring {
   @Contended("stats")
   long readCount;
   @Contended("stats")
   long writeCount;
   
   long otherData; // 不在组内
}
```

注解内可以加组名，这样相同组名的变量会放在一起。

```
OFF  SZ   TYPE DESCRIPTION               VALUE
 0   8        (object header: mark)     N/A
 8   4        (object header: class)    N/A
12   4        (alignment/padding gap)   
16   8   long Monitoring.otherData      N/A
24 128        (alignment/padding gap)   
152   8   long Monitoring.readCount      N/A
160   8   long Monitoring.writeCount     N/A
168 128        (object alignment gap)    
Instance size: 296 bytes
Space losses: 132 bytes internal + 128 bytes external = 260 bytes total
```

这种更利于，每次改动都是多个变量的场景。

第三种是加在类上。

```java
@Contended
public class Monitoring2 {
   long readCount;
   long writeCount;
}
```

这种是作用在每个对象上。适合有对象数组的场景，数组的对象在内存上都是相邻的，通过增加对象的大小，可以保证操作对象之间不会产生影响。

```
OFF  SZ   TYPE DESCRIPTION               VALUE
 0   8        (object header: mark)     N/A
 8   4        (object header: class)    N/A
12 132        (alignment/padding gap)   
144   8   long Monitoring2.readCount     N/A
152   8   long Monitoring2.writeCount    N/A
Instance size: 160 bytes
Space losses: 132 bytes internal + 0 bytes external = 132 bytes total
```

### jdk里的应用

这里展示一下 jdk 代码里的应用场景  
java.lang.Thread把随机种子相关的都放在一个组里，避免了和其他字段的共享。

```java
    /** The current seed for a ThreadLocalRandom */
   @jdk.internal.vm.annotation.Contended("tlr")
   long threadLocalRandomSeed;

   /** Probe hash value; nonzero if threadLocalRandomSeed initialized */
   @jdk.internal.vm.annotation.Contended("tlr")
   int threadLocalRandomProbe;

   /** Secondary seed isolated from public ThreadLocalRandom sequence */
   @jdk.internal.vm.annotation.Contended("tlr")
   int threadLocalRandomSecondarySeed;
```

java.util.concurrent.Exchanger把 Slot类增加注解，内部是一个Slot\[\]维护，避免互相干扰。

```java
 /**
    * Padded arena cells to avoid false-sharing memory contention
    */
   @jdk.internal.vm.annotation.Contended
   static final class Slot {
       Node entry;
   }

   
   /**
    * Elimination array; element accesses use emulation of volatile
    * gets and CAS.
    */
   private final Slot[] arena;
```

### 最佳实践

上面可以看到jdk.internal.vm.annotation.Contended，这是一个 jdk 内部注解。我们如果引入需要增加

```
--add-exports=java.base/jdk.internal.vm.annotation=ALL-UNNAMED
```

保证编译和运行通过。jdk 默认是不对用户的模块生效的，我们使用时需要关闭RestrictContended。

```
 -XX:-RestrictContended 
```

这种解法本质就是一种拿内存换性能。带来的内存损耗需要仔细评估，否则会带来GC和 OOME。解决的方法有了，我们如何找到比较重要的代码增加注解呢，这里就用到了底层能力。  
最直接的发现是 c2c

```
perf c2c record
```

不过这里需要有内存的事件，不一定有权限。我们可以通过L1-dcache-load-misses来侧面反映。

```
perf -e L1-dcache-load-misses
```
