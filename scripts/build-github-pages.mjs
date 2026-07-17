/**
 * 构建 GitHub Pages 静态站（与 tangtang-daily / dehong 同方式）
 * 输出到 docs/ → https://tangtang-1120.github.io/TangTang-score-video/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const PUBLIC = path.join(ROOT, "public");
const GALLERY = path.join(ROOT, "output", "gallery");
const BASE = "/TangTang-score-video/";

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith("_") && name !== "_score-color-previews") continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(DOCS);
fs.mkdirSync(DOCS, { recursive: true });
copyDir(PUBLIC, DOCS);
if (fs.existsSync(GALLERY)) {
  copyDir(GALLERY, path.join(DOCS, "gallery"));
}

fs.writeFileSync(path.join(DOCS, ".nojekyll"), "");

// index.html: base + static flag
let html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
if (!html.includes("<base ")) {
  html = html.replace(
    "<head>",
    `<head>\n    <base href="${BASE}" />\n    <meta name="tang-static" content="1" />`
  );
}
fs.writeFileSync(path.join(DOCS, "index.html"), html);

// Patch app.js for static gallery fallback
const appPath = path.join(DOCS, "app.js");
let app = fs.readFileSync(appPath, "utf8");
if (!app.includes("STATIC_GALLERY_FALLBACK")) {
  app = app.replace(
    `async function loadGallery() {
  if (!grid) return;
  let entries = [];
  try {
    const res = await fetch("/api/gallery");
    if (res.ok) {
      const data = await res.json();
      entries = Array.isArray(data.entries) ? data.entries : [];
    }
  } catch {
    entries = [];
  }

  grid.innerHTML =
    uploadCardHtml() + entries.map((e) => videoCardHtml(e)).join("");

  const uploadCard = document.getElementById("upload-card");
  if (uploadCard) {
    uploadCard.addEventListener("click", () => fileInput.click());
  }`,
    `async function loadGallery() {
  // STATIC_GALLERY_FALLBACK
  if (!grid) return;
  let entries = [];
  const staticMode = Boolean(document.querySelector('meta[name="tang-static"]'));
  try {
    if (!staticMode) {
      const res = await fetch("/api/gallery");
      if (res.ok) {
        const data = await res.json();
        entries = Array.isArray(data.entries) ? data.entries : [];
      }
    }
  } catch {
    entries = [];
  }
  if (!entries.length) {
    try {
      const res = await fetch("gallery/manifest.json");
      if (res.ok) {
        const data = await res.json();
        entries = (Array.isArray(data.entries) ? data.entries : []).map((e) => ({
          ...e,
          videoUrl: \`gallery/\${e.id}/cello.mp4\`,
          solfegeUrl: \`gallery/\${e.id}/solfege.mp4\`,
          posterUrl: e.hasPoster ? \`gallery/\${e.id}/poster.jpg\` : null,
          downloadCelloUrl: \`gallery/\${e.id}/cello.mp4\`,
          downloadSolfegeUrl: \`gallery/\${e.id}/solfege.mp4\`,
        }));
      }
    } catch {
      entries = [];
    }
  }

  grid.innerHTML = staticMode
    ? entries.map((e) => videoCardHtml(e)).join("")
    : uploadCardHtml() + entries.map((e) => videoCardHtml(e)).join("");

  const uploadCard = document.getElementById("upload-card");
  if (uploadCard) {
    uploadCard.addEventListener("click", () => fileInput.click());
  }`
  );
  fs.writeFileSync(appPath, app);
}

console.log("Built docs/ for GitHub Pages");
console.log("URL: https://tangtang-1120.github.io/TangTang-score-video/");
