/**
 * 上傳電子譜 → 產出兩支跟譜影片
 * 1) 唱音階  2) 大提琴（自動指法／把位）
 * 固定 ♩=72，畫面音符跟隨 + 指法識別；文案不含 AI / demo
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import toneMidi from "@tonejs/midi";
import ffmpegPath from "ffmpeg-static";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import {
  assignCelloFingerings,
  fingeringLabel,
  positionTier,
} from "./cello-fingering.mjs";

const { Midi } = toneMidi;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const CELLO_DIR = path.join(ROOT, "assets/cello-mp3");
const SAMPLE_RATE = 44100;
const W = 720;
const H = 1280;
const FPS_NORMAL = 10;
/** Web / 试听默认：更低帧率，优先速度 */
const FPS_FAST = 6;
const FRAME_CONCURRENCY = Math.max(2, Math.min(8, os.cpus().length || 4));
const FORCE_BPM = 72;
const SING_OCTAVE_UP = 12;
const VIDEO_CACHE = path.join(ROOT, "output", "video-cache");
const STYLE_TAG = "style12-mid-rust";

const SOLFEGE_ZH = {
  0: "哆",
  1: "哆",
  2: "来",
  3: "来",
  4: "咪",
  5: "发",
  6: "发",
  7: "索",
  8: "索",
  9: "拉",
  10: "拉",
  11: "西",
};

const NOTE_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];

function midiToNoteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${oct}`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} failed:\n${(r.stderr || r.stdout || "").slice(0, 2000)}`
    );
  }
  return r;
}

/** 強制樂譜速度為 72，讓繪譜時間軸與音訊一致 */
export function forceTempoInMusicXml(xml, bpm = FORCE_BPM) {
  let s = String(xml);
  if (/<per-minute>/i.test(s)) {
    s = s.replace(
      /<per-minute>\s*[^<]+\s*<\/per-minute>/gi,
      `<per-minute>${bpm}</per-minute>`
    );
  }
  s = s.replace(/\btempo="[\d.]+"/g, `tempo="${bpm}"`);
  if (!/<per-minute>/i.test(s)) {
    const block = `
      <direction placement="above">
        <direction-type>
          <metronome>
            <beat-unit>quarter</beat-unit>
            <per-minute>${bpm}</per-minute>
          </metronome>
        </direction-type>
        <sound tempo="${bpm}"/>
      </direction>`;
    if (/<measure[^>]*number="1"[^>]*>[\s\S]*?<\/attributes>/i.test(s)) {
      s = s.replace(
        /(<measure[^>]*number="1"[^>]*>[\s\S]*?<\/attributes>)/i,
        `$1${block}`
      );
    } else {
      s = s.replace(
        /(<measure[^>]*number="1"[^>]*>)/i,
        `$1${block}`
      );
    }
  }
  return s;
}

export function extractPieceTitle(xml) {
  const m =
    String(xml).match(/<work-title[^>]*>([^<]+)<\/work-title>/i) ||
    String(xml).match(/<movement-title[^>]*>([^<]+)<\/movement-title>/i);
  return (m?.[1] || "跟谱").trim();
}

async function loadToolkit(musicxmlPath) {
  const VerovioModule = await createVerovioModule();
  const tk = new VerovioToolkit(VerovioModule);
  tk.setOptions({
    pageWidth: 1350,
    pageHeight: 2200,
    scale: 48,
    adjustPageHeight: true,
    footer: "none",
    header: "none",
    breaks: "auto",
    svgBoundingBoxes: true,
  });
  if (!tk.loadData(fs.readFileSync(musicxmlPath, "utf8"))) {
    throw new Error("MusicXML 加载失败");
  }
  tk.redoLayout();
  return tk;
}

function decodeMidi(tk) {
  const b64 = tk.renderToMIDI();
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return new Midi(Buffer.from(raw, "base64"));
}

