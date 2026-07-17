/**
 * Tang Tang 𝄢
 * 上傳 MusicXML 或譜面 PNG → 唱音階 + 大提琴（含指法）· ♩=72
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { generatePair, ROOT } from "./pair-engine.mjs";
import { isScoreImage } from "./png-to-musicxml.mjs";
import {
  matchScoreImage,
  getSampleById,
  listSampleScores,
  saveOmrCache,
  registerRecognizedScore,
  guessTitleFromImagePath,
  imageFingerprint,
} from "./image-match.mjs";
import {
  ingestScore,
  listLibrary,
  listFeaturedScores,
  getLibraryFile,
} from "./score-library.mjs";
import {
  publishGalleryVideo,
  listGallery,
  getGalleryCello,
  getGalleryFile,
  galleryRoot,
} from "./video-gallery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const JOBS = path.join(ROOT, "output", "jobs");
const PORT = Number(process.env.PORT) || 8787;
/** 預設開 OMR（只有 PNG 也能用）；設 USE_OEMER=0 可關掉 */
const USE_OEMER = process.env.USE_OEMER !== "0";
/** 谱库后台密码：环境变量 ADMIN_PASSWORD，默认 tangtang */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "tangtang";
const ADMIN_SECRET =
  process.env.ADMIN_SECRET ||
  crypto.createHash("sha256").update(`tt-admin:${ADMIN_PASSWORD}`).digest("hex");
const ADMIN_COOKIE = "tt_admin";
const ADMIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 本地 banner：用系统 afplay 出声，绕过浏览器自动播放限制 */
const BANNER_AUDIO =
  [
    path.join(PUBLIC, "audio/first-love-cello.wav"),
    path.join(PUBLIC, "audio/first-love-cello.mp3"),
    path.join(PUBLIC, "audio/hao-jiu-bu-jian-cello.wav"),
    path.join(PUBLIC, "audio/hao-jiu-bu-jian-cello.mp3"),
  ].find((p) => fs.existsSync(p)) || null;
let bannerWanted = false;
let bannerProc = null;

function stopBannerAudio() {
  bannerWanted = false;
  if (!bannerProc) return;
  const proc = bannerProc;
  bannerProc = null;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* noop */
  }
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }, 200);
}

function startBannerAudio() {
  if (!BANNER_AUDIO) return false;
  bannerWanted = true;
  if (bannerProc) return true;
  const run = () => {
    if (!bannerWanted) return;
    bannerProc = spawn("afplay", ["-v", "0.85", BANNER_AUDIO], {
      stdio: "ignore",
    });
    bannerProc.on("exit", () => {
      bannerProc = null;
      if (bannerWanted) setTimeout(run, 30);
    });
  };
  run();
  return true;
}

