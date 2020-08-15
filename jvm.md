### 内存参数
|参数|描述|默认值| 
|-|-|-| 
|-XX:+AlwaysPreTouch|初始化的时候堆内存中每个字节都写入'0',启动就达到xms|false|

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


