/**
 * 电子唱谱短视频 Demo
 * 输入 MusicXML → 竖屏 MP4 + 分轨音频
 *
 * 用法：
 *   npm run demo
 *   node src/generate.mjs path/to/score.musicxml
 *   node src/generate.mjs --sing path/to/score.musicxml
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import toneMidi from "@tonejs/midi";
import ffmpegPath from "ffmpeg-static";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

const { Midi } = toneMidi;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "output");
const FRAMES = path.join(OUT, "frames");
const STEMS = path.join(OUT, "stems");
const SAMPLE_RATE = 44100;

// 竖屏短视频
const W = 1080;
const H = 1920;
const FPS = 30;
const COUNT_IN_BEATS = 4; // 预备拍

const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function parseArgs(argv) {
  const args = {
    aiSing: false,
    audioOnly: false,
    input: path.join(ROOT, "scores/demo.musicxml"),
  };
  for (const a of argv.slice(2)) {
    if (a === "--ai-sing" || a === "--sing") args.aiSing = true;
    else if (a === "--audio-only") args.audioOnly = true;
    else if (!a.startsWith("-")) args.input = path.resolve(a);
  }
  return args;
}

function ensureDirs(audioOnly = false) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(STEMS, { recursive: true });
  if (!audioOnly) {
    fs.rmSync(FRAMES, { recursive: true, force: true });
    fs.mkdirSync(FRAMES, { recursive: true });
  }
}

async function loadToolkit(musicxmlPath) {
  const VerovioModule = await createVerovioModule();
  const tk = new VerovioToolkit(VerovioModule);
  tk.setOptions({
    pageWidth: 1400,
    pageHeight: 2000,
    scale: 50,
    adjustPageHeight: true,
    footer: "none",
    header: "none",
    breaks: "auto",
    svgBoundingBoxes: true,
  });
  const xml = fs.readFileSync(musicxmlPath, "utf8");
  const ok = tk.loadData(xml);
  if (!ok) throw new Error(`无法加载乐谱: ${musicxmlPath}`);
  tk.redoLayout();
  return tk;
}

function decodeMidi(tk) {
  const b64 = tk.renderToMIDI();
  // verovio returns base64 MIDI string (sometimes with data URI prefix)
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  const buf = Buffer.from(raw, "base64");
  return new Midi(buf);
}

function buildTimeline(tk, midi) {
  const timemap = tk.renderToTimemap({ includeMeasures: true, includeRests: true });
  const tempo = midi.header.tempos[0]?.bpm || 80;
  const beatMs = 60000 / tempo;

  // note events from MIDI (reliable pitch + duration)
  const notes = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        name: n.name,
        pitch: PITCH_NAMES[((n.midi % 12) + 12) % 12],
        startMs: n.time * 1000,
        durationMs: Math.max(80, n.duration * 1000),
      });
    }
  }
  notes.sort((a, b) => a.startMs - b.startMs);

  const scoreEndMs = Math.max(
    ...timemap.map((t) => t.tstamp || 0),
    ...notes.map((n) => n.startMs + n.durationMs),
    1000
  );

  return { timemap, notes, tempo, beatMs, scoreEndMs };
}

/** 根据时间找出正在发声的 note xml:id */
function activeNoteIds(timemap, timeMs) {
  let current = null;
  for (const entry of timemap) {
    if (entry.tstamp <= timeMs) current = entry;
    else break;
  }
  return current?.on || [];
}

