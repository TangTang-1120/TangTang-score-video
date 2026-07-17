/**
 * 标准示范流水线
 *
 * 1. Verovio —— 绘谱 + 跟谱高亮
 * 2. FluidR3 大提琴采样 —— 乐器示范轨
 * 3. （可选）共鳴唱名
 * 4. 节拍器预备拍
 * 5. ffmpeg 竖屏成片
 *
 * 用法：
 *   node src/standard-demo.mjs --cello scores/moon-river.musicxml
 *   node src/standard-demo.mjs scores/c-major-scale.musicxml
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
const STEMS = path.join(OUT, "stems-standard");
const FRAMES = path.join(OUT, "frames-standard");
const CELLO_DIR = path.join(ROOT, "assets/cello-mp3");
const SAMPLE_RATE = 44100;
const W = 1080;
const H = 1920;
const FPS = 24; // 标准示范用 24fps，出片更快更稳
/** 唱名比谱面高八度（女声教学音区），音高仍严格按十二平均律 */
const SING_OCTAVE_UP = 12;

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
  // FluidR3 用 Db/Eb/Gb/Ab/Bb
  return `${NOTE_NAMES[pc]}${oct}`;
}

function ensureDirs() {
  for (const d of [OUT, STEMS, FRAMES, CELLO_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of fs.readdirSync(FRAMES)) {
    fs.unlinkSync(path.join(FRAMES, f));
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout || ""}`
    );
  }
  return r;
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
  const bytes = Buffer.from(raw, "base64");
  return { midi: new Midi(bytes), bytes };
}

function buildTimeline(midi) {
  const tempo = midi.header.tempos[0]?.bpm || 72;
  const beatMs = 60000 / tempo;
  const ts = midi.header.timeSignatures?.[0];
  const beatsPerBar = ts?.timeSignature?.[0] || ts?.beats || 4;
  const notes = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        name: n.name,
        startMs: n.time * 1000,
        durationMs: Math.max(90, n.duration * 1000),
        solfege: SOLFEGE_ZH[((n.midi % 12) + 12) % 12],
        sampleName: midiToNoteName(n.midi),
      });
    }
  }
  notes.sort((a, b) => a.startMs - b.startMs);
  const scoreEndMs = Math.max(
    ...notes.map((n) => n.startMs + n.durationMs),
    1000
  );
  return { notes, tempo, beatMs, scoreEndMs, beatsPerBar };
}

/** 下载 FluidR3 大提琴采样（按需） */
function ensureCelloSamples(notes) {
  const needed = [...new Set(notes.map((n) => n.sampleName))];
  console.log(`大提琴采样 FluidR3：需 ${needed.length} 个音`);
  for (const name of needed) {
    const dest = path.join(CELLO_DIR, `${name}.mp3`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) continue;
    const url = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/cello-mp3/${name}.mp3`;
    console.log(`  ↓ ${name}`);
    const r = spawnSync("curl", ["-fsSL", "-o", dest, url], {
      encoding: "utf8",
    });
    if (r.status !== 0 || !fs.existsSync(dest)) {
      // 半音别名回退：Db→C# 等在该库用 flat 命名；再试 sharp
      const sharpMap = {
        Db: "C#",
        Eb: "D#",
        Gb: "F#",
        Ab: "G#",
        Bb: "A#",
      };
      const m = name.match(/^([A-G]b)(\d+)$/);
      if (m && sharpMap[m[1]]) {
        const alt = `${sharpMap[m[1]]}${m[2]}`;
        const url2 = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/cello-mp3/${encodeURIComponent(alt)}.mp3`;
        run("curl", ["-fsSL", "-o", dest, url2]);
      } else {
        throw new Error(`无法下载大提琴采样: ${name}`);
      }
    }
  }
}

function mp3ToFloat(mp3Path) {
  const wav = path.join(OUT, `_tmp_${path.basename(mp3Path)}.wav`);
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
  return wavToFloat(buf).samples;
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
  return { samples: out };
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
    const amp = down ? 0.22 : 0.1;
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

/** FluidR3 大提琴示范轨（一把位音区采样） */
function renderCello(notes, totalMs, countInMs) {
  const cache = new Map();
  const samples = alloc(totalMs, countInMs);
  for (const note of notes) {
    if (!cache.has(note.sampleName)) {
      cache.set(
        note.sampleName,
        mp3ToFloat(path.join(CELLO_DIR, `${note.sampleName}.mp3`))
      );
    }
    const src = cache.get(note.sampleName);
    const start = Math.floor(((note.startMs + countInMs) / 1000) * SAMPLE_RATE);
    // 略加长一点，更像连弓跟谱
    const want = Math.floor((note.durationMs / 1000) * SAMPLE_RATE * 1.05);
    const n = Math.min(src.length, want);
    const fadeIn = Math.min(Math.floor(0.018 * SAMPLE_RATE), Math.floor(n / 6));
    const fadeOut = Math.min(Math.floor(0.04 * SAMPLE_RATE), Math.floor(n / 4));
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx >= samples.length) break;
      let g = 0.95;
      if (i < fadeIn) g *= i / fadeIn;
      if (i > n - fadeOut) g *= (n - i) / fadeOut;
      samples[idx] += src[i] * g;
    }
  }
  return samples;
}

function parseCli(argv) {
  const args = { celloOnly: false, input: null };
  for (const a of argv.slice(2)) {
    if (a === "--cello" || a === "--cello-only") args.celloOnly = true;
    else if (!a.startsWith("-")) args.input = a;
  }
  return args;
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * 唱名元音共鸣（F1/F2/F3 Hz + 带宽），稳态唱、无颤音。
 * 目标：听得出 哆来咪发索拉西，且音高锁死在目标频率。
 */
const SOLFEGE_FORMANTS = {
  哆: { f: [480, 900, 2600], bw: [80, 100, 140], bright: 0.35 },
  来: { f: [720, 1300, 2500], bw: [90, 110, 150], bright: 0.45 },
  咪: { f: [310, 2200, 3000], bw: [60, 120, 160], bright: 0.55 },
  发: { f: [780, 1200, 2450], bw: [90, 110, 150], bright: 0.5 },
  索: { f: [500, 900, 2550], bw: [80, 100, 140], bright: 0.35 },
  拉: { f: [760, 1250, 2500], bw: [90, 110, 150], bright: 0.48 },
  西: { f: [300, 2150, 3100], bw: [55, 120, 160], bright: 0.55 },
};

/** 一阶谐振（共振峰） */
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

/** 带轻辅音起音的稳态元音唱名（锁死 F0，无颤音） */
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
  // 谐波振幅：基频主导，避免听成低八度/发糊
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
    env = Math.pow(Math.max(0, env), 0.9);
    out[i] = y * env * 0.95;
  }
  return out;
}

/**
 * 按谱面音高唱唱名：十二平均律精确 F0，稳态元音，无颤音。
 */
function renderSolfegeSing(notes, totalMs, countInMs) {
  const samples = alloc(totalMs, countInMs);
  console.log("共鳴唱名（精确 MIDI 音高 · 无颤音）…");

  for (const note of notes) {
    const targetMidi = note.midi + SING_OCTAVE_UP;
    const freq = midiToFreq(targetMidi);
    // 唱满时值的 90%，末尾留气口，不拖拍
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

function injectHighlight(svg, noteIds) {
  if (!noteIds?.length) return svg;
  const sel = noteIds
    .map((id) => `#${id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1")}`)
    .join(",");
  const css = `<style>${sel},${sel} *{fill:#dc2626!important;stroke:#dc2626!important}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1${css}`);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderFrames(tk, timeline, countInMs, opts = {}) {
  const celloOnly = !!opts.celloOnly;
  const title = opts.title || (celloOnly ? "Moon River" : "唱谱示范");
  const subtitle =
    opts.subtitle ||
    (celloOnly ? "大提琴一把位 · 跟谱示范" : "大提琴 + 唱名");
  const foot =
    opts.footer ||
    (celloOnly
      ? `FluidR3 Cello · 一把位 · Verovio · ♩=${Math.round(timeline.tempo)}`
      : `FluidR3 Cello · Verovio · ♩=${Math.round(timeline.tempo)}`);

  const pageCount = tk.getPageCount();
  const pageSvgs = {};
  for (let p = 1; p <= pageCount; p++) pageSvgs[p] = tk.renderToSVG(p);

  const totalMs = countInMs + timeline.scoreEndMs + 1000;
  const frameCount = Math.ceil((totalMs / 1000) * FPS);
  console.log(`渲染跟谱画面 ${frameCount} 帧 @${FPS}fps · ${pageCount} 页…`);

  for (let f = 0; f < frameCount; f++) {
    const absMs = (f / FPS) * 1000;
    const scoreMs = absMs - countInMs;
    const inCountIn = scoreMs < 0;

    let svg = pageSvgs[1];
    let noteIds = [];
    let label = "";
    if (!inCountIn) {
      const at = tk.getElementsAtTime(Math.max(0, Math.floor(scoreMs)));
      if (at?.page && pageSvgs[at.page]) svg = pageSvgs[at.page];
      noteIds = at?.notes || [];
      svg = injectHighlight(svg, noteIds);
      const cur = timeline.notes.find(
        (n) =>
          scoreMs >= n.startMs && scoreMs < n.startMs + n.durationMs
      );
      if (cur) {
        label = celloOnly
          ? `拉：${cur.name} · 一把位`
          : `唱：${cur.solfege}`;
      }
    }

    const scorePng = await sharp(Buffer.from(svg))
      .resize({ width: W - 100, fit: "inside", background: "#fff" })
      .png()
      .toBuffer();
    const meta = await sharp(scorePng).metadata();

    const bpb = timeline.beatsPerBar || 4;
    const beatIdx = inCountIn
      ? (((Math.floor(scoreMs / timeline.beatMs) % bpb) + bpb) % bpb)
      : Math.floor(scoreMs / timeline.beatMs) % bpb;
    const beatSpan = (bpb - 1) * 90 + 52;
    const beats = Array.from({ length: bpb }, (_, i) => {
      const on = i === beatIdx;
      const cx = 26 + i * 90;
      return `<circle cx="${cx}" cy="36" r="26" fill="${on ? "#2563eb" : "#e2e8f0"}"/>
        <text x="${cx}" y="44" text-anchor="middle" font-size="26" font-family="Helvetica" font-weight="700" fill="${on ? "#fff" : "#64748b"}">${i + 1}</text>`;
    }).join("");

    const hook = inCountIn
      ? `预备拍 ${beatIdx + 1}`
      : label || "跟谱示范";

    const overlay = Buffer.from(`<?xml version="1.0"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <text x="540" y="110" text-anchor="middle" font-size="40" font-family="PingFang SC,Helvetica" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>
  <text x="540" y="160" text-anchor="middle" font-size="24" font-family="PingFang SC,Helvetica" fill="#64748b">${escapeXml(subtitle)}</text>
  <g transform="translate(${(W - beatSpan) / 2}, 190)">${beats}</g>
  <rect x="80" y="280" width="${W - 160}" height="64" rx="14" fill="#dbeafe"/>
  <text x="540" y="322" text-anchor="middle" font-size="28" font-family="PingFang SC,Helvetica" fill="#1e40af">${escapeXml(hook)}</text>
  <text x="540" y="${H - 70}" text-anchor="middle" font-size="22" font-family="PingFang SC,Helvetica" fill="#94a3b8">${escapeXml(foot)}</text>
</svg>`);

    const top = 380;
    const left = Math.max(40, Math.round((W - (meta.width || W)) / 2));
    await sharp(overlay)
      .composite([{ input: scorePng, top, left }])
      .jpeg({ quality: 86 })
      .toFile(path.join(FRAMES, `frame_${String(f).padStart(5, "0")}.jpg`));

    if (f % 48 === 0) process.stdout.write(`  ${f}/${frameCount}\r`);
  }
  console.log(`\n画面完成 → ${FRAMES}`);
}

function encodeVideo(wavPath, outMp4) {
  run(ffmpegPath, [
    "-y",
    "-framerate",
    String(FPS),
    "-i",
    path.join(FRAMES, "frame_%05d.jpg"),
    "-i",
    wavPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outMp4,
  ]);
}

function writeReadme(timeline, celloOnly) {
  const lines = [
    celloOnly ? "Moon River · 大提琴一把位 · 分轨" : "标准示范 · 分轨说明",
    "================================",
    `01-click.wav     节拍器（${timeline.beatsPerBar}/4）`,
    "02-cello.wav     FluidR3 大提琴（一把位音区）",
  ];
  if (!celloOnly) {
    lines.push("03-solfege.wav   唱名轨");
  }
  lines.push(
    "04-mix.wav       成片混音",
    "",
    `速度 ♩=${timeline.tempo}`,
    `音符数 ${timeline.notes.length}`,
    ""
  );
  fs.writeFileSync(path.join(STEMS, "README.txt"), lines.join("\n"));
}

async function main() {
  const cli = parseCli(process.argv);
  const celloOnly = cli.celloOnly;
  const input = path.resolve(
    cli.input ||
      (celloOnly
        ? path.join(ROOT, "scores/moon-river.musicxml")
        : path.join(ROOT, "scores/c-major-scale.musicxml"))
  );
  if (!fs.existsSync(input)) throw new Error(`找不到谱: ${input}`);

  console.log("══════════════════════════════════════");
  console.log(
    celloOnly ? " Moon River · 大提琴一把位跟谱" : " 标准示范"
  );
  console.log("══════════════════════════════════════");
  console.log("乐谱:", input);

  ensureDirs();
  const tk = await loadToolkit(input);
  const { midi, bytes: midiBytes } = decodeMidi(tk);
  const base = path.basename(input, path.extname(input));
  const midiPath = path.join(OUT, `${base}.mid`);
  fs.writeFileSync(midiPath, midiBytes);
  console.log("MIDI →", midiPath);

  const timeline = buildTimeline(midi);
  const countInMs = timeline.beatMs * timeline.beatsPerBar;
  console.log(
    `♩=${timeline.tempo} · ${timeline.beatsPerBar}/4 · ${timeline.notes.length} 音 · ${(timeline.scoreEndMs / 1000).toFixed(1)}s`
  );

  ensureCelloSamples(timeline.notes);

  console.log("渲染分轨…");
  const click = renderClick(
    timeline.scoreEndMs,
    timeline.beatMs,
    countInMs,
    timeline.beatsPerBar
  );
  const cello = renderCello(timeline.notes, timeline.scoreEndMs, countInMs);
  let mixed;
  if (celloOnly) {
    // 大提琴主奏 + 极轻预备拍节拍
    mixed = mix([cello, click], [1.0, 0.06]);
  } else {
    const solfege = renderSolfegeSing(
      timeline.notes,
      timeline.scoreEndMs,
      countInMs
    );
    mixed = mix([solfege, cello, click], [1.05, 0.38, 0.04]);
    fs.writeFileSync(path.join(STEMS, "03-solfege.wav"), floatToWav(solfege));
  }

  fs.writeFileSync(path.join(STEMS, "01-click.wav"), floatToWav(click));
  fs.writeFileSync(path.join(STEMS, "02-cello.wav"), floatToWav(cello));
  const mixPath = path.join(STEMS, "04-mix.wav");
  fs.writeFileSync(mixPath, floatToWav(mixed));
  writeReadme(timeline, celloOnly);
  console.log("分轨 →", STEMS);

  await renderFrames(tk, timeline, countInMs, { celloOnly });
  const outMp4 = path.join(
    OUT,
    celloOnly ? `${base}-cello.mp4` : `${base}-standard-demo.mp4`
  );
  encodeVideo(mixPath, outMp4);

  console.log("\n✅ 成片:", outMp4);
  spawnSync("open", [outMp4]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
