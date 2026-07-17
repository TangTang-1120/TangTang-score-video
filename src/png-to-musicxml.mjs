/**
 * 內建 PNG/JPG 譜面 → MusicXML（oemer OMR）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT } from "./pair-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".tif",
  ".tiff",
  ".bmp",
]);

/** 專案內模型快取（避免寫入 site-packages 失敗） */
const LOCAL_CKPT = path.join(ROOT, "tools", "oemer-checkpoints");
const OEMER_SITE_CKPT = path.join(
  process.env.HOME || "",
  "Library/Python/3.9/lib/python/site-packages/oemer/checkpoints"
);

const CHECKPOINT_FILES = [
  {
    url: "https://github.com/BreezeWhite/oemer/releases/download/checkpoints/1st_model.onnx",
    rel: path.join("unet_big", "model.onnx"),
    minBytes: 30_000_000,
  },
  {
    url: "https://github.com/BreezeWhite/oemer/releases/download/checkpoints/2nd_model.onnx",
    rel: path.join("seg_net", "model.onnx"),
    minBytes: 10_000_000,
  },
];

// weights.h5 僅 tensorflow 路徑需要；預設用 onnxruntime，可不下載

export function isScoreImage(filePath) {
  return IMG_EXT.has(path.extname(filePath || "").toLowerCase());
}

function fileLooksReady(p, minBytes = 1_000_000) {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > minBytes;
  } catch {
    return false;
  }
}

/** 確保 oemer 模型就緒：優先用專案快取，再同步到套件目錄 */
export function ensureOemerCheckpoints(onLog) {
  const siteModel = path.join(OEMER_SITE_CKPT, "unet_big", "model.onnx");
  // unet model 完整約 40MB+；18MB 視為未完成
  if (
    fileLooksReady(siteModel, 30_000_000) &&
    fileLooksReady(path.join(OEMER_SITE_CKPT, "seg_net", "model.onnx"), 10_000_000)
  ) {
    return true;
  }

  fs.mkdirSync(path.join(LOCAL_CKPT, "unet_big"), { recursive: true });
  fs.mkdirSync(path.join(LOCAL_CKPT, "seg_net"), { recursive: true });

  for (const item of CHECKPOINT_FILES) {
    const local = path.join(LOCAL_CKPT, item.rel);
    const min = item.minBytes || 1_000_000;
    if (!fileLooksReady(local, min)) {
      onLog?.(`下载 OMR 模型: ${path.basename(item.rel)}（首次较久）…`);
      const partial = `${local}.partial`;
      // HTTP/1.1 + 續傳，避免 HTTP2 framing 失敗
      const r = spawnSync(
        "curl",
        [
          "-L",
          "--http1.1",
          "--fail",
          "--retry",
          "5",
          "--retry-delay",
          "2",
          "-C",
          "-",
          "-o",
          partial,
          item.url,
        ],
        { encoding: "utf8", timeout: 900_000 }
      );
      if (r.status !== 0 || !fs.existsSync(partial)) {
        throw new Error(
          `下载 OMR 模型失败: ${item.url}\n${r.stderr || r.stdout || ""}`
        );
      }
      fs.renameSync(partial, local);
      if (!fileLooksReady(local, min)) {
        throw new Error(`OMR 模型不完整: ${local}（${fs.statSync(local).size} bytes）`);
      }
    }

    const site = path.join(OEMER_SITE_CKPT, item.rel);
    fs.mkdirSync(path.dirname(site), { recursive: true });
    if (!fileLooksReady(site, min)) {
      try {
        fs.copyFileSync(local, site);
      } catch (e) {
        try {
          if (fs.existsSync(site)) fs.unlinkSync(site);
          fs.symlinkSync(local, site);
        } catch {
          throw new Error(`无法安装 OMR 模型到 ${site}: ${e?.message || e}`);
        }
      }
    }
  }

  if (!fileLooksReady(siteModel, 30_000_000)) {
    throw new Error("OMR 模型未就绪，请检查 tools/oemer-checkpoints");
  }
  return true;
}

function findOemer() {
  const runner = path.join(ROOT, "tools", "run-oemer.py");
  if (fs.existsSync(runner)) {
    return ["python3", runner];
  }
  const candidates = [
    process.env.OEMER,
    path.join(ROOT, "tools", "oemer-venv", "bin", "oemer"),
    path.join(process.env.HOME || "", "Library/Python/3.9/bin/oemer"),
    path.join(process.env.HOME || "", "Library/Python/3.11/bin/oemer"),
    path.join(process.env.HOME || "", "Library/Python/3.12/bin/oemer"),
    path.join(process.env.HOME || "", ".local/bin/oemer"),
    "/opt/homebrew/bin/oemer",
    "oemer",
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.includes(path.sep) || c.startsWith("/")) {
      if (fs.existsSync(c)) return [c];
      continue;
    }
    const r = spawnSync(c, ["-h"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    if (r.status === 0 || text.includes("img_path") || text.includes("OUTPUT")) {
      return [c];
    }
  }
  return null;
}

function findHomr() {
  const candidates = [
    process.env.HOMR,
    path.join(process.env.HOME || "", "Library/Python/3.9/bin/homr"),
    path.join(process.env.HOME || "", "Library/Python/3.11/bin/homr"),
    path.join(process.env.HOME || "", ".local/bin/homr"),
    "homr",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes(path.sep) || c.startsWith("/")) {
      if (fs.existsSync(c)) return [c];
      continue;
    }
    const r = spawnSync(c, ["-h"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });
    if (r.status === 0 || `${r.stdout || ""}${r.stderr || ""}`.includes("homr")) {
      return [c];
    }
  }
  return null;
}