function injectHighlight(svg, noteIds) {
  if (!noteIds.length) return svg;
  const css = `
    <style type="text/css">
      ${noteIds.map((id) => `#${cssEscape(id)}`).join(",")} {
        fill: #e11d48 !important;
        stroke: #e11d48 !important;
      }
      ${noteIds.map((id) => `#${cssEscape(id)} *`).join(",")} {
        fill: #e11d48 !important;
        stroke: #e11d48 !important;
      }
    </style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1${css}`);
}

function cssEscape(id) {
  // XML ids may contain characters that need escaping in CSS
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function allocSamples(totalMs, countInMs, sampleRate = SAMPLE_RATE) {
  return new Float32Array(Math.ceil(((totalMs + countInMs + 800) / 1000) * sampleRate));
}

/** 节拍器轨 */
function renderClickTrack(totalMs, beatMs, countInMs, beatsPerBar = 3, sampleRate = SAMPLE_RATE) {
  const samples = allocSamples(totalMs, countInMs, sampleRate);
  const totalBeats = Math.ceil((countInMs + totalMs) / beatMs);
  for (let b = 0; b < totalBeats; b++) {
    const t0 = (b * beatMs) / 1000;
    const isDownbeat = b % beatsPerBar === 0;
    const freq = isDownbeat ? 1200 : 900;
    const amp = isDownbeat ? 0.28 : 0.12;
    const clickLen = Math.floor(0.03 * sampleRate);
    for (let i = 0; i < clickLen; i++) {
      const t = i / sampleRate;
      const idx = Math.floor(t0 * sampleRate) + i;
      if (idx >= samples.length) break;
      samples[idx] += Math.sin(2 * Math.PI * freq * t) * (1 - t / 0.03) * amp;
    }
  }
  return samples;
}

/** 节奏换音轨（无人声） */
function renderPitchTrack(notes, totalMs, countInMs, sampleRate = SAMPLE_RATE) {
  const samples = allocSamples(totalMs, countInMs, sampleRate);
  for (const note of notes) {
    const start = Math.floor(((note.startMs + countInMs) / 1000) * sampleRate);
    const dur = Math.floor((note.durationMs / 1000) * sampleRate);
    const freq = midiToFreq(note.midi);
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= samples.length) break;
      const attack = Math.min(1, i / (0.008 * sampleRate));
      const release = Math.min(1, (dur - i) / (0.04 * sampleRate));
      const env = attack * release;
      const voice =
        0.62 * Math.sin(2 * Math.PI * freq * (i / sampleRate)) +
        0.2 * Math.sin(2 * Math.PI * freq * 2 * (i / sampleRate)) +
        0.08 * Math.sin(2 * Math.PI * freq * 3 * (i / sampleRate));
      samples[idx] += voice * env * 0.45;
    }
  }
  return samples;
}

/** 固定唱名（C 大调固定 Do） */
const SOLFEGE = {
  0: "do",
  1: "do",
  2: "re",
  3: "re",
  4: "mi",
  5: "fa",
  6: "fa",
  7: "sol",
  8: "sol",
  9: "la",
  10: "la",
  11: "si",
};

function wavToFloat(buf) {
  // 跳过可能存在的额外 chunk，找 data
  let offset = 12;
  let dataOffset = 44;
  let sampleRate = 44100;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      sampleRate = buf.readUInt32LE(offset + 12);
    } else if (id === "data") {
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
  return { samples: out, sampleRate };
}

function estimateF0(samples, sampleRate) {
  // 简易自相关估基频（男声/女声 TTS 大约 120–250Hz）
  const minF = 120;
  const maxF = 320;
  const minLag = Math.floor(sampleRate / maxF);
  const maxLag = Math.floor(sampleRate / minF);
  const start = Math.floor(samples.length * 0.15);
  const end = Math.min(samples.length, start + sampleRate);
  let bestLag = minLag;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let norm = 0;
    for (let i = start; i + lag < end; i++) {
      corr += samples[i] * samples[i + lag];
      norm += samples[i] * samples[i];
    }
    const c = norm > 0 ? corr / norm : 0;
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }
  return sampleRate / bestLag;
}

/** 用 macOS say 生成唱名素材，再变调到谱面音高（唱音节，不哼 aa） */
function buildSolfegeBank() {
  const dir = path.join(OUT, "syllables");
  fs.mkdirSync(dir, { recursive: true });
  const bank = {};
  const words = {
    do: "哆",
    re: "来",
    mi: "咪",
    fa: "发",
    sol: "索",
    la: "拉",
    si: "西",
  };

  for (const [key, zh] of Object.entries(words)) {
    const aiff = path.join(dir, `${key}.aiff`);
    const wav = path.join(dir, `${key}.wav`);
    let r = spawnSync("say", ["-v", "Tingting", "-r", "240", "-o", aiff, zh], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      spawnSync("say", ["-v", "Samantha", "-r", "240", "-o", aiff, key], {
        encoding: "utf8",
      });
    }
    const fr = spawnSync(
      ffmpegPath,
      ["-y", "-i", aiff, "-ac", "1", "-ar", String(SAMPLE_RATE), wav],
      { encoding: "utf8" }
    );
    if (fr.status !== 0 || !fs.existsSync(wav)) {
      throw new Error(`唱名素材生成失败: ${key}`);
    }
    const { samples, sampleRate } = wavToFloat(fs.readFileSync(wav));
    const f0 = estimateF0(samples, sampleRate);
    bank[key] = { samples, sampleRate, f0 };
    console.log(`  唱名 ${key}(${zh}): f0≈${f0.toFixed(1)}Hz`);
  }
  return bank;
}

function pitchShiftSamples(samples, ratio) {
  // 线性重采样变调（时长会变）；足够做唱名演示
  if (Math.abs(ratio - 1) < 0.01) return samples;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function fitDuration(samples, targetLen) {
  if (samples.length === targetLen) return samples;
  if (samples.length > targetLen) {
    // 截取中间偏前（保留字头）
    return samples.subarray(0, targetLen);
  }
  const out = new Float32Array(targetLen);
  out.set(samples);
  return out;
}

/** 念唱名：按节奏念 哆/来/咪…（平读） */
function renderAiVocalTrack(notes, totalMs, countInMs, sampleRate = SAMPLE_RATE) {
  console.log("生成唱名念白素材…");
  const bank = buildSolfegeBank();
  const samples = allocSamples(totalMs, countInMs, sampleRate);

  for (const note of notes) {
    const name = SOLFEGE[((note.midi % 12) + 12) % 12];
    const clip = bank[name];
    if (!clip) continue;

    // 平读：不重采样、不变调，超长就直接截断
    const gap = Math.min(0.02, note.durationMs / 1000 / 16);
    const targetLen = Math.floor(
      Math.max(0.07, note.durationMs / 1000 - gap) * sampleRate
    );
    let spoken = fitDuration(clip.samples, Math.min(clip.samples.length, targetLen));

    const fade = Math.min(Math.floor(0.008 * sampleRate), Math.floor(spoken.length / 6));
    for (let i = 0; i < fade; i++) {
      spoken[i] *= i / fade;
      spoken[spoken.length - 1 - i] *= i / fade;
    }

    const start = Math.floor(((note.startMs + countInMs) / 1000) * sampleRate);
    for (let i = 0; i < spoken.length; i++) {
      const idx = start + i;
      if (idx >= samples.length) break;
      samples[idx] += spoken[i] * 1.05;
    }
  }
  return samples;
}

function mixTracks(tracks, gains) {
  const len = Math.max(...tracks.map((t) => t.length));
  const out = new Float32Array(len);
  for (let t = 0; t < tracks.length; t++) {
    const g = gains[t] ?? 1;
    const src = tracks[t];
    for (let i = 0; i < src.length; i++) out[i] += src[i] * g;
  }
  return out;
}

function floatToWavBuffer(samples, sampleRate = SAMPLE_RATE) {
  let peak = 1e-6;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const norm = Math.min(1, 0.95 / peak);

  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
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

function writeSilentVocalPlaceholder(numSamples, sampleRate = SAMPLE_RATE) {
  // 静音轨：同长度，留给你替换成真人唱谱
  return floatToWavBuffer(new Float32Array(numSamples), sampleRate);
}

function writeCues(timeline, countInMs) {
  const cues = {
    tempo: timeline.tempo,
    countInBeats: COUNT_IN_BEATS,
    countInMs,
    sampleRate: SAMPLE_RATE,
    note: "录音请从文件开头对齐；前 countInBeats 拍是预备拍，之后才是第一音。",
    notes: timeline.notes.map((n, i) => ({
      i,
      absStartMs: Math.round(n.startMs + countInMs),
      scoreStartMs: Math.round(n.startMs),
      durationMs: Math.round(n.durationMs),
      midi: n.midi,
      pitch: n.name,
    })),
  };
  const p = path.join(OUT, "cues.json");
  fs.writeFileSync(p, JSON.stringify(cues, null, 2));
  return p;
}

function exportStems(timeline, countInMs, { aiSing = false, beatsPerBar = 3 } = {}) {
  const click = renderClickTrack(
    timeline.scoreEndMs,
    timeline.beatMs,
    countInMs,
    beatsPerBar
  );
  const pitch = renderPitchTrack(timeline.notes, timeline.scoreEndMs, countInMs);
  const vocal = aiSing
    ? renderAiVocalTrack(timeline.notes, timeline.scoreEndMs, countInMs)
    : new Float32Array(pitch.length);

  // 念唱名：只要人声 + 极轻节拍；不要换音垫底（避免听感发颤）
  const mix = aiSing
    ? mixTracks([vocal, click], [1.0, 0.04])
    : mixTracks([click, pitch], [0.2, 1.0]);

  const clickPath = path.join(STEMS, "01-click.wav");
  const pitchPath = path.join(STEMS, "02-pitch.wav");
  const vocalPath = path.join(STEMS, "03-vocal.wav");
  const mixPath = path.join(OUT, "audio-mix.wav");

  fs.writeFileSync(clickPath, floatToWavBuffer(click));
  fs.writeFileSync(pitchPath, floatToWavBuffer(pitch));
  fs.writeFileSync(vocalPath, floatToWavBuffer(vocal));
  fs.writeFileSync(mixPath, floatToWavBuffer(mix));

  fs.writeFileSync(
    path.join(STEMS, "README.txt"),
    [
      "分轨说明",
      "--------",
      "01-click.wav   节拍器",
      "02-pitch.wav   节奏换音（无人声）",
      aiSing
        ? "03-vocal.wav   唱名念白（可被你的录音覆盖）"
        : "03-vocal.wav   静音占位 ← 用你的录音覆盖",
      "",
      "对齐：从 0 秒开始；前几拍是预备拍。",
      "叠真人声：npm run mix",
      "",
    ].join("\n")
  );

  return { clickPath, pitchPath, vocalPath, mixPath };
}

function beatAt(timeMs, beatMs, beatsPerBar = 3) {
  if (timeMs < 0) {
    const into = COUNT_IN_BEATS + timeMs / beatMs;
    return ((Math.floor(into) % beatsPerBar) + beatsPerBar) % beatsPerBar;
  }
  return Math.floor(timeMs / beatMs) % beatsPerBar;
}

async function renderFrames(tk, timeline, countInMs, { aiSing = false, beatsPerBar = 3, title, subtitle } = {}) {
  const pageCount = tk.getPageCount();
  const pageSvgs = [];
  for (let p = 1; p <= pageCount; p++) {
    pageSvgs[p] = tk.renderToSVG(p);
  }

  const totalMs = countInMs + timeline.scoreEndMs + 800;
  const frameCount = Math.ceil((totalMs / 1000) * FPS);
  const tTitle = title || (aiSing ? "Moon River · 唱名" : "节奏换音 Demo");
  const tSub = subtitle || (aiSing ? "跟谱高亮 · 唱名念白" : "无人声");

  console.log(`渲染 ${frameCount} 帧 @ ${FPS}fps · ${pageCount} 页 …`);

  for (let f = 0; f < frameCount; f++) {
    const absMs = (f / FPS) * 1000;
    const scoreMs = absMs - countInMs;
    const inCountIn = scoreMs < 0;

    let svg = pageSvgs[1];
    let noteIds = [];
    if (!inCountIn) {
      const at = tk.getElementsAtTime(Math.max(0, Math.floor(scoreMs)));
      if (at?.page && pageSvgs[at.page]) {
        svg = pageSvgs[at.page];
      }
      noteIds = at?.notes || activeNoteIds(timeline.timemap, scoreMs);
      svg = injectHighlight(svg, noteIds);
    }

    const scorePng = await sharp(Buffer.from(svg))
      .resize({ width: W - 80, fit: "inside", background: "#ffffff" })
      .png()
      .toBuffer();
    const meta = await sharp(scorePng).metadata();

    const beatIdx = beatAt(scoreMs, timeline.beatMs, beatsPerBar);
    const beats = Array.from({ length: beatsPerBar }, (_, i) => {
      const on = i === beatIdx;
      const cx = 80 + i * 90;
      return `<circle cx="${cx}" cy="40" r="28" fill="${on ? "#2563eb" : "#e5e7eb"}"/>
        <text x="${cx}" y="48" text-anchor="middle" font-size="28" font-family="Helvetica,Arial,sans-serif" fill="${on ? "#fff" : "#64748b"}" font-weight="700">${i + 1}</text>`;
    });
    const beatGroupX = Math.round((W - beatsPerBar * 90) / 2);

    const hook = inCountIn
      ? `预备拍 ${beatIdx + 1}`
      : noteIds.length
        ? aiSing
          ? "正在唱名"
          : "跟着光标听换音"
        : "延长 / 换气";

    const overlay = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <text x="540" y="120" text-anchor="middle" font-size="42" font-family="PingFang SC,Helvetica,Arial,sans-serif" font-weight="700" fill="#0f172a">${escapeXml(tTitle)}</text>
  <text x="540" y="175" text-anchor="middle" font-size="26" font-family="PingFang SC,Helvetica,Arial,sans-serif" fill="#64748b">${escapeXml(tSub)}</text>
  <g transform="translate(${beatGroupX}, 210)">${beats.join("")}</g>
  <rect x="60" y="300" width="${W - 120}" height="72" rx="16" fill="#dbeafe"/>
  <text x="540" y="348" text-anchor="middle" font-size="30" font-family="PingFang SC,Helvetica,Arial,sans-serif" fill="#1e40af">${escapeXml(hook)}</text>
  <text x="540" y="${H - 80}" text-anchor="middle" font-size="24" font-family="PingFang SC,Helvetica,Arial,sans-serif" fill="#94a3b8">♩ = ${Math.round(timeline.tempo)} · 电子唱谱自制Demo</text>
