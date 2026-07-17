/**
 * 用 demo 的 FluidR3 大提琴管線，只拉音訊給首頁 banner
 * 用法：node src/render-banner-audio.mjs [scores/first-love.musicxml]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import toneMidi from "@tonejs/midi";
import ffmpegPath from "ffmpeg-static";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

const { Midi } = toneMidi;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CELLO_DIR = path.join(ROOT, "assets/cello-mp3");
const OUT_DIR = path.join(ROOT, "public/audio");
const TMP = path.join(ROOT, "output", "banner-audio-tmp");
const SAMPLE_RATE = 44100;

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

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed:\n${r.stderr || r.stdout || ""}`);
  }
  return r;
}

async function loadMidiFromXml(musicxmlPath) {
  const VerovioModule = await createVerovioModule();
  const tk = new VerovioToolkit(VerovioModule);
  tk.setOptions({
    pageWidth: 1200,
    pageHeight: 1800,
    scale: 40,
    adjustPageHeight: true,
    footer: "none",
    header: "none",
  });
  if (!tk.loadData(fs.readFileSync(musicxmlPath, "utf8"))) {
    throw new Error("MusicXML 載入失敗");
  }
  const b64 = tk.renderToMIDI();
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return new Midi(Buffer.from(raw, "base64"));
}

function buildNotes(midi) {
  const notes = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        startMs: n.time * 1000,
        durationMs: Math.max(120, n.duration * 1000),
        sampleName: midiToNoteName(n.midi),
      });
    }
  }
  notes.sort((a, b) => a.startMs - b.startMs);
  const scoreEndMs = Math.max(
    ...notes.map((n) => n.startMs + n.durationMs),
    1000
  );
  return { notes, scoreEndMs };
}

function ensureSamples(notes) {
  fs.mkdirSync(CELLO_DIR, { recursive: true });
  const needed = [...new Set(notes.map((n) => n.sampleName))];
  for (const name of needed) {
    const dest = path.join(CELLO_DIR, `${name}.mp3`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) continue;
    console.log(`↓ FluidR3 cello ${name}`);
    const url = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/cello-mp3/${name}.mp3`;
    let r = spawnSync("curl", ["-fsSL", "-o", dest, url], { encoding: "utf8" });
    if (r.status !== 0 || !fs.existsSync(dest)) {
      const sharpMap = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };
      const m = name.match(/^([A-G]b)(\d+)$/);
      if (m && sharpMap[m[1]]) {
        const alt = `${sharpMap[m[1]]}${m[2]}`;
        run("curl", [
          "-fsSL",
          "-o",
          dest,
          `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/cello-mp3/${encodeURIComponent(alt)}.mp3`,
        ]);
      } else {
        throw new Error(`無法下載採樣: ${name}`);
      }
    }
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

function mp3ToFloat(mp3Path) {
  const wav = path.join(TMP, `_tmp_${path.basename(mp3Path)}.wav`);
  run(ffmpegPath, ["-y", "-i", mp3Path, "-ac", "1", "-ar", String(SAMPLE_RATE), wav]);
  const buf = fs.readFileSync(wav);
  fs.unlinkSync(wav);
  return wavToFloat(buf);
}

function floatToWav(samples) {
  let peak = 1e-6;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const norm = Math.min(1, 0.9 / peak);
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

function renderCello(notes, totalMs) {
  const cache = new Map();
  const samples = new Float32Array(
    Math.ceil(((totalMs + 1200) / 1000) * SAMPLE_RATE)
  );
  for (const note of notes) {
    if (!cache.has(note.sampleName)) {
      cache.set(note.sampleName, mp3ToFloat(path.join(CELLO_DIR, `${note.sampleName}.mp3`)));
    }
    const src = cache.get(note.sampleName);
    const start = Math.floor((note.startMs / 1000) * SAMPLE_RATE);
    const want = Math.floor((note.durationMs / 1000) * SAMPLE_RATE * 1.08);
    const n = Math.min(src.length, want);
    const fadeIn = Math.min(Math.floor(0.02 * SAMPLE_RATE), Math.floor(n / 6));
    const fadeOut = Math.min(Math.floor(0.05 * SAMPLE_RATE), Math.floor(n / 4));
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx >= samples.length) break;
      let g = 0.96;
      if (i < fadeIn) g *= i / fadeIn;
      if (i > n - fadeOut) g *= (n - i) / fadeOut;
      samples[idx] += src[i] * g;
    }
  }
  return samples;
}

async function main() {
  const input =
    process.argv[2] || path.join(ROOT, "scores", "first-love.musicxml");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  console.log("譜面:", input);
  const midi = await loadMidiFromXml(input);
  const { notes, scoreEndMs } = buildNotes(midi);
  if (!notes.length) throw new Error("沒有音符");
  console.log(`音符 ${notes.length} · 時長約 ${(scoreEndMs / 1000).toFixed(1)}s`);

  ensureSamples(notes);
  const cello = renderCello(notes, scoreEndMs);
  const wavPath = path.join(OUT_DIR, "first-love-cello.wav");
  const mp3Path = path.join(OUT_DIR, "first-love-cello.mp3");
  fs.writeFileSync(wavPath, floatToWav(cello));

  run(ffmpegPath, [
    "-y",
    "-i",
    wavPath,
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    mp3Path,
  ]);

  console.log("OK", mp3Path);
  console.log("OK", wavPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
