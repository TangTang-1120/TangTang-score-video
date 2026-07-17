# Tang Tang · 公网部署（推荐：GitHub Codespaces）

不依赖本机、不需要 Render / Zeabur 邮箱。

## 三步上线

### 1. 打开创建页（必须用已登录 GitHub 的浏览器）

https://github.com/codespaces/new?hide_repo_select=true&ref=main&repo=TangTang-1120/TangTang-score-video

确认仓库名是 **TangTang-score-video**，点绿色 **「创建新的代码空间」**。

> 不要在 Mac 自己的「终端.app」里跑 npm。那是本机，不是公网。

### 2. 等浏览器里出现 VS Code / 代码编辑器

下方会自动跑服务。若没有，点菜单 **终端 → 新建终端**，粘贴：

```bash
npm install --omit=dev && NODE_ENV=production USE_OEMER=0 PORT=8787 node src/server.mjs
```

看到 `Tang Tang` 和端口 `8787` 即成功。

### 3. 把端口设为 Public，复制公网链接

1. 点顶部或左侧 **「端口 / Ports」**
2. 找到 **8787**
3. 右键 / 地球图标 → **端口可见性 → 公共 / Public**
4. 复制地址（形如 `https://xxxxx-8787.app.github.dev`）
5. 用手机或另一台电脑打开验证

把该链接发给助手即可帮你复查。

## 说明

- Codespaces 有免费额度；闲置会休眠，再次打开稍等即可
- 仓库已含成片画廊；云端默认关闭 OMR（`USE_OEMER=0`）
