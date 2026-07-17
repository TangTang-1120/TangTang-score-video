/**
 * Tang Tang 使用流程 Demo（2K + 连音）
 *
 * 流程：
 * 1 首页滑鼠拉响交互大提琴 ~6 秒
 * 2 直接下载 Moon River 大提琴视频
 * 3 上传《一步之遥》→ 生成
 * 4 打开一步之遥大提琴试听并下载
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCORE_PNG = path.join(ROOT, "scores", "一步之遥.png");
const BANNER_AUDIO = path.join(ROOT, "public", "audio", "first-love-cello.mp3");
const OUT_DIR = path.join(ROOT, "output", "demo-flow");
const FRAMES = path.join(OUT_DIR, "frames");
const BASE = process.env.DEMO_BASE || "http://127.0.0.1:8787";
const FFMPEG = path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg");
/** 2K QHD */
const W = 2560;
const H = 1440;
const CRF = "17";
const PRESET = "medium";
const FPS = "10";

fs.mkdirSync(FRAMES, { recursive: true });
for (const f of fs.readdirSync(FRAMES)) {
  fs.unlinkSync(path.join(FRAMES, f));
}

let frameIdx = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ff(...args) {
  const r = spawnSync(FFMPEG, args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-1200));
    throw new Error(`ffmpeg failed: ${args.slice(0, 6).join(" ")}`);
  }
  return r;
}

function probeDuration(file) {
  const r = spawnSync(FFMPEG, ["-i", file], { encoding: "utf8" });
  const m = String(r.stderr || "").match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function snap(page, holdFrames = 8) {
  const buf = await page.screenshot({ type: "jpeg", quality: 95 });
  for (let i = 0; i < holdFrames; i++) {
    fs.writeFileSync(
      path.join(FRAMES, `f_${String(frameIdx++).padStart(5, "0")}.jpg`),
      buf
    );
  }
}

/** ~6 秒拉弓交互（含环境音） */
async function bowOnCello(page) {
  const stage = page.locator("#cello-stage");
  await stage.waitFor({ state: "visible", timeout: 15000 });
  const box = await stage.boundingBox();
  if (!box) return;
  const cx = box.x + box.width * 0.52;
  const cy = box.y + box.height * 0.64;

  await page.evaluate(() => {
    const a = document.getElementById("first-love-audio");
    if (a) {
      a.muted = false;
      a.volume = 0.85;
      a.currentTime = 0;
      a.play().catch(() => {});
    }
  });

  await page.mouse.move(cx - 100, cy);
  await snap(page, 3);
  // 三弓 ≈ 6s @ 10fps
  for (let stroke = 0; stroke < 3; stroke++) {
    await page.mouse.down();
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const dir = stroke % 2 === 0 ? 1 : -1;
      const x = cx + dir * (-100 + t * 200);
      const y = cy + Math.sin(t * Math.PI) * 12;
      await page.mouse.move(x, y);
      await snap(page, 1);
    }
    await page.mouse.up();
    await snap(page, 2);
  }
  await snap(page, 4);
}

async function downloadUrl(page, url, dest) {
  const abs = new URL(url, BASE).toString();
  const res = await page.request.get(abs);
  if (!res.ok()) throw new Error(`下载失败 ${abs} HTTP ${res.status()}`);
  fs.writeFileSync(dest, await res.body());
  return dest;
}