function buildTimeline(midi, forceBpm = FORCE_BPM, fingeringMode = "natural") {
  const srcTempo = midi.header.tempos[0]?.bpm || forceBpm;
  const scale = srcTempo / forceBpm;
  const tempo = forceBpm;
  const beatMs = 60000 / tempo;
  const ts = midi.header.timeSignatures?.[0];
  const beatsPerBar = ts?.timeSignature?.[0] || ts?.beats || 4;
  const notes = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        name: n.name,
        startMs: n.time * 1000 * scale,
        durationMs: Math.max(90, n.duration * 1000 * scale),
        solfege: SOLFEGE_ZH[((n.midi % 12) + 12) % 12],
        sampleName: midiToNoteName(n.midi),
      });
    }
  }
  notes.sort((a, b) => a.startMs - b.startMs);
  const withFingering = assignCelloFingerings(notes, fingeringMode);
  const scoreEndMs = Math.max(
    ...withFingering.map((n) => n.startMs + n.durationMs),
    1000
  );
  return { notes: withFingering, tempo, beatMs, scoreEndMs, beatsPerBar };
}

function ensureCelloSamples(notes) {
  fs.mkdirSync(CELLO_DIR, { recursive: true });
  const needed = [...new Set(notes.map((n) => n.sampleName))];
  const base =
    "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/cello-mp3";
  // FluidR3 只用降号文件名（Db/Eb…），升号需映射
  const toFlat = {
    "C#": "Db",
    "D#": "Eb",
    "F#": "Gb",
    "G#": "Ab",
    "A#": "Bb",
  };
  for (const name of needed) {
    const dest = path.join(CELLO_DIR, `${name}.mp3`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) continue;
    const candidates = [name];
    const sharp = name.match(/^([A-G]#)(\d+)$/);
    if (sharp && toFlat[sharp[1]]) {
      candidates.push(`${toFlat[sharp[1]]}${sharp[2]}`);
    }
    const flat = name.match(/^([A-G]b)(\d+)$/);
    if (flat) {
      const rev = Object.entries(toFlat).find(([, v]) => v === flat[1]);
      if (rev) candidates.push(`${rev[0]}${flat[2]}`);
    }
    let ok = false;
    for (const cand of candidates) {
      const url = `${base}/${encodeURIComponent(cand)}.mp3`;
      const r = spawnSync("curl", ["-fsSL", "-o", dest, url], {
        encoding: "utf8",
      });
      if (
        r.status === 0 &&
        fs.existsSync(dest) &&
        fs.statSync(dest).size > 500
      ) {
        ok = true;
        break;
      }
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        /* noop */
      }
    }
    if (!ok) throw new Error(`无法下载大提琴采样: ${name}`);
  }
}

function wavToFloat(buf) {
  let offset = 12;
  let dataOffset = 44;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      break;
    }
    offset += 8 + size;
  }
  const n = Math.floor((buf.length - dataOffset) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return out;
}

function mp3ToFloat(mp3Path, tmpDir) {
  const wav = path.join(tmpDir, `_tmp_${path.basename(mp3Path)}.wav`);
  run(ffmpegPath, [
    "-y",
    "-i",
    mp3Path,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    wav,
  ]);
  const buf = fs.readFileSync(wav);
  fs.unlinkSync(wav);
  return wavToFloat(buf);
}

function floatToWav(samples) {
  let peak = 1e-6;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const norm = Math.min(1, 0.92 / peak);
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * norm));
    buffer.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  return buffer;
}

function alloc(totalMs, countInMs) {
  return new Float32Array(
    Math.ceil(((totalMs + countInMs + 1000) / 1000) * SAMPLE_RATE)
  );
}

function renderClick(totalMs, beatMs, countInMs, beatsPerBar = 4) {
  const samples = alloc(totalMs, countInMs);
  const beats = Math.ceil((countInMs + totalMs) / beatMs);
  for (let b = 0; b < beats; b++) {
    const t0 = (b * beatMs) / 1000;
    const down = b % beatsPerBar === 0;
    const freq = down ? 1100 : 880;
    const amp = down ? 0.18 : 0.08;
    const len = Math.floor(0.025 * SAMPLE_RATE);
    for (let i = 0; i < len; i++) {
      const idx = Math.floor(t0 * SAMPLE_RATE) + i;
      if (idx >= samples.length) break;
      const t = i / SAMPLE_RATE;
      samples[idx] += Math.sin(2 * Math.PI * freq * t) * (1 - t / 0.025) * amp;
    }
  }
  return samples;
}