</svg>`);

    const scoreTop = 420;
    const scoreLeft = Math.round((W - (meta.width || W)) / 2);

    await sharp(overlay)
      .composite([{ input: scorePng, top: scoreTop, left: Math.max(40, scoreLeft) }])
      .jpeg({ quality: 88 })
      .toFile(path.join(FRAMES, `frame_${String(f).padStart(5, "0")}.jpg`));

    if (f % 30 === 0) process.stdout.write(`  ${f}/${frameCount}\r`);
  }
  console.log(`\n帧序列完成 → ${FRAMES}`);
  return totalMs;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function encodeVideo(wavPath, outMp4) {
  const pattern = path.join(FRAMES, "frame_%05d.jpg");
  const r = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      pattern,
      "-i",
      wavPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      outMp4,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error("ffmpeg 合成失败");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.input)) {
    throw new Error(`找不到乐谱文件: ${args.input}`);
  }

  console.log("乐谱:", args.input);
  console.log(
    "模式:",
    args.aiSing ? "唱名念白（哆来咪…）" : "节奏换音（无人声）"
  );

  ensureDirs(args.audioOnly);
  const tk = await loadToolkit(args.input);
  const midi = decodeMidi(tk);
  const timeline = buildTimeline(tk, midi);
  const beatsPerBar = 3;
  const countInMs = timeline.beatMs * COUNT_IN_BEATS;

  console.log(
    `速度 ♩=${timeline.tempo} · 音符 ${timeline.notes.length} · 谱长 ${(timeline.scoreEndMs / 1000).toFixed(1)}s`
  );

  const stems = exportStems(timeline, countInMs, {
    aiSing: args.aiSing,
    beatsPerBar,
  });
  const cuesPath = writeCues(timeline, countInMs);
  console.log("分轨 →", STEMS);
  console.log("  01-click.wav   节拍器");
  console.log("  02-pitch.wav   节奏换音");
  console.log(
    args.aiSing
      ? "  03-vocal.wav   唱名念白"
      : "  03-vocal.wav   静音占位"
  );
  console.log("混音 →", stems.mixPath);
  console.log("时间轴 →", cuesPath);

  if (args.aiSing) {
    spawnSync("open", [stems.vocalPath], { encoding: "utf8" });
  }

  const outMp4 = path.join(
    OUT,
    args.aiSing ? "moon-river-solfege.mp4" : "demo.mp4"
  );

  if (args.audioOnly && fs.existsSync(outMp4)) {
    const tmp = path.join(OUT, "_tmp_mux.mp4");
    const r = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-i",
        outMp4,
        "-i",
        stems.mixPath,
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
        tmp,
      ],
      { encoding: "utf8" }
    );
    if (r.status !== 0) {
      console.error(r.stderr);
      throw new Error("音频替换失败");
    }
    fs.renameSync(tmp, outMp4);
  } else {
    await renderFrames(tk, timeline, countInMs, {
      aiSing: args.aiSing,
      beatsPerBar,
      title: args.aiSing ? "Moon River · 唱名" : undefined,
      subtitle: args.aiSing ? "哆来咪发索拉西" : undefined,
    });
    encodeVideo(stems.mixPath, outMp4);
  }

  console.log("\n✅ 完成:", outMp4);
  spawnSync("open", [outMp4], { encoding: "utf8" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