async function main() {
  if (!fs.existsSync(SCORE_PNG)) throw new Error(`缺少谱面 ${SCORE_PNG}`);
  if (!fs.existsSync(FFMPEG)) throw new Error(`缺少 ffmpeg ${FFMPEG}`);

  console.log("启动 Chrome…");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });

  console.log("1 首页 + 拉弓 ~6s");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1000);
  await snap(page, 8);
  await bowOnCello(page);

  console.log("2 下载 Moon River 大提琴");
  await page.locator("#gallery-panel").scrollIntoViewIfNeeded();
  await sleep(400);
  await snap(page, 8);

  // 优先多把位卡，否则任一 Moon River
  let moonCard = page.locator(".video-card").filter({ hasText: "多把位" }).first();
  if ((await moonCard.count()) === 0) {
    moonCard = page.locator(".video-card").filter({ hasText: "Moon River" }).first();
  }
  await moonCard.scrollIntoViewIfNeeded();
  await snap(page, 8);
  const moonDl = moonCard.locator('a.video-card-dl[data-download-name*="大提琴"]');
  await moonDl.hover();
  await snap(page, 6);
  const moonHref = await moonDl.getAttribute("href");
  if (!moonHref) throw new Error("找不到 Moon River 大提琴下载链接");
  const moonPath = path.join(OUT_DIR, "Moon-River-大提琴.mp4");
  await downloadUrl(page, moonHref, moonPath);
  console.log("  已存:", moonPath);
  await snap(page, 6);

  console.log("3 上传《一步之遥》→ 生成");
  await page.locator("#upload-card").scrollIntoViewIfNeeded();
  await snap(page, 8);
  // change 事件会自动 startUpload，无需点「开始输出」
  await page.locator("#file").setInputFiles(SCORE_PNG);
  await sleep(600);
  await snap(page, 8);

  const results = page.locator("#results");
  const progress = page.locator("#progress");
  for (let i = 0; i < 120; i++) {
    if (await results.isVisible().catch(() => false)) break;
    if (await progress.isVisible().catch(() => false)) await snap(page, 2);
    await sleep(400);
  }
  await results.waitFor({ state: "visible", timeout: 240000 });
  await sleep(600);
  await results.scrollIntoViewIfNeeded();
  await snap(page, 12);

  console.log("4 试听一步之遥大提琴 + 下载");
  const celloVideo = page.locator("#v-cello");
  await celloVideo.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const v = document.getElementById("v-cello");
    if (!v) return;
    v.muted = false;
    v.volume = 1;
    v.currentTime = 0;
    v.play().catch(() => {});
  });
  // 试听约 8 秒画面
  for (let i = 0; i < 8; i++) {
    await sleep(900);
    await snap(page, 8);
  }
  await page.locator("#dl-cello").scrollIntoViewIfNeeded();
  await page.locator("#dl-cello").hover();
  await snap(page, 8);
  const celloHref = await page.locator("#dl-cello").getAttribute("href");
  if (!celloHref || celloHref === "#") throw new Error("一步之遥大提琴下载无效");
  const yiBuPath = path.join(OUT_DIR, "一步之遥-大提琴.mp4");
  await downloadUrl(page, celloHref, yiBuPath);
  console.log("  已存:", yiBuPath);
  await snap(page, 10);

  await browser.close();

  const uiFrames = frameIdx;
  console.log(`UI 截帧 ${uiFrames}，合成 2K 带声 Demo…`);

  const uiSilent = path.join(OUT_DIR, "ui-silent.mp4");
  const uiWithAudio = path.join(OUT_DIR, "ui-with-audio.mp4");
  const finalMp4 = path.join(OUT_DIR, "tangtang-flow-demo.mp4");
  const desktop = path.join(
    process.env.HOME || "",
    "Desktop",
    "TangTang-使用流程Demo.mp4"
  );

  ff(
    "-y",
    "-framerate",
    FPS,
    "-i",
    path.join(FRAMES, "f_%05d.jpg"),
    "-c:v",
    "libx264",
    "-preset",
    PRESET,
    "-crf",
    CRF,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "5.1",
    uiSilent
  );

  const uiDur = probeDuration(uiSilent);
  if (fs.existsSync(BANNER_AUDIO) && uiDur > 0.5) {
    ff(
      "-y",
      "-i",
      uiSilent,
      "-stream_loop",
      "-1",
      "-i",
      BANNER_AUDIO,
      "-filter_complex",
      `[1:a]volume=0.5,afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0.5, uiDur - 1.0)}:d=1.0[a]`,
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      "-shortest",
      uiWithAudio
    );
  } else {
    fs.copyFileSync(uiSilent, uiWithAudio);
  }

  // Moon River 下载段：短促展示成片开头（约 6s）
  const moonClip = path.join(OUT_DIR, "moon-clip.mp4");
  ff(
    "-y",
    "-i",
    moonPath,
    "-t",
    "6",
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x070b10,setsar=1`,
    "-c:v",
    "libx264",
    "-preset",
    PRESET,
    "-crf",
    CRF,
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-ar",
    "48000",
    "-pix_fmt",
    "yuv420p",
    moonClip
  );

  // 一步之遥：试听约 12 秒成片原声
  const yiBuClip = path.join(OUT_DIR, "yibu-clip.mp4");
  const yiBuDur = Math.min(12, Math.max(6, probeDuration(yiBuPath) || 12));
  ff(
    "-y",
    "-i",
    yiBuPath,
    "-t",
    String(yiBuDur),
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x070b10,setsar=1`,
    "-c:v",
    "libx264",
    "-preset",
    PRESET,
    "-crf",
    CRF,
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-ar",
    "48000",
    "-pix_fmt",
    "yuv420p",
    yiBuClip
  );

  ff(
    "-y",
    "-i",
    uiWithAudio,
    "-i",
    moonClip,
    "-i",
    yiBuClip,
    "-filter_complex",
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x070b10,setsar=1,fps=${FPS}[v0];` +
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x070b10,setsar=1,fps=${FPS}[v1];` +
      `[2:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x070b10,setsar=1,fps=${FPS}[v2];` +
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];` +
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];` +
      `[2:a]aformat=sample_rates=48000:channel_layouts=stereo[a2];` +
      `[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    PRESET,
    "-crf",
    CRF,
    "-profile:v",
    "high",
    "-level",
    "5.1",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-movflags",
    "+faststart",
    finalMp4
  );

  fs.copyFileSync(finalMp4, desktop);
  const totalDur = probeDuration(finalMp4);
  console.log("完成:", finalMp4);
  console.log("桌面:", desktop);
  console.log(
    `2K ${W}x${H} · 约 ${totalDur.toFixed(1)}s · 拉弓 → Moon River下载 → 上传一步之遥 → 试听下载`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