/**
 * 依把位調整音色：一把位偏厚、中把位偏亮、高把／拇指更亮更靠前
 * （用採樣染色區分不同把位，不是同一套「一把位」音色）
 */
function colorSampleForTier(src, tier) {
  if (tier <= 1) return src;
  const out = new Float32Array(src.length);
  let prev = 0;
  const hp = tier >= 3 ? 0.88 : 0.82;
  const bright = tier >= 3 ? 0.42 : 0.22;
  const body = tier >= 3 ? 0.82 : 0.92;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    const high = x - prev * hp;
    prev = x * 0.6 + prev * 0.4;
    out[i] = x * body + high * bright;
  }
  return out;
}

function renderCello(notes, totalMs, countInMs, tmpDir) {
  const cache = new Map();
  const samples = alloc(totalMs, countInMs);
  for (const note of notes) {
    const tier = positionTier(note.fingering?.position);
    const cacheKey = `${note.sampleName}|t${tier}`;
    if (!cache.has(cacheKey)) {
      const raw = mp3ToFloat(
        path.join(CELLO_DIR, `${note.sampleName}.mp3`),
        tmpDir
      );
      cache.set(cacheKey, colorSampleForTier(raw, tier));
    }
    const src = cache.get(cacheKey);
    const start = Math.floor(((note.startMs + countInMs) / 1000) * SAMPLE_RATE);
    const want = Math.floor((note.durationMs / 1000) * SAMPLE_RATE * 1.05);
    const n = Math.min(src.length, want);
    const fadeIn = Math.min(Math.floor(0.018 * SAMPLE_RATE), Math.floor(n / 6));
    const fadeOut = Math.min(Math.floor(0.04 * SAMPLE_RATE), Math.floor(n / 4));
    // 高把位略強一點，聽感上與低把位分開
    const baseG = tier >= 3 ? 1.02 : tier === 2 ? 0.98 : 0.95;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx >= samples.length) break;
      let g = baseG;
      if (i < fadeIn) g *= i / fadeIn;
      if (i > n - fadeOut) g *= (n - i) / fadeOut;
      samples[idx] += src[i] * g;
    }
  }
  return samples;
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const SOLFEGE_FORMANTS = {
  哆: { f: [480, 900, 2600], bw: [80, 100, 140], bright: 0.35 },
  来: { f: [720, 1300, 2500], bw: [90, 110, 150], bright: 0.45 },
  来: { f: [720, 1300, 2500], bw: [90, 110, 150], bright: 0.45 },
  咪: { f: [310, 2200, 3000], bw: [60, 120, 160], bright: 0.55 },
  发: { f: [780, 1200, 2450], bw: [90, 110, 150], bright: 0.5 },
  发: { f: [780, 1200, 2450], bw: [90, 110, 150], bright: 0.5 },
  索: { f: [500, 900, 2550], bw: [80, 100, 140], bright: 0.35 },
  拉: { f: [760, 1250, 2500], bw: [90, 110, 150], bright: 0.48 },
  西: { f: [300, 2150, 3100], bw: [55, 120, 160], bright: 0.55 },
};

function makeResonator(freq, bw) {
  const r = Math.exp((-Math.PI * bw) / SAMPLE_RATE);
  const cosT = 2 * r * Math.cos((2 * Math.PI * freq) / SAMPLE_RATE);
  const gain = 1 - r;
  let x1 = 0;
  let x2 = 0;
  return (x) => {
    const y = gain * x + cosT * x1 - r * r * x2;
    x2 = x1;
    x1 = y;
    return y;
  };
}

