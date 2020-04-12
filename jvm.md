### 直接内存
|参数|描述|默认值| 
|-|-|-| 
|-XX:MaxDirectMemorySize|最大直接内存直接内存限制|Runtime.getRuntime().maxMemory();| 

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
|-XX:+HeapDumpOnOutOfMemoryError|发生oome的时候触发heapdump|false|
|-XX:+HeapDumpBeforeFullGC|发生fullgc之前触发heapdump|false|
|-XX:+HeapDumpAfterFullGC|发生fullgc之后触发heapdump|false|

### g1
|参数|描述|默认值|
|-|-|-|
|-XX:+UseG1GC|启动g1|java9成为默认|


### debug
|参数|描述|默认值| 
|-|-|-| 
| -agentlib:jdwp=transport=dt_socket,address=5005,server=y,suspend=n |suspend设置为y可以阻塞进程，直到debug连接|-|

### jmx
|参数|描述|默认值| 
|-|-|-|
|-Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false -Dcom.sun.management.jmxremote.port=3000|jmx端口暴露|-|
