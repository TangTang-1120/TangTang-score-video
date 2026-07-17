/**
 * 构建 GitHub Pages 静态站（与 tangtang-daily / dehong 同方式）
 * 输出到 docs/ → https://tangtang-1120.github.io/TangTang-score-video/
 *
 * 注意：以 / 开头的绝对路径会打到 github.io 根目录，必须改成带仓库前缀。
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

function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

// 匹配掉开头 / 之后，剩余路径前缀（不含斜杠）
const BASE_NAME = BASE.replace(/^\/+|\/+$/g, "").replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&"
);

/** 把站点根绝对路径改成 GitHub Pages 项目路径（已带前缀的不重复改） */
function rewriteSitePaths(text) {
  // href="/x" src="/x" → BASE + x（跳过 //cdn 与已前缀）
  let out = text.replace(
    new RegExp(`\\b(href|src)=(["'])\\/(?!\\/|${BASE_NAME}\\/)`, "g"),
    (_, attr, q) => `${attr}=${q}${BASE}`
  );
  // url(/x) in CSS
  out = out.replace(
    new RegExp(`url\\((['"]?)\\/(?!\\/|${BASE_NAME}\\/)`, "g"),
    (_, q) => `url(${q}${BASE}`
  );
  // JS 字符串里的静态资源路径
  out = out.replace(
    new RegExp(
      `(["'\`])\\/(?!${BASE_NAME}\\/)(audio|assets|gallery|favicon[^"'\`]*|apple-touch-icon\\.png|styles\\.css|app\\.js|download\\.js|hero-cello\\.js|admin\\.js|library\\.js)`,
      "g"
    ),
    (_, q, rest) => `${q}${BASE}${rest}`
  );
  return out;
}

rmrf(DOCS);
fs.mkdirSync(DOCS, { recursive: true });
copyDir(PUBLIC, DOCS);
if (fs.existsSync(GALLERY)) {
  copyDir(GALLERY, path.join(DOCS, "gallery"));
}

fs.writeFileSync(path.join(DOCS, ".nojekyll"), "");

// Patch app.js for static gallery fallback（先改，再统一 rewrite）
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
      const res = await fetch("/gallery/manifest.json");
      if (res.ok) {
        const data = await res.json();
        entries = (Array.isArray(data.entries) ? data.entries : []).map((e) => ({
          ...e,
          videoUrl: \`/gallery/\${e.id}/cello.mp4\`,
          solfegeUrl: \`/gallery/\${e.id}/solfege.mp4\`,
          posterUrl: e.hasPoster ? \`/gallery/\${e.id}/poster.jpg\` : null,
          downloadCelloUrl: \`/gallery/\${e.id}/cello.mp4\`,
          downloadSolfegeUrl: \`/gallery/\${e.id}/solfege.mp4\`,
        }));
      }
    } catch {
      entries = [];
    }
  }

  grid.innerHTML =
    uploadCardHtml() + entries.map((e) => videoCardHtml(e)).join("");

  const uploadCard = document.getElementById("upload-card");
  if (uploadCard) {
    uploadCard.addEventListener("click", () => {
      if (staticMode) {
        window.alert(
          "公网展示站暂不支持上传识谱（需要服务器）。\\n请本机运行 npm start 后上传；这里可直接播放 / 下载成片。"
        );
        return;
      }
      fileInput.click();
    });
  }`
  );
  fs.writeFileSync(appPath, app);
}

// Rewrite absolute /paths in all text assets under docs/
for (const rel of walk(DOCS)) {
  if (!/\.(html|js|css|mjs|svg)$/i.test(rel)) continue;
  const abs = path.join(DOCS, rel);
  const before = fs.readFileSync(abs, "utf8");
  const after = rewriteSitePaths(before);
  if (after !== before) fs.writeFileSync(abs, after);
}

// 最后再插 base / static 标记（避免 rewrite 把 base 再改一次）
let html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
if (!html.includes('meta name="tang-static"')) {
  html = html.replace(
    "<head>",
    `<head>\n    <base href="${BASE}" />\n    <meta name="tang-static" content="1" />`
  );
  fs.writeFileSync(path.join(DOCS, "index.html"), html);
}

console.log("Built docs/ for GitHub Pages");
console.log("URL: https://tangtang-1120.github.io/TangTang-score-video/");