function synthSungSyllable(solfege, freqHz, durationMs) {
  const cfg = SOLFEGE_FORMANTS[solfege] || SOLFEGE_FORMANTS["哆"];
  const n = Math.max(1, Math.floor((durationMs / 1000) * SAMPLE_RATE));
  const out = new Float32Array(n);
  const res = cfg.f.map((f, i) => makeResonator(f, cfg.bw[i]));
  const attack = Math.floor(0.035 * SAMPLE_RATE);
  const release = Math.min(Math.floor(0.07 * SAMPLE_RATE), Math.floor(n * 0.28));
  const cons = Math.floor(0.016 * SAMPLE_RATE);
  let phase = 0;
  const twoPi = 2 * Math.PI;
  const harms = [1.0, 0.45, 0.22, 0.1, 0.05];

  for (let i = 0; i < n; i++) {
    phase += (twoPi * freqHz) / SAMPLE_RATE;
    if (phase > twoPi) phase -= twoPi * Math.floor(phase / twoPi);
    let src = 0;
    for (let h = 0; h < harms.length; h++) {
      src += Math.sin(phase * (h + 1)) * harms[h];
    }
    src /= 1.8;
    if (i < cons) {
      const noise = (Math.random() * 2 - 1) * (1 - i / cons) * 0.35;
      src = src * (0.35 + 0.65 * (i / cons)) + noise;
    }
    let y = 0;
    for (const r of res) y += r(src);
    y *= 0.28 + cfg.bright * 0.18;
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i > n - release) env = (n - i) / release;
    out[i] = y * Math.pow(Math.max(0, env), 0.9) * 0.95;
  }
  return out;
}

function renderSolfegeSing(notes, totalMs, countInMs) {
  const samples = alloc(totalMs, countInMs);
  for (const note of notes) {
    const freq = midiToFreq(note.midi + SING_OCTAVE_UP);
    const dur = Math.max(120, note.durationMs * 0.9);
    const pitched = synthSungSyllable(note.solfege, freq, dur);
    const start = Math.floor(((note.startMs + countInMs) / 1000) * SAMPLE_RATE);
    for (let i = 0; i < pitched.length; i++) {
      const idx = start + i;
      if (idx >= samples.length) break;
      samples[idx] += pitched[i];
    }
  }
  return samples;
}

function mix(tracks, gains) {
  const len = Math.max(...tracks.map((t) => t.length));
  const out = new Float32Array(len);
  for (let t = 0; t < tracks.length; t++) {
    const g = gains[t] ?? 1;
    const src = tracks[t];
    for (let i = 0; i < src.length; i++) out[i] += src[i] * g;
  }
  return out;
}

/** 复古红：跟谱高亮 + 当前小节底色 */
const HIGHLIGHT_RED = "#c23d6e"; // 跟谱 · 复古洋红
const MEASURE_TINT = "rgba(194, 61, 110, 0.10)";

function escapeCssId(id) {
  return String(id).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

/**
 * 跟谱样式：当前音符复古红；红底只铺在「当前这一小节」格子里
 */
function injectScoreStyles(svg, noteIds, measureId) {
  const parts = [];
  if (measureId) {
    const mid = escapeCssId(measureId);
    parts.push(
      `#${mid} g.staff.bounding-box>rect{fill:${MEASURE_TINT}!important;stroke:none!important}`
    );
  }
  if (noteIds?.length) {
    const sel = noteIds.map((id) => `#${escapeCssId(id)}`).join(",");
    parts.push(
      `${sel},${sel} *{fill:${HIGHLIGHT_RED}!important;stroke:${HIGHLIGHT_RED}!important}`
    );
  }
  if (!parts.length) return svg;
  const css = `<style>${parts.join("")}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1${css}`);
}

