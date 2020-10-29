# 上下文切换
pidstat -w pid命令，cswch和nvcswch表示自愿及非自愿切换。  
vmstat, cs(context switch)一列则代表了上下文切换的次数。

# 任务
位置
```
/etc/systemd/system/
```
- 编写
```
[Unit]
Description=TestJava
After=network.target

[Service]
Type=forking
ExecStart=startTest.sh
ExecStop=stopTest.sh
Restart=always
RestartSec=5
StartLimitInterval=0

[Install]
WantedBy=multi-user.target
```

- 启动
```
systemctl start my.service 
```
- 刷新
```
systemctl daemon-reload
```
- 开机自启动
```
systemctl enable xx.service 
```
# 日志
```
journalctl -u service-name.service
```

# 查找
find [路径]  [选项] [操作]
- -name 按照名称查找
- -iname 按照名称查找，忽略大小写
- -type 按照类型去查找  

|type|名称|
|-|-|
|f|文件|
|d|目录|
|c|字符设备|
|b|块设备|
|l|连接|
|p|管道|

- -size 按照大小
-size +1M 代表大于1m -1m 代表小于1m
- -exec 对搜索到的文件执行特定的操作
