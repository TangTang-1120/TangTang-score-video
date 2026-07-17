# Tang Tang

上传电子谱（PNG / MusicXML），输出跟唱 + 大提琴跟谱视频。固定速度 ♩=72，画面按把位分色。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/TangTang-1120/TangTang-score-video)

## 本地运行

```bash
npm install
npm start
# 打开 http://127.0.0.1:8787
```

## 一键部署（Render）

1. 打开上面的 **Deploy to Render** 按钮  
2. 用 GitHub 登录 Render，选择本仓库  
3. 按 `render.yaml` 创建 Web Service（Docker）  
4. 部署完成后会得到公网 URL

> 云端默认 `USE_OEMER=0`（不跑 PNG 光学识谱）。上传 MusicXML，或使用仓库内已上架成片画廊。

## 脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 Web 服务 |
| `npm run demo:flow` | 录制 2K 使用流程 Demo |

## 技术栈

Node.js · Express · Verovio · ffmpeg · Playwright（录屏）· oemer（PNG 识谱，可选）