function injectHighlight(svg, noteIds) {
  return injectScoreStyles(svg, noteIds, null);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tierColor(tier) {
  // 三色拉開：一眼能分把位
  if (tier >= 3) return { bg: "#e11d6a", fg: "#ffffff" }; // 高把／拇指 · 亮洋红
  if (tier === 2) return { bg: "#c45a2e", fg: "#fff8f2" }; // 中把 · 复古橘红
  return { bg: "#0ea59a", fg: "#04221f" }; // 一把位 · 鲜明青绿
}

async function renderFrames(tk, timeline, countInMs, framesDir, opts) {
  const { title, subtitle, mode, fps = FPS_NORMAL, jpegQuality = 72 } = opts;
  const foot =
    mode === "cello"
      ? `♩=${Math.round(timeline.tempo)} · 音符跟随 · 指法识别`
      : `♩=${Math.round(timeline.tempo)} · 音符跟随`;

  for (const f of fs.readdirSync(framesDir)) {
    fs.unlinkSync(path.join(framesDir, f));
  }

  const pageCount = tk.getPageCount();
  const pageSvgs = {};
  for (let p = 1; p <= pageCount; p++) pageSvgs[p] = tk.renderToSVG(p);

  const totalMs = countInMs + timeline.scoreEndMs + 1000;
  const frameCount = Math.ceil((totalMs / 1000) * fps);
  const bpb = timeline.beatsPerBar || 4;
  const beatSpan = (bpb - 1) * 90 + 52;

  const jobs = [];
  for (let f = 0; f < frameCount; f++) {
    const absMs = (f / fps) * 1000;
    const scoreMs = absMs - countInMs;
    const inCountIn = scoreMs < 0;

    let svg = pageSvgs[1];
    let label = "";
    let subLabel = "";
    let tier = 1;
    if (!inCountIn) {
      const at = tk.getElementsAtTime(Math.max(0, Math.floor(scoreMs)));
      if (at?.page && pageSvgs[at.page]) svg = pageSvgs[at.page];
      svg = injectScoreStyles(svg, at?.notes || [], at?.measure || null);
      const cur = timeline.notes.find(
        (n) => scoreMs >= n.startMs && scoreMs < n.startMs + n.durationMs
      );
      if (cur) {
        if (mode === "cello") {
          const fl = fingeringLabel(cur.fingering);
          label = `拉：${cur.name}`;
          subLabel = fl;
          tier = positionTier(cur.fingering?.position);
        } else {
          label = `唱：${cur.solfege}`;
          if (cur.fingering) {
            subLabel = `对照指法 ${fingeringLabel(cur.fingering)}`;
            tier = positionTier(cur.fingering?.position);
          }
        }
      }
    }

    const beatIdx = inCountIn
      ? (((Math.floor(scoreMs / timeline.beatMs) % bpb) + bpb) % bpb)
      : Math.floor(scoreMs / timeline.beatMs) % bpb;
    const colors = tierColor(tier);
    const beats = Array.from({ length: bpb }, (_, i) => {
      const on = i === beatIdx;
      const cx = 26 + i * 90;
      const fill = on ? colors.bg : "#ececec";
      const ink = on ? colors.fg : "#6b7280";
      return (
        `<circle cx="${cx}" cy="36" r="26" fill="${fill}"/>` +
        `<text x="${cx}" y="44" text-anchor="middle" font-size="26" font-family="Georgia,serif" font-weight="700" fill="${ink}">${i + 1}</text>`
      );
    }).join("");

    const hook = inCountIn
      ? `预备拍 ${beatIdx + 1}`
      : label || "音符跟随";
    const bannerH = subLabel ? 96 : 64;

    const overlay = Buffer.from(`<?xml version="1.0"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${W / 2}" y="88" text-anchor="middle" font-size="32" font-family="Georgia,'Songti SC',serif" font-weight="700" fill="#1a2e24">${escapeXml(title)}</text>
  <text x="${W / 2}" y="128" text-anchor="middle" font-size="18" font-family="'PingFang SC','Songti SC',serif" fill="#5c6670">${escapeXml(subtitle)}</text>
  <g transform="translate(${(W - beatSpan) / 2}, 150)">${beats}</g>
  <rect x="48" y="230" width="${W - 96}" height="${bannerH}" rx="8" fill="${colors.bg}"/>
  <text x="${W / 2}" y="${subLabel ? 268 : 272}" text-anchor="middle" font-size="22" font-family="'PingFang SC','Songti SC',serif" fill="${colors.fg}">${escapeXml(hook)}</text>
  ${
    subLabel
      ? `<text x="${W / 2}" y="302" text-anchor="middle" font-size="17" font-family="'PingFang SC','Songti SC',serif" fill="${colors.fg}">${escapeXml(subLabel)}</text>`
      : ""
  }
  <text x="${W / 2}" y="${H - 48}" text-anchor="middle" font-size="16" font-family="Georgia,serif" fill="#8a9199">${escapeXml(foot)}</text>
</svg>`);

    jobs.push({
      f,
      svg,
      overlay,
      out: path.join(framesDir, `frame_${String(f).padStart(5, "0")}.jpg`),
    });
  }

  let cursor = 0;
  const workers = Array.from({ length: FRAME_CONCURRENCY }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const scorePng = await sharp(Buffer.from(job.svg))
        .resize({ width: W - 100, fit: "inside", background: "#ffffff" })
        .png()
        .toBuffer();
      const meta = await sharp(scorePng).metadata();
      const top = 330;
      const left = Math.max(24, Math.round((W - (meta.width || W)) / 2));
      await sharp(job.overlay)
        .composite([{ input: scorePng, top, left }])
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toFile(job.out);
    }
  });
  await Promise.all(workers);
  return frameCount;
}