function ensureBannerAudio() {
  if (!bannerWanted) return startBannerAudio();
  if (!bannerProc) return startBannerAudio();
  return true;
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf("=");
    if (i < 0) continue;
    const k = trimmed.slice(0, i);
    const v = trimmed.slice(i + 1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function signAdminToken(exp) {
  const payload = `admin.${exp}`;
  const sig = crypto
    .createHmac("sha256", ADMIN_SECRET)
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "admin") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = signAdminToken(exp);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

function isAdmin(req) {
  const cookies = parseCookies(req);
  if (verifyAdminToken(cookies[ADMIN_COOKIE])) return true;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ") && verifyAdminToken(auth.slice(7))) return true;
  return false;
}

function setAdminCookie(res, token) {
  const maxAge = Math.floor(ADMIN_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(PUBLIC, { recursive: true });
// 不再灌入手工模版曲库；谱库只收真实上传／OMR 结果

const jobs = new Map();
let busy = false;
const queue = [];

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const id = crypto.randomBytes(6).toString("hex");
      const dir = path.join(JOBS, id);
      fs.mkdirSync(dir, { recursive: true });
      _req.jobId = id;
      _req.jobDir = dir;
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext =
        path.extname(file.originalname || "").toLowerCase() || ".musicxml";
      cb(null, `upload${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    const mime = file.mimetype || "";
    const ok =
      name.endsWith(".musicxml") ||
      name.endsWith(".xml") ||
      name.endsWith(".mxl") ||
      name.endsWith(".png") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".webp") ||
      mime.includes("xml") ||
      mime.startsWith("image/");
    cb(
      ok
        ? null
        : new Error("请上传 MusicXML 或谱面图片（.png / .jpg / .musicxml）"),
      ok
    );
  },
});

function publicJob(job) {
  const base = {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    title: job.title,
    error: job.error,
    createdAt: job.createdAt,
    match: job.match || null,
  };
  if (job.status !== "done") {
    return { ...base, videos: null, downloads: null, fingeringsUrl: null };
  }
  return {
    ...base,
    videos: {
      solfege: `/jobs/${job.id}/唱音阶.mp4`,
      cello: `/jobs/${job.id}/大提琴.mp4`,
    },
    downloads: {
      solfege: `/api/jobs/${job.id}/download/solfege`,
      cello: `/api/jobs/${job.id}/download/cello`,
      fingerings: `/api/jobs/${job.id}/download/fingerings`,
      musicxml: `/api/jobs/${job.id}/download/musicxml`,
    },
    fingeringsUrl: `/jobs/${job.id}/fingerings.json`,
  };
}

function sendDownload(res, filePath, downloadName) {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "文件不存在" });
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  );
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(filePath).pipe(res);
}

function copyAsJobMusicXml(srcXml, jobDir) {
  const dest = path.join(jobDir, "from-image.musicxml");
  fs.copyFileSync(srcXml, dest);
  return dest;
}

/**
 * 圖片 → MusicXML：
 * 1) 毫秒級對已知譜／OMR 快取
 * 2) 未命中則跑 oemer（首次慢，結果會快取）
 */
async function resolveImageToMusicXml(job) {
  job.stage = "match";
  job.percent = 4;
  job.message = "快速对谱中…";

  const hit = await matchScoreImage(job.uploadPath);
  if (hit) {
    job.match = { id: hit.id, title: hit.title, method: hit.method };
    job.message =
      hit.method === "omr-cache"
        ? `命中 OMR 缓存「${hit.title}」，秒级出片`
        : `已对上「${hit.title}」，跳过识别`;
    job.percent = 12;
    return copyAsJobMusicXml(hit.musicxml, job.dir);
  }

  if (!USE_OEMER) {
    throw new Error(
      "这张 PNG 需要开启光学识谱。请设置 USE_OEMER=1 后重启服务。"
    );
  }

  const { convertImageToMusicXml, oemerReady } = await import(
    "./png-to-musicxml.mjs"
  );
  if (!oemerReady()) {
    throw new Error(
      "只有 PNG 需要 OMR 引擎。请执行：pip3 install --user oemer onnxruntime"
    );
  }

  job.stage = "omr";
  job.percent = 6;
  job.message = "正在识别谱面（PNG → MusicXML，首次较慢）…";
  const omrDir = path.join(job.dir, "omr");
  const guessedTitle = guessTitleFromImagePath(
    job.uploadOriginalName || job.uploadPath
  );
  const xml = await convertImageToMusicXml(job.uploadPath, omrDir, (msg) => {
    job.message = String(msg).split("\n").filter(Boolean).pop() || job.message;
  });

  // 写入识别出的曲名
  try {
    let raw = fs.readFileSync(xml, "utf8");
    if (!/<work-title[^>]*>/i.test(raw)) {
      raw = raw.replace(
        /<score-partwise[^>]*>/i,
        (m) => `${m}\n  <work><work-title>${guessedTitle}</work-title></work>`
      );
    } else {
      raw = raw.replace(
        /<work-title[^>]*>[^<]*<\/work-title>/i,
        `<work-title>${guessedTitle}</work-title>`
      );
    }
    fs.writeFileSync(xml, raw, "utf8");
  } catch {
    /* 标题写入失败不影响出片 */
  }

  const cached = await saveOmrCache(job.uploadPath, xml, guessedTitle);
  const fp = await imageFingerprint(job.uploadPath);
  const recId = `rec-${fp.slice(0, 10)}`;
  try {
    registerRecognizedScore({
      id: recId,
      title: guessedTitle,
      musicXmlPath: cached,
      imagePath: job.uploadPath,
    });
  } catch {
    /* 扩展库失败不影响本次出片 */
  }

  job.match = { id: recId, title: guessedTitle, method: "omr" };
  job.message = `识别完成「${guessedTitle}」，开始出片…`;
  job.percent = 12;
  return copyAsJobMusicXml(cached, job.dir);
}

async function runJob(job) {
  job.status = "running";
  job.message = "开始处理";
  busy = true;
  try {
    let musicXmlPath = job.uploadPath;
    if (job.sampleId) {
      const sample = getSampleById(job.sampleId);
      if (!sample) throw new Error(`找不到试听谱：${job.sampleId}`);
      musicXmlPath = copyAsJobMusicXml(sample.musicxml, job.dir);
      job.match = { id: sample.id, title: sample.title, method: "sample" };
      job.percent = 12;
      job.message = `试听「${sample.title}」，直接出片…`;
    } else if (isScoreImage(job.uploadPath)) {
      musicXmlPath = await resolveImageToMusicXml(job);
      job.musicXmlPath = musicXmlPath;
      job.percent = Math.max(job.percent, 12);
      job.message = job.message || "对谱完成，开始出片…";
    }

    // 默认极速出片（试听／上传／MusicXML 全开）
    const fast = job.fast !== false;

    const result = await generatePair({
      musicXmlPath,
      workDir: job.dir,
      fast,
      onProgress: ({ stage, percent, message }) => {
        job.stage = stage;
        job.percent = Math.max(job.percent, Math.round(12 + percent * 0.88));
        job.message = message;
      },
    });
    job.title = result.title;
    job.status = "done";
    job.percent = 100;
    job.message = result.fromCache
      ? "命中成片缓存，已秒级完成"
      : "两支视频已就绪（含指法）";
    job.result = result;
    try {
      const celloFile =
        result.files?.cello || path.join(job.dir, "大提琴.mp4");
      const solfegeFile =
        result.files?.solfege || path.join(job.dir, "唱音阶.mp4");
      if (fs.existsSync(celloFile)) {
        const galleryId =
          job.match?.id ||
          `job-${job.id}`;
        publishGalleryVideo({
          id: galleryId,
          title: result.title || job.match?.title || "成片",
          artist: job.match?.artist || null,
          celloPath: celloFile,
          solfegePath: fs.existsSync(solfegeFile) ? solfegeFile : null,
        });
      }
    } catch {
      /* 画廊失败不影响出片 */
    }
    try {
      const xmlPath =
        result.files?.score ||
        job.musicXmlPath ||
        [
          path.join(job.dir, "score.musicxml"),
          path.join(job.dir, "from-image.musicxml"),
        ].find((p) => fs.existsSync(p));
      if (xmlPath) {
        const isOmr = job.match?.method === "omr" || job.match?.method === "omr-cache";
        ingestScore({
          musicXmlPath: xmlPath,
          title: result.title || job.match?.title,
          artist: job.match?.artist || null,
          source: isOmr ? "omr" : job.sampleId ? "demo" : "upload",
          preferredId: job.match?.id || job.sampleId || null,
          featured: isOmr || !job.sampleId,
        });
      }
    } catch {
      /* 入库失败不影响出片 */
    }
  } catch (e) {
    job.status = "error";
    job.error = e?.message || String(e);
    job.message = "处理失败";
  } finally {
    busy = false;
    const next = queue.shift();
    if (next) runJob(next);
  }
}

function enqueue(job) {
  jobs.set(job.id, job);
  if (busy) {
    job.status = "queued";
    job.message = "排队中…";
    queue.push(job);
  } else {
    runJob(job);
  }
}

function createJobShell(extra = {}) {
  const id = crypto.randomBytes(6).toString("hex");
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  return {
    id,
    dir,
    uploadPath: null,
    sampleId: null,
    status: "queued",
    stage: "upload",
    percent: 0,
    message: "排队中…",
    title: null,
    error: null,
    match: null,
    createdAt: Date.now(),
    ...extra,
  };
}

const app = express();
app.use(
  express.static(PUBLIC, {
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
    etag: true,
  })
);
app.use(
  "/jobs",
  express.static(JOBS, {
    maxAge: "5m",
    etag: true,
  })
);
app.use(
  "/gallery",
  express.static(galleryRoot(), {
    maxAge: "1h",
    etag: true,
  })
);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    tempo: 72,
    fingering: true,
    fastMatch: true,
    omr: USE_OEMER,
    bannerAudio: Boolean(BANNER_AUDIO),
    samples: listSampleScores().map((s) => ({ id: s.id, title: s.title })),
  });
});

app.get("/api/samples", (_req, res) => {
  res.json({ samples: listSampleScores() });
});

app.get("/api/library", (_req, res) => {
  res.json({ entries: listLibrary({ includeDownload: false }) });
});

/** 首页成片小卡 */
app.get("/api/gallery", (_req, res) => {
  res.json({ entries: listGallery() });
});

app.get("/api/gallery/:id/download/:kind", (req, res) => {
  const kind = req.params.kind === "solfege" ? "solfege" : "cello";
  const hit = getGalleryFile(req.params.id, kind);
  if (!hit) {
    res.status(404).json({ error: kind === "solfege" ? "找不到跟唱成片" : "找不到大提琴成片" });
    return;
  }
  sendDownload(res, hit.filePath, hit.downloadName);
});

// 兼容旧链接 → 大提琴
app.get("/api/gallery/:id/download", (req, res) => {
  const hit = getGalleryFile(req.params.id, "cello") || getGalleryCello(req.params.id);
  if (!hit) {
    res.status(404).json({ error: "找不到成片" });
    return;
  }
  sendDownload(res, hit.filePath, hit.downloadName);
});

/** 首页：真识谱成功的下载卡（兼容旧接口） */
app.get("/api/featured", (_req, res) => {
  res.json({ entries: listGallery() });
});

app.get("/api/admin/me", (req, res) => {
  res.json({ ok: true, admin: isAdmin(req) });
});

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "");
  const ok =
    password.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(ADMIN_PASSWORD)
    );
  if (!ok) {
    res.status(401).json({ ok: false, error: "密码错误" });
    return;
  }
  const token = signAdminToken(Date.now() + ADMIN_TTL_MS);
  setAdminCookie(res, token);
  res.json({ ok: true, admin: true });
});

app.post("/api/admin/logout", (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true, admin: false });
});

app.get("/api/admin/library", (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).json({ error: "需要管理员登录" });
    return;
  }
  res.json({ entries: listLibrary({ includeDownload: true }) });
});

app.get("/api/library/:id/download", (req, res) => {
  const hit = getLibraryFile(req.params.id);
  if (!hit) {
    res.status(404).json({ error: "谱库中找不到这首" });
    return;
  }
  // 首页已识谱卡：公开下载；其余仍需管理员
  const featured =
    hit.entry.featured === true ||
    hit.entry.source === "omr" ||
    hit.entry.source === "upload";
  if (!featured && !isAdmin(req)) {
    res.status(401).json({ error: "仅管理员可下载" });
    return;
  }
  sendDownload(res, hit.filePath, hit.downloadName);
});

/** 鼠标悬停拉弓：本机用 afplay 播放，不受浏览器自动播放策略限制 */
app.post("/api/banner-audio/start", (_req, res) => {
  if (!BANNER_AUDIO) {
    res.status(404).json({ ok: false, error: "缺少 banner 音档" });
    return;
  }
  const ok = startBannerAudio();
  res.json({ ok, playing: bannerWanted && Boolean(bannerProc) });
});

app.post("/api/banner-audio/ensure", (_req, res) => {
  if (!BANNER_AUDIO) {
    res.status(404).json({ ok: false, error: "缺少 banner 音档" });
    return;
  }
  const ok = ensureBannerAudio();
  res.json({ ok, playing: bannerWanted && Boolean(bannerProc) });
});

app.post("/api/banner-audio/stop", (_req, res) => {
  stopBannerAudio();
  res.json({ ok: true, playing: false });
});

/** 一键试听：跳過上傳／OMR，直接用內建 MusicXML 出片 */
app.post("/api/demo/:id", (req, res) => {
  const sample = getSampleById(req.params.id);
  if (!sample) {
    res.status(404).json({ error: "未知试听谱" });
    return;
  }
  const job = createJobShell({
    sampleId: sample.id,
    message: `试听「${sample.title}」…`,
  });
  enqueue(job);
  res.json(publicJob(job));
});

app.post("/api/upload", (req, res) => {
  upload.single("score")(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err.message || "上传失败" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "请选择乐谱文件" });
      return;
    }
    const job = {
      id: req.jobId,
      dir: req.jobDir,
      uploadPath: req.file.path,
      uploadOriginalName: req.file.originalname || null,
      sampleId: null,
      status: "queued",
      stage: "upload",
      percent: 0,
      message: isScoreImage(req.file.path)
        ? "已接收谱面图片，开始识别…"
        : "已接收 MusicXML",
      title: null,
      error: null,
      match: null,
      createdAt: Date.now(),
    };
    enqueue(job);
    res.json(publicJob(job));
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    const dir = path.join(JOBS, req.params.id);
    const sol = path.join(dir, "唱音阶.mp4");
    const cel = path.join(dir, "大提琴.mp4");
    if (fs.existsSync(sol) && fs.existsSync(cel)) {
      res.json(publicJob({
        id: req.params.id,
        status: "done",
        percent: 100,
        message: "两支视频已就绪（含指法）",
        title: null,
        error: null,
        createdAt: 0,
        stage: "done",
      }));
      return;
    }
    res.status(404).json({ error: "找不到任务" });
    return;
  }
  res.json(publicJob(job));
});

app.get("/api/jobs/:id/download/:kind", (req, res) => {
  const dir = path.join(JOBS, req.params.id);
  const map = {
    solfege: ["唱音阶.mp4", "唱音阶.mp4"],
    cello: ["大提琴.mp4", "大提琴.mp4"],
    fingerings: ["fingerings.json", "指法.json"],
    musicxml: ["from-image.musicxml", "from-image.musicxml"],
  };
  const pair = map[req.params.kind];
  if (!pair) {
    res.status(400).json({ error: "未知下载类型" });
    return;
  }
  let filePath = path.join(dir, pair[0]);
  if (req.params.kind === "musicxml" && !fs.existsSync(filePath)) {
    const alt = [
      path.join(dir, "omr", "from-image.musicxml"),
      path.join(dir, "score.musicxml"),
    ].find((p) => fs.existsSync(p));
    if (alt) filePath = alt;
  }
  sendDownload(res, filePath, pair[1]);
});

async function prewarmSampleCache() {
  const samples = listSampleScores();
  if (!samples.length) return;
  console.log(`预热成片缓存：${samples.map((s) => s.id).join(", ")}…`);
  for (const sample of samples) {
    const full = getSampleById(sample.id);
    if (!full?.musicxml) continue;
    const workDir = path.join(JOBS, `_warm_${sample.id}`);
    try {
      fs.mkdirSync(workDir, { recursive: true });
      const t0 = Date.now();
      const result = await generatePair({
        musicXmlPath: full.musicxml,
        workDir,
        fast: true,
      });
      const ms = Date.now() - t0;
      console.log(
        `  ✓ ${sample.title} ${result.fromCache ? "(缓存命中)" : `(新渲 ${ms}ms)`}`
      );
    } catch (e) {
      console.warn(`  ✗ ${sample.title}: ${e?.message || e}`);
    }
  }
  console.log("预热完成：再次试听应接近秒开");
}

app.listen(PORT, () => {
  console.log(`Tang Tang 𝄢  http://127.0.0.1:${PORT}`);
  console.log(
    `出片：极速模式 FPS=${6} + 并行双轨 + OMR=${USE_OEMER ? "开" : "关"}（无模版猜曲）`
  );
  console.log(`首页成片画廊：${listGallery().length} 支`);
});
