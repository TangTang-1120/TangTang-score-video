import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePair, ROOT } from "./pair-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const input = path.resolve(
  process.argv[2] || path.join(ROOT, "scores/c-major-scale.musicxml")
);
const workDir = path.join(ROOT, "output", "pair-latest");

const result = await generatePair({
  musicXmlPath: input,
  workDir,
  onProgress: ({ percent, message }) => {
    console.log(`[${percent}%] ${message}`);
  },
});
console.log("完成:", result.files);