function findMusicXmlInDir(dir, sinceMs) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(musicxml|xml)$/i.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { p, mtime: st.mtimeMs, size: st.size };
    })
    .filter((x) => x.mtime >= sinceMs - 1000 && x.size > 200)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.p || null;
}

/**
 * @param {string} imagePath
 * @param {string} outDir
 * @param {(msg:string)=>void} [onLog]
 * @returns {Promise<string>} musicxml path
 */
export async function convertImageToMusicXml(imagePath, outDir, onLog) {
  const absImage = path.resolve(imagePath);
  const absOut = path.resolve(outDir);
  if (!fs.existsSync(absImage)) {
    throw new Error(`找不到图片: ${absImage}`);
  }
  fs.mkdirSync(absOut, { recursive: true });

  const cmd = findOemer();
  if (!cmd) {
    throw new Error(
      "尚未安装谱面识别引擎 oemer。请执行：pip3 install --user oemer onnxruntime"
    );
  }

  ensureOemerCheckpoints(onLog);

  // 预处理：转高对比 PNG，提升数字谱 / 截图识别率
  let workImage = absImage;
  try {
    const { default: sharp } = await import("sharp");
    const prepared = path.join(absOut, "prepared.png");
    await sharp(absImage)
      .rotate()
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toFile(prepared);
    workImage = prepared;
    onLog?.("谱面已预处理，开始识别…");
  } catch {
    /* sharp 失败则用原图 */
  }

  const started = Date.now();
  onLog?.("正在把谱面图片转成 MusicXML（光学识谱）…");

  const args = [
    ...cmd.slice(1),
    "-o",
    absOut,
    "--without-deskew",
    workImage,
  ];
  const bin = cmd[0];
  const mplDir = path.join(absOut, ".mplconfig");
  fs.mkdirSync(mplDir, { recursive: true });
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    cwd: absOut,
    env: {
      ...process.env,
      // 強制 CPU，避免缺 CUDA 崩潰
      CUDA_VISIBLE_DEVICES: "",
      ORT_TENSORRT_UNAVAILABLE: "1",
      MPLCONFIGDIR: mplDir,
    },
  });

  const log = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (log.trim()) onLog?.(log.split("\n").slice(-8).join("\n"));

  let xmlPath = findMusicXmlInDir(absOut, started);
  if (!xmlPath) {
    // oemer 有時寫到 CWD
    xmlPath = findMusicXmlInDir(process.cwd(), started);
    if (xmlPath) {
      const dest = path.join(absOut, path.basename(xmlPath));
      fs.copyFileSync(xmlPath, dest);
      xmlPath = dest;
    }
  }

  // 再掃一層：同名 .musicxml（原圖或預處理圖）
  if (!xmlPath) {
    for (const src of [absImage, workImage]) {
      const base = path.basename(src, path.extname(src));
      for (const ext of [".musicxml", ".xml"]) {
        const p = path.join(absOut, base + ext);
        if (fs.existsSync(p) && fs.statSync(p).size > 200) {
          xmlPath = p;
          break;
        }
      }
      if (xmlPath) break;
    }
  }

  if (!xmlPath) {
    throw new Error(
      `谱面识别失败，未产出 MusicXML。\n${(r.stderr || r.stdout || "").slice(0, 1200)}`
    );
  }

  // 統一檔名
  const finalPath = path.join(absOut, "from-image.musicxml");
  if (path.resolve(xmlPath) !== path.resolve(finalPath)) {
    fs.copyFileSync(xmlPath, finalPath);
  }

  // 標記來源
  let xml = fs.readFileSync(finalPath, "utf8");
  if (!/<identification>/i.test(xml)) {
    xml = xml.replace(
      /(<work>[\s\S]*?<\/work>)/i,
      `$1\n  <identification><creator type="software">Tang Tang · oemer OMR</creator></identification>`
    );
  }
  // 確保有速度標記方便後續強制 72
  if (!/<per-minute>/i.test(xml)) {
    xml = xml.replace(
      /(<measure[^>]*number="1"[^>]*>)/i,
      `$1\n      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction>`
    );
  }
  fs.writeFileSync(finalPath, xml, "utf8");
  onLog?.(`MusicXML 已生成: ${finalPath}`);
  return finalPath;
}

export function oemerReady() {
  return !!findOemer();
}

// CLI: node src/png-to-musicxml.mjs image.png [outdir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const img = process.argv[2];
  const out = process.argv[3] || path.join(ROOT, "output", "omr-test");
  if (!img) {
    console.error("用法: node src/png-to-musicxml.mjs <image> [outdir]");
    process.exit(1);
  }
  convertImageToMusicXml(img, out, console.log)
    .then((p) => {
      console.log("OK", p);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
