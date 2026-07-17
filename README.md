# Tang Tang

上传电子谱（PNG / MusicXML），输出跟唱 + 大提琴跟谱视频。固定速度 ♩=72，画面按把位分色。

## 本地运行

```bash
npm install
npm start
# 打开 http://127.0.0.1:8787
```

## 脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 Web 服务 |
| `npm run demo:flow` | 录制 2K 使用流程 Demo |

## 技术栈

Node.js · Express · Verovio · ffmpeg · Playwright（录屏）· oemer（PNG 识谱，可选）

## 环境变量

- `USE_OEMER=1` 开启 PNG 光学识谱（需本机安装 oemer）
- `PORT` 默认 `8787`
