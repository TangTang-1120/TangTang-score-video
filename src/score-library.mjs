/**
 * 琴谱库：仅收录真识别／真上传的谱；首页可展示已识谱下载卡
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_DIR = path.join(ROOT, "scores", "library");
const MANIFEST = path.join(LIB_DIR, "manifest.json");

/** 常见曲目歌手（识谱入库时补全） */
const KNOWN_ARTISTS = {
  好久不见: "陈奕迅",
  "First Love": "宇多田光",
  "Moon River": "Henry Mancini",
};

function extractTitle(xml) {
  const m =
    String(xml).match(/<work-title[^>]*>([^<]+)<\/work-title>/i) ||
    String(xml).match(/<movement-title[^>]*>([^<]+)<\/movement-title>/i);
  return (m?.[1] || "").trim();
}

function extractArtist(xml) {
  const m = String(xml).match(
    /<creator[^>]*type=["']composer["'][^>]*>([^<]+)<\/creator>/i
  );
  return (m?.[1] || "").trim();
}

function ensureDir() {
  fs.mkdirSync(LIB_DIR, { recursive: true });
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

function contentHash(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function safeFileStem(title, fallback = "score") {
  const raw = String(title || fallback)
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return raw || fallback;
}

function resolveArtist(title, artist, xmlText) {
  const fromArg = (artist && String(artist).trim()) || "";
  if (fromArg) return fromArg;
  const fromXml = extractArtist(xmlText);
  if (fromXml && !/oemer|Tang Tang|OMR/i.test(fromXml)) return fromXml;
  for (const [k, v] of Object.entries(KNOWN_ARTISTS)) {
    if (title.includes(k) || k.includes(title)) return v;
  }
  return "未知歌手";
}

/**
 * 写入／更新一条谱（按内容去重）
 * source=omr 的会作为首页「已识谱」下载卡
 */
export function ingestScore({
  musicXmlPath,
  title = null,
  artist = null,
  source = "upload",
  preferredId = null,
  featured = null,
}) {
  if (!musicXmlPath || !fs.existsSync(musicXmlPath)) {
    throw new Error("缺少 MusicXML 文件");
  }
  const buf = fs.readFileSync(musicXmlPath);
  const xmlText = buf.toString("utf8");
  const hash = contentHash(buf);
  const resolvedTitle =
    (title && String(title).trim()) ||
    extractTitle(xmlText) ||
    "未命名谱面";
  const resolvedArtist = resolveArtist(resolvedTitle, artist, xmlText);
  const isFeatured =
    featured === true ||
    featured === false
      ? Boolean(featured)
      : source === "omr" || source === "upload";

  const manifest = readManifest();
  const existing = manifest.entries.find((e) => e.hash === hash);
  const now = Date.now();

  if (existing) {
    existing.title = resolvedTitle;
    existing.artist = resolvedArtist;
    existing.uses = (existing.uses || 1) + 1;
    existing.lastUsedAt = now;
    if (source && source !== "builtin") {
      existing.source = existing.source || source;
    }
    if (featured !== null) existing.featured = isFeatured;
    else if (existing.featured == null) existing.featured = isFeatured;
    writeManifest(manifest);
    return { entry: existing, created: false };
  }

  const id = preferredId || `u-${hash.slice(0, 12)}`;
  const filename = `${id}.musicxml`;
  const dest = path.join(LIB_DIR, filename);
  fs.writeFileSync(dest, buf);

  const entry = {
    id,
    title: resolvedTitle,
    artist: resolvedArtist,
    filename,
    hash,
    source,
    featured: isFeatured,
    uses: 1,
    addedAt: now,
    lastUsedAt: now,
  };
  manifest.entries.push(entry);
  writeManifest(manifest);
  return { entry, created: true };
}

/** 已取消内建模版灌库 */
export function seedBuiltinScores() {
  return;
}

function mapEntry(e, includeDownload) {
  const row = {
    id: e.id,
    title: e.title,
    artist: e.artist || "未知歌手",
    source: e.source,
    featured: Boolean(e.featured),
    uses: e.uses || 1,
    addedAt: e.addedAt,
    lastUsedAt: e.lastUsedAt,
    canDemo: false,
  };
  if (includeDownload) {
    row.downloadName = `${safeFileStem(e.title, e.id)}.musicxml`;
    row.downloadUrl = `/api/library/${encodeURIComponent(e.id)}/download`;
  }
  return row;
}

export function listLibrary(opts = {}) {
  const includeDownload = Boolean(opts.includeDownload);
  const { entries } = readManifest();
  return entries
    .filter((e) => fs.existsSync(path.join(LIB_DIR, e.filename)))
    .sort(
      (a, b) =>
        (b.lastUsedAt || b.addedAt || 0) - (a.lastUsedAt || a.addedAt || 0)
    )
    .map((e) => mapEntry(e, includeDownload));
}

/** 首页：真识谱成功、可公开下载的小卡 */
export function listFeaturedScores() {
  const { entries } = readManifest();
  return entries
    .filter(
      (e) =>
        e.featured !== false &&
        (e.source === "omr" || e.source === "upload" || e.featured === true) &&
        fs.existsSync(path.join(LIB_DIR, e.filename))
    )
    .sort(
      (a, b) =>
        (b.lastUsedAt || b.addedAt || 0) - (a.lastUsedAt || a.addedAt || 0)
    )
    .map((e) => mapEntry(e, true));
}

export function getLibraryFile(id) {
  const { entries } = readManifest();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  const filePath = path.join(LIB_DIR, entry.filename);
  if (!fs.existsSync(filePath)) return null;
  return {
    entry,
    filePath,
    downloadName: `${safeFileStem(entry.title, entry.id)}.musicxml`,
  };
}
