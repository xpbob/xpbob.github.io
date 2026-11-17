---
title: "GC 触发 crash，根因却是 unsafe"
slug: gc-crash-unsafe-boundary
date: 2026-04-26
category: JVM 内存与 GC
tags:
  - GC
  - unsafe
  - 排障
summary: "进程在 YGC 里 SIGSEGV 挂掉，堆栈指向 G1 的 copy_to_survivor_space——看起来像 GC 的 bug。换收集器仍然崩，才说明 JVM 对象模型已被破坏。unsafe 的错误写入不会立刻报错，直接原因与根因的现场差距可以非常大。"
featured: true
---

## 背景

用户 jvm 进程偶发 crash，报错信息如下

```c++
G1ParScanThreadState::copy_to_survivor_space(InCSetState, oopDesc*, markOopDesc*) ()
```

根据堆栈来看，G1 gc 在 ygc过程中内存访问错误，这个是进程挂掉的直接原因。  
从错误信息看好像是 jvm gc 的 bug，遇到这种情况，建议换一个 gc 类型再跑程序，如果在 gc 阶段依旧 crash，说明问题不是在 gc 上，而是 jvm 对象模型被破坏了，gc 根据对象模型扫描对象，访问到错误的内存地址，触发 crash。  
相似的场景社区 bug上也有记录<https://bugs.openjdk.org/browse/JDK-8317577>

下面我们详细讲述一下jvm 对象模型破坏的形式和分析这类问题的方法。

## jvm 对象模型破坏的形式

jvm 对象模型可以简单用如下表格展示

| 结构 | 组成 | 64 位操作系统大小 |
| --- | --- | --- |
|  | MarkWord | 8 字节 |
| 对象头 | 指针 | 在开启指针压缩的状况下占 4 字节，未开启状况下占 8 字节。 |
|  | 数组长度（只有数组有） | 4 字节 |
| 实例数据 |  |  |
| 对齐填充 |  | 8 字节对齐 |

从这个表格，我们可以看到我们构建一个 java 对象，除了数据之外，会多对象头，对齐填充的部分。  
对象头大小也不是固定的。

1. 类型不同组成也不同，例如数组会多一个数组长度。
2. 指针压缩会影响指针长度。开启压缩是 4，不开启是 8。

如果是通过 java语法创建对象，jvm 虚拟机会自动按照上述的规则排放。jdk 也暴露了一个 unsafe接口可以绕开上面的规则直接修改。例如下面的方法，填入一个对象，一个偏移量，一个double，就可以把double写入对象对应的偏移量中。

```
public void putDouble(Object o, long offset, double x) {  
    beforeMemoryAccess();  
    theInternalUnsafe.putDouble(o, offset, x);  
}
```

这里容易出现 2 个错误。  
错误 1：偏移量计算错误  
对象头大小至少考虑 2 种情况，常见的就是指针问题，压缩和不压缩的长度不同，jdk 默认heap 32g以下自动开启压缩，heap 超过 32g 自动关闭压缩。本地编写代码一般是不会超过 32g，就会出现 32g以下程序正常运行，超过 32g 就 crash 的情况。  
错误 2：对象类型错误  
例如声明是 int 类型，调用了putDouble。

虽然知道了错误的原因，但是现象是无法和原因对齐的。unsafe 调用不会立刻报错，下次按照正常的对象规则读取才触发，**这就导致了直接原因和根因现场差距很大**。

## 解决方案

直接原因和根因差距比较大的情况，我们可以不断的缩小范围，并且记录小范围内的堆栈记录，来进行排查。

缩小范围的方式很简单，可以通过 gc 去校验。如果 gc 不频繁的情况，可以使用主动的方式，例如 system.gc 和 jcmd GC.run。只要 gc 成功说明之前的所有操作都是正常的。范围缩小之后，unsafe的操作堆栈就会变的比较少，人可以根据堆栈和代码结合分析。很多时候 unsafe并不是我们的代码直接操作的，而是通过 maven 引入的第三方包，间接调用的。想在自己的代码埋点是无法分析的。想从底层埋点，不同版本的 jdk 的方法是不一样的，我们从高到低分为 23，11，8 三个版本方案。

### jdk23

unsafe api 过于依赖编写代码的人，稍有不慎就会破坏模型。社区已经要删除 unsafe 用更安全的 api 替换，jdk23 是一个重要版本，提供了记录 unsafe堆栈的能力，帮助用户发现自己 unsafe 代码的调用，从而让用户迁移 api。  
我们可以通过参数启动记录 unsafe 堆栈。

```
--sun-misc-unsafe-memory-access=debug
```

开启之后，我们就会看到如下的输出。

```
WARNING: sun.misc.Unsafe::putInt called by UnsafeCrash (file:xx)
        at UnsafeCrash.main(UnsafeCrash.java:58)
```

可以看到我在UnsafeCrash中调用了Unsafe的putInt。

### jdk11

