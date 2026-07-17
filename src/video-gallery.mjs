/**
 * 首页成片画廊：成功出片后挂成视频小卡
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GALLERY_DIR = path.join(ROOT, "output", "gallery");
const MANIFEST = path.join(GALLERY_DIR, "manifest.json");

const KNOWN_ARTISTS = {
  好久不见: "陈奕迅",
  "First Love": "宇多田光",
  "Moon River": "Henry Mancini",
};

function ensureDir() {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
}

function readManifest() {
  ensureDir();
  if (!fs.existsSync(MANIFEST)) return { entries: [] };
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeManifest(manifest) {
  ensureDir();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}

function resolveArtist(title, artist) {
  const a = (artist && String(artist).trim()) || "";
  if (a) return a;
  const t = String(title || "");
  for (const [k, v] of Object.entries(KNOWN_ARTISTS)) {
    if (t.includes(k) || k.includes(t)) return v;
  }
  return "未知歌手";
}

function makePoster(videoPath, posterPath) {
  try {
    const ffmpeg =
      process.env.FFMPEG ||
      path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg");
    if (!fs.existsSync(ffmpeg) && !process.env.FFMPEG) return false;
    const r = spawnSync(
      ffmpeg,
      [
        "-y",
        "-ss",
        "0.4",
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        posterPath,
      ],
      { encoding: "utf8", timeout: 30000 }
    );
    return r.status === 0 && fs.existsSync(posterPath);
  } catch {
    return false;
  }
}

/**
 * 出片成功后写入画廊
 */
export function publishGalleryVideo({
  id,
  title,
  artist = null,
  celloPath,
  solfegePath = null,
}) {
  if (!id || !celloPath || !fs.existsSync(celloPath)) {
    throw new Error("publishGalleryVideo 缺少成片");
  }
  ensureDir();
  const itemDir = path.join(GALLERY_DIR, id);
  fs.mkdirSync(itemDir, { recursive: true });
  const celloDest = path.join(itemDir, "cello.mp4");
  fs.copyFileSync(celloPath, celloDest);
  if (solfegePath && fs.existsSync(solfegePath)) {
    fs.copyFileSync(solfegePath, path.join(itemDir, "solfege.mp4"));
  }
  const posterDest = path.join(itemDir, "poster.jpg");
  const hasPoster = makePoster(celloDest, posterDest);

  const resolvedTitle = (title && String(title).trim()) || "未命名";
  const resolvedArtist = resolveArtist(resolvedTitle, artist);
  const now = Date.now();

  const manifest = readManifest();
  const existing = manifest.entries.find((e) => e.id === id);
  if (existing) {
    existing.title = resolvedTitle;
    existing.artist = resolvedArtist;
    existing.hasPoster = hasPoster;
    existing.updatedAt = now;
  } else {
    manifest.entries.unshift({
      id,
      title: resolvedTitle,
      artist: resolvedArtist,
      hasPoster,
      addedAt: now,
      updatedAt: now,
    });
  }
  writeManifest(manifest);
  return manifest.entries.find((e) => e.id === id);
}

export function listGallery() {
  const { entries } = readManifest();
  return entries
    .filter((e) => fs.existsSync(path.join(GALLERY_DIR, e.id, "cello.mp4")))
    .sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0))
    .map((e) => {
      const hasSolfege = fs.existsSync(
        path.join(GALLERY_DIR, e.id, "solfege.mp4")
      );
      return {
        id: e.id,
        title: e.title,
        artist: e.artist || "未知歌手",
        videoUrl: `/gallery/${encodeURIComponent(e.id)}/cello.mp4`,
        solfegeUrl: hasSolfege
          ? `/gallery/${encodeURIComponent(e.id)}/solfege.mp4`
          : null,
        posterUrl: e.hasPoster
          ? `/gallery/${encodeURIComponent(e.id)}/poster.jpg`
          : null,
        downloadCelloUrl: `/api/gallery/${encodeURIComponent(e.id)}/download/cello`,
        downloadSolfegeUrl: hasSolfege
          ? `/api/gallery/${encodeURIComponent(e.id)}/download/solfege`
          : null,
        // 兼容旧字段
        downloadUrl: `/api/gallery/${encodeURIComponent(e.id)}/download/cello`,
      };
    });
}

export function getGalleryFile(id, kind = "cello") {
  const name = kind === "solfege" ? "solfege.mp4" : "cello.mp4";
  const suffix = kind === "solfege" ? "跟唱" : "大提琴";
  const filePath = path.join(GALLERY_DIR, id, name);
  if (!fs.existsSync(filePath)) return null;
  const { entries } = readManifest();
  const entry = entries.find((e) => e.id === id);
  const stem = String(entry?.title || id)
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim()
    .slice(0, 48);
  return {
    filePath,
    downloadName: `${stem || id}-${suffix}.mp4`,
    entry,
  };
}

/** @deprecated 用 getGalleryFile */
export function getGalleryCello(id) {
  return getGalleryFile(id, "cello");
}

export function galleryRoot() {
  ensureDir();
  return GALLERY_DIR;
}
