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
```
git reset --hard origin/master
```
# 回退到某个版本，不删除本地code 
```
git reset --soft id
```
# 回退到具体的版本，删除本地code
```
git reset --hard id
```


# 回退提交

撤销前一次 commit
```
git revert HEAD                  
```
撤销前前一次 commit
```
git revert HEAD^
```
撤回指定commit-id
```
git revert commit-id 
```
比如：git revert 0818badf6882ea2664a205bc8ef3a85425bb2537




# git 强制推送
```
git push -f origin master
``` 
# 查看上次放在缓存区的内容
```
git diff --cached
```
# 查看变动
```
git diff 查看某个变更
```
# 重命名
```
git mv xx xxx
```


# 暂存改动
```
git stash
git stash pop
```

# 打印所有标签
```
git tag
```
