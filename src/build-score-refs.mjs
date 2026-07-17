/**
 * 用 Verovio 把內建 MusicXML 渲成參考 PNG，供快速雜湊對譜
 * node src/build-score-refs.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "scores", "refs");

const SCORES = [
  ["moon-river", "scores/moon-river.musicxml"],
  ["first-love", "scores/first-love.musicxml"],
  ["c-major-scale", "scores/c-major-scale.musicxml"],
  ["demo", "scores/demo.musicxml"],
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const VerovioModule = await createVerovioModule();
  const tk = new VerovioToolkit(VerovioModule);
  tk.setOptions({
    pageWidth: 1400,
    pageHeight: 2000,
    scale: 40,
    adjustPageHeight: true,
    footer: "none",
    header: "none",
    breaks: "auto",
  });

  for (const [id, rel] of SCORES) {
    const xmlPath = path.join(ROOT, rel);
    if (!fs.existsSync(xmlPath)) {
      console.log("skip missing", rel);
      continue;
    }
    tk.loadData(fs.readFileSync(xmlPath, "utf8"));
    tk.redoLayout();
    const svg = tk.renderToSVG(1);
    const png = path.join(OUT, `${id}-verovio.png`);
    await sharp(Buffer.from(svg)).png().toFile(png);
    console.log("OK", png);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
