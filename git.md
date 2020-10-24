# 用户和邮箱
## 查看用户和邮箱
```
git config user.name
git config user.email
```
## 设置用户和邮箱
```
git config --global user.name "username"
git config --global user.email "email"
```

# git 使用远程覆盖本地
git reset --hard origin/master

# 回退到某个版本，不删除本地code 
git reset --soft id

# 回退到具体的版本，删除本地code
git reset --hard id


# git 强制推送
git push -f origin master
 
