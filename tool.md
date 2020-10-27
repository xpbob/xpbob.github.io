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
