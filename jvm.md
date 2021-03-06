### 内存参数
|参数|描述|默认值| 
|-|-|-| 
|-XX:+AlwaysPreTouch|初始化的时候堆内存中每个字节都写入'0',启动就达到xms，9之后开启了并行，8u60版之前g1不生效|false|
|-Xmx|最大堆|-|

### 容器支持
|参数|描述|默认值|备注|
|-|-|-|-|
|-XX:+UseContainerSupport|识别容器资源|true|java10|

### aot
|参数|描述|默认值| 
|-|-|-| 
| -XX:+PrintAOT|打出使用aot的klasses和method|-| 
|-XX:AOTLibrary|指定aot的库的位置|-|


### lambda
|参数|描述|默认值| 
|-|-|-|
|-Djdk.internal.lambda.dumpProxyClasses|设置动态生成的lambda表达式的存放位置|-|


### 直接内存
|参数|描述|默认值| 
|-|-|-| 
|-XX:MaxDirectMemorySize|最大直接内存直接内存限制|Runtime.getRuntime().maxMemory();| 

### metaspace
|参数|描述|默认值| 
|-|-|-| 
|-XX:CompressedClassSpaceSize|指针压缩空间大小|1g| 

### gc log
|参数|描述|默认值| 
|-|-|-| 
|-XX:+PrintGCDetails|输出详细的日志|false|
|-XX:+PrintTenuringDistribution|打印ygc 各个年龄带对象的分布|false|
|-XX:+PrintGCApplicationStoppedTime|打印暂停时间|false|
|-XX:+PrintGCApplicationConcurrentTime|进程并发执行时间|false|
|-XX:+PrintHeapAtGC|gc时打印heap信息|false|
|-XX:+PrintGCDateStamps|以日期的形式打印时间戳|false|
|-XX:+PrintGCTimeStamps|相对时间打印时间戳,单位s|true|
|-Xloggc:|gclog位置|-|

### gc公用参数
|参数|描述|默认值| 
|-|-|-|
|-XX:+ParallelRefProcEnabled|开启多线程处理引用|false|
| -XX:ParallelGCThreads=|gc线程个数|当 CPU 数量小于8， ParallelGCThreads 的值等于 CPU 数量，当 CPU 数量大于 8 时，ParallelGCThreads = 8 + ((N - 8) * 5/8)|

### heap dump
|参数|描述|默认值| 
|-|-|-| 
|-XX:+HeapDumpOnOutOfMemoryError|发生oome的时候触发heapdump|false|
|-XX:+HeapDumpBeforeFullGC|发生fullgc之前触发heapdump|false|
|-XX:+HeapDumpAfterFullGC|发生fullgc之后触发heapdump|false|
|-XX:HeapDumpPath|heapdump的路径，可以写路径或者文件名,路径一定要存在|java_pid<pid>.hprof|

### g1
|参数|描述|默认值|
|-|-|-|
|-XX:+UseG1GC|启动g1|java9成为默认|


### cms
|参数|描述|默认值|
|-|-|-|
|-XX:+UseConcMarkSweepGC|开启cms|-|
|-XX:PretenureSizeThreshold|超过设置*字节大小*的对象会直接分配在老年代|0|

### ps
|参数|描述|默认值|
|-|-|-|
|-XX:+UseParallelGC|开启ps|-|
|-XX:+UseParallelOldGC|开启ps old|-|

### Serial
|参数|描述|默认值|
|-|-|-|
|-XX:+UseSerialGC|开启Serial|-|


### debug
|参数|描述|默认值| 
|-|-|-| 
| -agentlib:jdwp=transport=dt_socket,address=5005,server=y,suspend=n |suspend设置为y可以阻塞进程，直到debug连接|-|

### jmx
|参数|描述|默认值| 
|-|-|-|
|-Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false -Dcom.sun.management.jmxremote.port=3000|jmx端口暴露|-|


### nmt
|参数|描述|默认值| 
|-|-|-|
|-XX:NativeMemoryTracking=|开启nmt||
|jcmd pid VM.native_memory detail/baseline/detail.diff/summary|利用jcmd查看内存变化||


### jfr
|参数|描述|默认值| 备注|
|-|-|-|-|
|dumponexit|jvm退出时生成jfr|false||
|duration|记录的持续时间|0|(s)econds, (m)inutes, (h)ours, or (d)ays|
|filename|生成的文件名|hotspot-pid-${pid}-id-${count}-${time}.jfr||
|disk|是否写入磁盘|true|global buffer 满了之后，是直接丢弃还是写入磁盘文件|
|maxage|写入磁盘最大的时间间隔|0|in (s)econds, (m)inutes, (h)ours, or (d)ays，0是没有限制|
|maxsize|写入磁盘的文件大小|0|in (M)B or (G)B.0是没有限制|
|path-to-gc-roots|收集 gc root路径|false||
|-XX:StartFlightRecording=|开启jfr||

### 公用参数
|参数|描述|默认值| 
|-|-|-|
|-Djava.util.Arrays.useLegacyMergeSort|使用归并排序|false|

