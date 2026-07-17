/**
 * 把你录的唱谱叠进视频
 *
 * 1. 用任意录音软件听 stems/01-click.wav（或 02-pitch）跟录
 * 2. 导出为 output/stems/03-vocal.wav（从 0 秒对齐，含预备拍）
 * 3. npm run mix
 *
 * 可选：node src/mix-vocal.mjs /path/to/your-take.wav
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "output");
const STEMS = path.join(OUT, "stems");

const vocalArg = process.argv[2];
const vocalPath = vocalArg
  ? path.resolve(vocalArg)
  : path.join(STEMS, "03-vocal.wav");
const clickPath = path.join(STEMS, "01-click.wav");
const pitchPath = path.join(STEMS, "02-pitch.wav");
const videoIn = path.join(OUT, "demo.mp4");
const mixOut = path.join(OUT, "audio-with-vocal.wav");
const videoOut = path.join(OUT, "demo-with-vocal.mp4");

if (!fs.existsSync(vocalPath)) {
  console.error("找不到人声文件:", vocalPath);
  console.error("请先录音并保存为 output/stems/03-vocal.wav");
  process.exit(1);
}
if (!fs.existsSync(pitchPath) || !fs.existsSync(videoIn)) {
  console.error("请先运行 npm run demo 生成底轨和视频");
  process.exit(1);
}

// 检查人声是否仍是近乎静音占位（文件很小或全 0 很难判，只提示时长）
const vocalStat = fs.statSync(vocalPath);
if (vocalStat.size < 1000) {
  console.error("03-vocal.wav 几乎是空的，请用你的录音覆盖后再 mix");
  process.exit(1);
}

console.log("人声:", vocalPath);
console.log("混音: 人声为主 + 换音导唱压低 + 节拍器更低");

// amix: vocal 1.0, pitch 0.25, click 0.15
const r = spawnSync(
  ffmpegPath,
  [
    "-y",
    "-i",
    vocalPath,
    "-i",
    pitchPath,
    "-i",
    clickPath,
    "-filter_complex",
    "[0:a]volume=1.0,aformat=sample_rates=44100:channel_layouts=mono[v];" +
      "[1:a]volume=0.22,aformat=sample_rates=44100:channel_layouts=mono[p];" +
      "[2:a]volume=0.12,aformat=sample_rates=44100:channel_layouts=mono[c];" +
      "[v][p][c]amix=inputs=3:duration=longest:normalize=0[a]",
    "-map",
    "[a]",
    mixOut,
  ],
  { encoding: "utf8" }
);

if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}

const r2 = spawnSync(
  ffmpegPath,
  [
    "-y",
    "-i",
    videoIn,
    "-i",
    mixOut,
    "-c:v",
    "copy",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:a",
    "aac",
    "-shortest",
    "-movflags",
    "+faststart",
    videoOut,
  ],
  { encoding: "utf8" }
);

if (r2.status !== 0) {
  console.error(r2.stderr);
  process.exit(1);
}

console.log("✅ 已叠人声:", videoOut);
