<!--ts-->
   * [用户和邮箱](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#用户和邮箱)
      * [查看用户和邮箱](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#查看用户和邮箱)
      * [设置用户和邮箱](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#设置用户和邮箱)
   * [git 使用远程覆盖本地](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#git-使用远程覆盖本地)
   * [回退到某个版本，不删除本地code](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#回退到某个版本不删除本地code)
   * [回退到具体的版本，删除本地code](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#回退到具体的版本删除本地code)
   * [回退提交](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#回退提交)
   * [保存当前的修改](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#保存当前的修改)
   * [git 强制推送](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#git-强制推送)
   * [查看上次放在缓存区的内容](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#查看上次放在缓存区的内容)
   * [查看变动](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#查看变动)
   * [查看提交记录](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#查看提交记录)
   * [重命名](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#重命名)
   * [暂存改动](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#暂存改动)
   * [标签](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#标签)
      * [打印所有标签](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#打印所有标签)
      * [创建标签(本地)](https://github.com/xpbob/xpbob.github.io/blob/master/git.md#创建标签本地)
<!-- Added by: xie, at: 2020年12月26日 星期六 21时01分17秒 CST -->

<!--te-->
## 更改提交远程的仓库
```
 git remote rm origin
 git remote add origin xx
```


#
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
# push
```
git push <远程主机名> <本地分支名>:<远程分支名>如果本地分支名与远程分支名相同，则可以省略冒号：
git push <远程主机名> <本地分支名>
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

# 保存当前的修改
git stash用于想要保存当前的修改,但是想回到之前最后一次提交的干净的工作仓库时进行的操作.git stash将本地的修改保存起来,并且将当前代码切换到HEAD提交上.
开发到一半,同步远端代码
```
git stash
git pull
git stash pop
```

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

# 查看提交记录
```
git log --stat
```
```
git log --stat -<number> 限制显示历史提交的数量
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
# 标签
## 打印所有标签
```
git tag
```
## 创建标签(本地)
```
git tag 1.0.0
```