function encodeVideo(framesDir, wavPath, outMp4, fps = FPS_NORMAL, fast = false) {
  const args = [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, "frame_%05d.jpg"),
    "-i",
    wavPath,
    "-c:v",
    "libx264",
    "-preset",
    fast ? "ultrafast" : "veryfast",
    "-crf",
    fast ? "28" : "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    fast ? "128k" : "160k",
    "-threads",
    "0",
    "-shortest",
    "-movflags",
    "+faststart",
    outMp4,
  ];
  run(ffmpegPath, args);
}

function scoreCacheKey(musicXmlPath, fast, fingeringMode = "natural") {
  const raw = fs.readFileSync(musicXmlPath);
  return crypto
    .createHash("sha1")
    .update(raw)
    .update(
      fast
        ? `|fast${FPS_FAST}|${STYLE_TAG}|${fingeringMode}`
        : `|norm${FPS_NORMAL}|${STYLE_TAG}|${fingeringMode}`
    )
    .digest("hex")
    .slice(0, 16);
}

function tryLoadVideoCache(cacheKey, workDir) {
  const dir = path.join(VIDEO_CACHE, cacheKey);
  const sol = path.join(dir, "唱音阶.mp4");
  const cel = path.join(dir, "大提琴.mp4");
  const fin = path.join(dir, "fingerings.json");
  const meta = path.join(dir, "meta.json");
  if (![sol, cel, fin, meta].every((p) => fs.existsSync(p))) return null;
  fs.copyFileSync(sol, path.join(workDir, "唱音阶.mp4"));
  fs.copyFileSync(cel, path.join(workDir, "大提琴.mp4"));
  fs.copyFileSync(fin, path.join(workDir, "fingerings.json"));
  const info = JSON.parse(fs.readFileSync(meta, "utf8"));
  return {
    title: info.title,
    tempo: FORCE_BPM,
    noteCount: info.noteCount,
    durationSec: info.durationSec,
    fingerings: JSON.parse(fs.readFileSync(fin, "utf8")).notes || [],
    files: {
      solfege: path.join(workDir, "唱音阶.mp4"),
      cello: path.join(workDir, "大提琴.mp4"),
      score: path.join(workDir, "score.musicxml"),
      fingerings: path.join(workDir, "fingerings.json"),
    },
    fromCache: true,
  };
}

function saveVideoCache(cacheKey, result) {
  const dir = path.join(VIDEO_CACHE, cacheKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(result.files.solfege, path.join(dir, "唱音阶.mp4"));
  fs.copyFileSync(result.files.cello, path.join(dir, "大提琴.mp4"));
  fs.copyFileSync(result.files.fingerings, path.join(dir, "fingerings.json"));
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        title: result.title,
        noteCount: result.noteCount,
        durationSec: result.durationSec,
        savedAt: Date.now(),
      },
      null,
      2
    ),
    "utf8"
  );
}

/**
 * @param {object} opts
 * @param {string} opts.musicXmlPath
 * @param {string} opts.workDir
 * @param {boolean} [opts.fast] - 手机传图：更低帧率更快出片
 * @param {(p:{stage:string,percent:number,message:string})=>void} [opts.onProgress]
 */
