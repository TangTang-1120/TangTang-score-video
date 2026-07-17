/**
 * 谱面匹配：只认 OMR 缓存 / 已识别入库
 * 禁止用手工模版 MusicXML 去“猜”陌生 PNG（防假对谱）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OMR_CACHE = path.join(ROOT, "scores", "omr-cache");
const EXTRA_CATALOG = path.join(ROOT, "scores", "catalog-extra.json");

const hashCache = new Map();

function loadExtraCatalog() {
  if (!fs.existsSync(EXTRA_CATALOG)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(EXTRA_CATALOG, "utf8"));
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        id: String(r.id || ""),
        title: String(r.title || "识别谱面"),
        musicxml: path.isAbsolute(r.musicxml)
          ? r.musicxml
          : path.join(ROOT, r.musicxml),
        images: (r.images || []).map((img) =>
          path.isAbsolute(img) ? img : path.join(ROOT, img)
        ),
      }))
      .filter((r) => r.id && r.musicxml && fs.existsSync(r.musicxml));
  } catch {
    return [];
  }
}

/**
 * OMR 成功后写入扩展曲目库，下次上传同图可秒级命中真谱
 */
export function registerRecognizedScore({
  id,
  title,
  musicXmlPath,
  imagePath = null,
}) {
  if (!id || !musicXmlPath || !fs.existsSync(musicXmlPath)) {
    throw new Error("registerRecognizedScore 参数无效");
  }
  const scoresDir = path.join(ROOT, "scores", "recognized");
  fs.mkdirSync(scoresDir, { recursive: true });
  const destXml = path.join(scoresDir, `${id}.musicxml`);
  fs.copyFileSync(musicXmlPath, destXml);

  let destImg = null;
  if (imagePath && fs.existsSync(imagePath)) {
    const ext = path.extname(imagePath) || ".png";
    destImg = path.join(scoresDir, `${id}${ext}`);
    fs.copyFileSync(imagePath, destImg);
  }

  const rows = loadExtraCatalog().filter((r) => r.id !== id);
  rows.push({
    id,
    title: title || "识别谱面",
    musicxml: path.relative(ROOT, destXml),
    images: destImg ? [path.relative(ROOT, destImg)] : [],
  });
  fs.writeFileSync(EXTRA_CATALOG, JSON.stringify(rows, null, 2));
  hashCache.clear();
  return { id, title, musicxml: destXml, image: destImg };
}

async function aHash(filePath) {
  if (hashCache.has(filePath)) return hashCache.get(filePath);
  const { data, info } = await sharp(filePath)
    .greyscale()
    .normalize()
    .resize(16, 16, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const avg = sum / n;
  let bits = "";
  for (let i = 0; i < n; i++) bits += data[i] >= avg ? "1" : "0";
  hashCache.set(filePath, bits);
  return bits;
}

async function dHash(filePath) {
  const key = `d:${filePath}`;
  if (hashCache.has(key)) return hashCache.get(key);
  const { data } = await sharp(filePath)
    .greyscale()
    .normalize()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x;
      bits += data[i] < data[i + 1] ? "1" : "0";
    }
  }
  hashCache.set(key, bits);
  return bits;
}

function hamming(a, b) {
  const len = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) d++;
  return d + Math.abs(a.length - b.length);
}

export async function imageFingerprint(filePath) {
  const a = await aHash(filePath);
  const d = await dHash(filePath);
  return `${a.slice(0, 32)}_${d}`;
}

/**
 * 仅命中：OMR 缓存，或识别入库的同图（严格哈希）
 * 陌生谱一律返回 null → 走真 OMR
 */
export async function matchScoreImage(imagePath) {
  const cached = await lookupOmrCache(imagePath);
  if (cached) return cached;

  const uploadA = await aHash(imagePath);
  const uploadD = await dHash(imagePath);
  let best = null;

  for (const ref of loadExtraCatalog()) {
    for (const img of ref.images) {
      if (!fs.existsSync(img)) continue;
      const da = hamming(uploadA, await aHash(img));
      const dd = hamming(uploadD, await dHash(img));
      const distance = da * 0.35 + dd * 1.2;
      if (!best || distance < best.distance) {
        best = {
          musicxml: ref.musicxml,
          title: ref.title,
          id: ref.id,
          distance,
          method: "recognized",
          da,
          dd,
        };
      }
    }
  }

  // 只接受几乎同一张图，避免误配
  if (best && best.distance <= 4) return best;
  return null;
}

async function lookupOmrCache(imagePath) {
  if (!fs.existsSync(OMR_CACHE)) return null;
  const fp = await imageFingerprint(imagePath);
  const xml = path.join(OMR_CACHE, `${fp}.musicxml`);
  const metaPath = path.join(OMR_CACHE, `${fp}.json`);
  if (!fs.existsSync(xml) || fs.statSync(xml).size < 200) return null;
  let title = "识别谱面";
  try {
    if (fs.existsSync(metaPath)) {
      title = JSON.parse(fs.readFileSync(metaPath, "utf8")).title || title;
    }
  } catch {
    /* noop */
  }
  return {
    musicxml: xml,
    title,
    id: `omr-${fp.slice(0, 8)}`,
    distance: 0,
    method: "omr-cache",
  };
}

export async function saveOmrCache(imagePath, musicXmlPath, title = "识别谱面") {
  fs.mkdirSync(OMR_CACHE, { recursive: true });
  const fp = await imageFingerprint(imagePath);
  const dest = path.join(OMR_CACHE, `${fp}.musicxml`);
  fs.copyFileSync(musicXmlPath, dest);
  const thumb = path.join(OMR_CACHE, `${fp}.png`);
  try {
    await sharp(imagePath).resize(800, 1200, { fit: "inside" }).png().toFile(thumb);
  } catch {
    /* noop */
  }
  fs.writeFileSync(
    path.join(OMR_CACHE, `${fp}.json`),
    JSON.stringify({ title, fingerprint: fp, at: Date.now() }, null, 2)
  );
  return dest;
}

export async function nearestScoreImage(imagePath) {
  return matchScoreImage(imagePath);
}

/** 不再提供手工模版「一键试听」——避免假装识谱 */
export function getSampleById(_id) {
  return null;
}

export function listSampleScores() {
  return [];
}

/** 从上传文件名推断曲名（如 好久不见.png） */
export function guessTitleFromImagePath(imagePath) {
  const base = path.basename(imagePath || "", path.extname(imagePath || ""));
  const cleaned = base
    .replace(/^upload[_-]?\d*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^[a-f0-9]{8,}$/i.test(cleaned)) return "识别谱面";
  return cleaned;
}
