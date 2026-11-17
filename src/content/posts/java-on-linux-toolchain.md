---
title: 让 Java 融入 Linux 系统工具链
slug: java-on-linux-toolchain
date: 2026-04-26
category: eBPF 与系统观测
tags:
  - Linux
  - 工具链
  - 排障
summary: "Java 与 C/C++ 混合调用场景下，perf、bcc、gdb 这些系统工具默认看不懂 Java 栈。把 JVM 的符号与栈展开接进 Linux 工具链，才能在不改业务代码的前提下做跨语言排查。"
---

现在的软件开发场景中，涉及多语言开发是很常见的，其中最常见的交叉就是java和c/c++的相互调用，这给java程序员、c/c++程序员都带来了问题排障的交叉痛苦。

1. 对java程序员来说，引入动态库加速，一旦遇到内存泄漏，高cpu场景，java的一套工具链无法拿到native的数据。
2. 对c/c++程序员来说，虽然可以perf,bcc等工具抓到native的栈，但是有java虚拟机的干扰，会产生大量的unknown堆栈，无法和代码对应起来。

对双方来说最大的痛苦是无法拼接java和native库的堆栈。这问题已经不是第一天存在了，解法包有的。下面介绍一种我比较推荐的方案：让java支持linux工具链。

## 方案

想要抓取到堆栈，需要有两个条件

1. 进程支持栈回溯
2. 进程如何公开符号表，可以把回溯的内存地址转化成方法

下面我们围绕这两个条件展开。

### 栈回溯

perf默认支持的栈回溯方式是Frame Pointer（下文会使用fp的缩写）。gcc可以通过编译参数来控制保留fp，这个参数是-fno-omit-frame-pointer。

我们通过反编译对比来理解栈回溯需要增加的指令。

```c++
// hello 函数的定义

void hello() {

// 打印 "hello" 字符并换行

printf("hello\n");

}

  
```

这是我们的测试用法，用来演示。

我们开启-fno-omit-frame-pointer

```
000000000040059b <hello>:

40059b: 55 push %rbp

40059c: 48 89 e5 mov %rsp,%rbp

40059f: bf 48 06 40 00 mov $0x400648,%edi

4005a4: e8 e7 fe ff ff callq 400490 <puts@plt>

4005a9: 90 nop

4005aa: 5d pop %rbp

4005ab: c3 retq

4005ac: 0f 1f 40 00 nopl 0x0(%rax)
```

下面不开启参数的反编译结果

```
0000000000400586 <hello>:

400586: 48 83 ec 08 sub $0x8,%rsp

40058a: bf 58 06 40 00 mov $0x400658,%edi

40058f: e8 fc fe ff ff callq 400490 <puts@plt>

400594: 48 83 c4 08 add $0x8,%rsp

400598: c3 retq
```

通过对比可以发现，消失的主要是rbp（Base Pointer）相关的指令操作。

那为什么有rpb就可以做栈回溯了呢，我们来看看rpb的相关操作都是什么。

```
40059b: 55 push %rbp

40059c: 48 89 e5 mov %rsp,%rbp

...

4005aa: 5d pop %rbp
```

push %rbp，此时rbp的值是上一个栈帧的开始。

rsp永远指向栈顶，把rsp的值赋给rbp，此时的rbp的地址是当前栈帧的地址。

只要访问rbp的地址就可以串成链表进行栈回溯。关系图如下：

![Java 方法栈帧结构：rbp 保存上一个方法的 rbp 地址，串成链表即可回溯调用栈](/media/halo/image-RaOD-21037449.png)

jdk做了fp的支持。我们可以通过参数-XX:+PreserveFramePointer打开这个功能。

在jdk的工程中，我们可以看到如下的code

```c++
if (PreserveFramePointer) {

mov(rbp, rsp);

}
```

经过上面的描述，可以理解这个代码的作用。

涉及的文件如下

```shell
src/hotspot/cpu/x86/c1_MacroAssembler_x86.cpp

src/hotspot/cpu/x86/c2_MacroAssembler_x86.cpp

src/hotspot/cpu/x86/macroAssembler_x86.cpp
```

**这里划重点，上面的都是jit的代码,也就是说这里不支持解释执行的模式。**

### 公开符号表

公开符号表需要进程和工具一起适配。

首先perf得支持动态的符号，这个社区已经在2009年支持了。

```
perf report: Add support for profiling JIT generated code

  

This patch adds support for profiling JIT generated code to 'perf

report'. A JIT compiler is required to generate a "/tmp/perf-$PID.map"

symbols map that is parsed when looking and displaying symbols.
```

链接见<https://lkml.org/lkml/2009/6/8/499>

perf report的时候可以从/tmp/perf-$PID.map读取符号。java只要能把符号写入这个文件即可。

创建符号的开源项目也有了，就是perf-map-agent，这个项目是一个native的javaagent从jvmti中读取jit的符号然后写入到/tmp/perf-$PID.map中。

因为是nativeagent需要编译。

```
git clone https://github.com/jvm-profiling-tools/perf-map-agent.git

cd perf-map-agent

cmake .

make
```

编译之后，可以在bin目录下执行脚本。

```
./create-java-perf-map.sh pid
```

这样就创建对应pid的文件，文件格式如下

```
[起始地址] [十六进制大小] [符号名称 (Java 方法全名)]
```

案例如下