jdk 自带的记录是 23 才能有，从 11 到 23，就需要另外一种方式。这里只标注 11，因为目前不会有人使用 jdk9和 jdk10。  
jdk 模块化之后，把 unsafe的实现都迁移到jdk.internal.misc.Unsafe。对外使用的还是sun.misc.Unsafe，但是把所有方法做了一个代理。

```java
    @ForceInline
    public int getIntVolatile(Object o, long offset) {
        return theInternalUnsafe.getIntVolatile(o, offset);
    }
```

这个代理，把所有的实现都换成了 java。我们可以利用 bci 的能力来记录。如果是分布式软件，我们可以写一个 javaagent，下面展示ByteBuddy的字节码修改，非常简单。

```java
       new AgentBuilder.Default()
            .ignore(none()) // 不要忽略 JDK 核心类
            .with(AgentBuilder.TypeStrategy.Default.REDEFINE) 
            .type(named("sun.misc.Unsafe"))
            .transform((builder, typeDescription, classLoader, module) -> 
                builder.method(any()) // 拦截所有方法
                       .intercept(MethodDelegation.to(UnsafeInterceptor.class))
            ).installOn(instrumentation);
```

只要写一个 javaagent 就行。如果是单个的 java 进程，我们还可以用 arthas。

```
options unsafe true
stack sun.misc.Unsafe *  -n 100000
```

### jdk8

jdk8 unsafe 的实现还是以 native 方法为主。无法延用 bci 的方式。

```java
    public final native boolean compareAndSwapInt(Object o, long offset,
                                                  int expected,
                                                  int x);
```

jdk 并没有把这些方法保留成 uprobe，所以系统软件的方式也不适合，我们可以写一个 nativeagent 来拦截函数替换，这里用到了 jvmti 的能力。

```c++
    jvmtiEventCallbacks callbacks;
    memset(&callbacks, 0, sizeof(callbacks));
    callbacks.NativeMethodBind = cb_NativeMethodBind;
```

注册一个NativeMethodBind的 callback。

```c++
void JNICALL NativeMethodBind(
    jvmtiEnv *jvmti_env,
    JNIEnv* jni_env,
    jthread thread,
    jmethodID method,
    void* address,        // 原始 C 函数的地址
    void** new_address_ptr // 允许你写入新的函数地址，替换掉原始地址
)
```

我们可以拦截 jni 的绑定，把自己写的代理方法替换掉原来的 jni。

```c++
static void JNICALL wrap_putInt_obj(JNIEnv *env, jobject self, jobject obj, jlong offset, jint val) {
    char tname[128]; get_thread_name(env, tname, sizeof(tname));
    LOG("[%s] putInt(obj=%p, offset=%ld, value=0x%08x)",
        tname, (void*)obj, (long)offset, (unsigned int)val);
    print_java_stack(env);
    //原来的函数指针
    orig_putInt_obj(env, self, obj, offset, val);
}
```

写一个 nativeagent 也是一种负担，虽然可以借助 ai，稍微压力小一点。如果我们能明确 unsafe 的调用方法，我们还可以依赖 async，目前只支持关注一个方法。  
因为都是 jni，我们现得查看unsafe jni 的符号。

```
0000000000afe390 t Unsafe_SetLong
0000000000affd40 t Unsafe_SetLong140
0000000000af8270 t Unsafe_SetLongVolatile
0000000000aff680 t Unsafe_SetMemory
0000000000b000a0 t Unsafe_SetMemory2
0000000000afa4e0 t Unsafe_SetNativeAddress
0000000000afcbf0 t Unsafe_SetNativeByte
0000000000afc2d0 t Unsafe_SetNativeChar
0000000000afcdc0 t Unsafe_SetNativeDouble
0000000000afcf90 t Unsafe_SetNativeFloat
0000000000afc100 t Unsafe_SetNativeInt
0000000000af8cd0 t Unsafe_SetNativeLong
0000000000afbf30 t Unsafe_SetNativeShort
0000000000af5bb0 t Unsafe_SetObject
0000000000b00790 t Unsafe_SetObject140
0000000000af6720 t Unsafe_SetObjectVolati
```

不同版本的 jdk 的符号会有出入，要根据使用中的libjvm.so来查看。获得符号也可以直接调用asprof，不过asprof是采集一段时间的结合，需要配合缩小时间来操作，否则还没拿到收集的结果就触发 crash 了。

```
asprof -e Unsafe_SetNativeInt
```

## 总结

1. 遇到 crash 的堆栈在 gc的情况，应该现换个 gc 来看看是否是 gc 的 bug。
2. 确认是对象模型被破坏的场景，我们可以通过缩小范围+记录 unsafe 堆栈的方式追踪根因栈。
3. 追踪堆栈方案按照方便程度程度排序 jdk23>jdk11>jdk8
4. 社区已经有替换 unsafe api 的方案，替换方案，可以绕开unsafe 引发的 crash。