export async function generatePair({
  musicXmlPath,
  workDir,
  onProgress,
  fast = false,
  fingeringMode = "natural",
}) {
  const report = (stage, percent, message) => {
    onProgress?.({ stage, percent, message });
  };
  const fps = fast ? FPS_FAST : FPS_NORMAL;
  const jpegQuality = fast ? 50 : 68;

  fs.mkdirSync(workDir, { recursive: true });
  const framesSol = path.join(workDir, "frames-sol");
  const framesCel = path.join(workDir, "frames-cel");
  const stemsDir = path.join(workDir, "stems");
  fs.mkdirSync(framesSol, { recursive: true });
  fs.mkdirSync(framesCel, { recursive: true });
  fs.mkdirSync(stemsDir, { recursive: true });

  report("prepare", 5, "读取乐谱并固定速度 ♩=72");
  const raw = fs.readFileSync(musicXmlPath, "utf8");
  const title = extractPieceTitle(raw);
  const forced = forceTempoInMusicXml(raw, FORCE_BPM);
  const scorePath = path.join(workDir, "score.musicxml");
  fs.writeFileSync(scorePath, forced, "utf8");

  const cacheKey = scoreCacheKey(scorePath, fast, fingeringMode);
  const cached = tryLoadVideoCache(cacheKey, workDir);
  if (cached) {
    report("cache", 100, "命中成片缓存，秒级完成");
    return cached;
  }

  report("score", 12, fast ? "绘谱（极速出片）" : "绘谱");
  const [tkSol, tkCel] = await Promise.all([
    loadToolkit(scorePath),
    loadToolkit(scorePath),
  ]);
  const midi = decodeMidi(tkSol);
  const timeline = buildTimeline(midi, FORCE_BPM, fingeringMode);
  const countInMs = timeline.beatMs * timeline.beatsPerBar;

  report("fingering", 18, "识别大提琴指法／把位");
  const fingeringPath = path.join(workDir, "fingerings.json");
  const fingeringTable = timeline.notes.map((n, i) => ({
    index: i,
    name: n.name,
    midi: n.midi,
    solfege: n.solfege,
    startMs: Math.round(n.startMs),
    ...n.fingering,
    label: fingeringLabel(n.fingering),
  }));
  fs.writeFileSync(
    fingeringPath,
    JSON.stringify({ title, tempo: FORCE_BPM, notes: fingeringTable }, null, 2),
    "utf8"
  );

  report("samples", 22, "准备大提琴采样（依把位染色）");
  ensureCelloSamples(timeline.notes);

  report("audio", 30, "渲染音轨");
  const click = renderClick(
    timeline.scoreEndMs,
    timeline.beatMs,
    countInMs,
    timeline.beatsPerBar
  );
  const cello = renderCello(
    timeline.notes,
    timeline.scoreEndMs,
    countInMs,
    workDir
  );
  const solfege = renderSolfegeSing(
    timeline.notes,
    timeline.scoreEndMs,
    countInMs
  );

  const solMix = mix([solfege, cello, click], [1.05, 0.32, 0.05]);
  const celloMix = mix([cello, click], [1.0, 0.06]);
  const solWav = path.join(stemsDir, "唱音阶.wav");
  const celloWav = path.join(stemsDir, "大提琴.wav");
  fs.writeFileSync(solWav, floatToWav(solMix));
  fs.writeFileSync(celloWav, floatToWav(celloMix));

  const solMp4 = path.join(workDir, "唱音阶.mp4");
  const celloMp4 = path.join(workDir, "大提琴.mp4");

  report("video", 42, fast ? "并行合成两支视频（极速）" : "并行合成两支视频");
  await Promise.all([
    (async () => {
      await renderFrames(tkSol, timeline, countInMs, framesSol, {
        title,
        subtitle: "唱音阶 · 音符跟随",
        mode: "solfege",
        fps,
        jpegQuality,
      });
      encodeVideo(framesSol, solWav, solMp4, fps, fast);
    })(),
    (async () => {
      await renderFrames(tkCel, timeline, countInMs, framesCel, {
        title,
        subtitle: "大提琴 · 自动指法 · 音符跟随",
        mode: "cello",
        fps,
        jpegQuality,
      });
      encodeVideo(framesCel, celloWav, celloMp4, fps, fast);
    })(),
  ]);

  report("done", 100, "完成");
  const result = {
    title,
    tempo: FORCE_BPM,
    noteCount: timeline.notes.length,
    durationSec: (countInMs + timeline.scoreEndMs) / 1000,
    fingerings: fingeringTable,
    files: {
      solfege: solMp4,
      cello: celloMp4,
      score: scorePath,
      fingerings: fingeringPath,
    },
    fromCache: false,
  };
  try {
    saveVideoCache(cacheKey, result);
  } catch {
    /* 缓存失败不影响出片 */
  }
  return result;
}