```
cat /tmp/perf-3794021.map

  

7fd795111cc0 20 Ljava/lang/invoke/MethodHandle;::linkToStatic

7fd795112480 210 Lsun/misc/Unsafe;::getObjectVolatile

7fd795112840 1c0 Ljava/util/concurrent/ConcurrentHashMap;::tabAt

7fd7951132c0 360 Ljava/lang/String;::getChars

7fd795113a40 18 Ljava/lang/invoke/MethodHandle;::linkToStatic

7fd795113be0 80 Ljava/lang/reflect/Method;::getName

7fd795113ea0 c0 Ljava/lang/System;::getSecurityManager
```

## 运行

第一步进程启动增加参数-XX:+PreserveFramePointer

第二步，perfmapagent已经集成了一些操作，我们不用单独把公开符号表和perf分开2个部分。第二步我们直接调用perfmapagent的集成的脚本。

```shell
perf-java-top <pid> <perf-top-options>

perf-java-record-stack <pid> <perf-record-options>

perf-java-report-stack <pid> <perf-report-options>
```

### 问题场景

#### 解释器代码无法看到

根据上面的解析，栈回溯是没有带解释器部分的，所以我们能看到如下的结果。

```java
  

Unsafe_ReallocateMemory+0x6f [libjvm.so]

Lsun/misc/Unsafe;::reallocateMemory+0xaa [perf-4060254.map]

Interpreter+0x27b0 [perf-4060254.map]

Interpreter+0x2c9d [perf-4060254.map]

Interpreter+0x2ce2 [perf-4060254.map]

call_stub+0x88 [perf-4060254.map]

JavaCalls::call_helper(JavaValue*, methodHandle*, JavaCallArguments*, Thread*)+0xe1a [libjvm.so]

JavaCalls::call_virtual(JavaValue*, KlassHandle, Symbol*, Symbol*, JavaCallArguments*, Thread*)+0x263 [libjvm.so]

JavaCalls::call_virtual(JavaValue*, Handle, KlassHandle, Symbol*, Symbol*, Thread*)+0x57 [libjvm.so]

thread_entry(JavaThread*, Thread*)+0x6c [libjvm.so]

JavaThread::thread_main_inner()+0x1c7 [libjvm.so]

JavaThread::run()+0x2fa [libjvm.so]

java_start(Thread*)+0x102 [libjvm.so]

start_thread+0xea [libpthread-2.28.so]
```

Interpreter关键字就是如此。查看符号表

```
7f83f5068620 170 I2C/C2I adapters

7f83f5068820 170 I2C/C2I adapters

7f83f5068a20 170 I2C/C2I adapters

7f83f5068c20 168 I2C/C2I adapters

7f83f5068e20 170 I2C/C2I adapters
```

这个问题在cpu问题上不严重，毕竟运行热点不可能是解释器执行。但是在非cpu上有影响，例如内存泄漏分析。我们可以强制让虚拟机编译执行，这个也有性能损耗，启动可能会变慢。

我们用-Xcomp启动程序

```java
os::realloc(void*, unsigned long, MemoryType)+0x83 [libjvm.so]

Unsafe_ReallocateMemory+0x6f [libjvm.so]

Lsun/misc/Unsafe;::reallocateMemory+0xaa [perf-4190623.map]

LUnsafeTest;::lambda$main$1+0x634 [perf-4190623.map]

LUnsafeTest$$Lambda$2/135721597;::run+0x8c [perf-4190623.map]

Ljava/lang/Thread;::run+0x50 [perf-4190623.map]

call_stub+0x88 [perf-4190623.map]

JavaCalls::call_helper(JavaValue*, methodHandle*, JavaCallArguments*, Thread*)+0xe1a [libjvm.so]

JavaCalls::call_virtual(JavaValue*, KlassHandle, Symbol*, Symbol*, JavaCallArguments*, Thread*)+0x263 [libjvm.so]

JavaCalls::call_virtual(JavaValue*, Handle, KlassHandle, Symbol*, Symbol*, Thread*)+0x57 [libjvm.so]

thread_entry(JavaThread*, Thread*)+0x6c [libjvm.so]

JavaThread::thread_main_inner()+0x1c7 [libjvm.so]

JavaThread::run()+0x2fa [libjvm.so]

java_start(Thread*)+0x102 [libjvm.so]

start_thread+0xea [libpthread-2.28.so]
```

这时候在看就可以看到内存分配的java栈了。

#### 栈顶方法调用看不到

如果只是栈顶，大概率是函数被inline了。有参数可以调整inline的行为

```
-XX:MaxInlineSize=

-XX:FreqInlineSize=
```

这种并不建议调整。调整之后程序不一定按照你的预期来跑。

## 方案限制和扩展

涉及到火焰图方案绕不开asyncprofiler。asyncprofiler的使用更简单，为什么我还推荐perfmapagent。有如下2个角度：

1. asyncprofiler的概率crash。如果是线上环境，需要安全的方案。aync换掉栈回溯方式之后依旧有crash问题。

2.可以直接复用系统工具链，例如native泄漏可以直接使用bcc方案，async需要开发。可以使用ebpf扩展更多的能力。

这个方法有个很大的限制：**符号是快照**。jit是不断的调整的，采集时间很久的话，最开始的符号和最后的符号差距很大。但是采集1min这种影响是有限的。

## 总结

linux系统工具链很丰富，让java融入可以极大的扩展排查问题的边界，但是要损失一些性能，各种测评结果来看，性能损耗在5%以内。
