### 直接内存
|参数|描述|默认值| 
|-|-|-| 
|-XX:MaxDirectMemorySize|最大直接内存直接内存限制|Runtime.getRuntime().maxMemory();| 

### gc log
|参数|描述|默认值| 
|-|-|-| 
|-XX:+PrintTenuringDistribution|打印ygc 各个年龄带对象的分布|-|
|-XX:+PrintGCApplicationStoppedTime|打印暂停时间|-|
|-XX:+PrintGCApplicationConcurrentTime|进程并发执行时间|-|
|-XX:+PrintHeapAtGC|gc时打印heap信息|-|