const form = document.getElementById("form");
const fileInput = document.getElementById("file");
const fileName = document.getElementById("file-name");
const submit = document.getElementById("submit");
const progress = document.getElementById("progress");
const bar = document.getElementById("bar");
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const uploadPanel = document.getElementById("upload-panel");
const again = document.getElementById("again");
const grid = document.getElementById("video-card-grid");

function setFile(file) {
  if (!file) return;
  fileName.textContent = file.name;
  submit.disabled = false;
}

function bindDownload(el, url, opts) {
  if (!el || !url) return;
  if (window.TangDownload) {
    window.TangDownload.bindDownload(el, url, opts);
    return;
  }
  el.href = url;
  el.setAttribute("download", "");
  el.onclick = (e) => {
    const ua = navigator.userAgent || "";
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    if (isIOS) {
      e.preventDefault();
      window.location.href = url;
    }
  };
}

async function poll(id) {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) throw new Error("无法查询进度");
  return res.json();
}

function showResults(job) {
  progress.classList.add("hidden");
  results.classList.remove("hidden");
  document.getElementById("piece-title").textContent = job.title || "成片";

  const sol = job.videos.solfege;
  const cel = job.videos.cello;
  document.getElementById("v-solfege").src = sol;
  document.getElementById("v-cello").src = cel;
  const title = (job.title || "成片").replace(/[\\/:*?"<>|]+/g, "");
  bindDownload(document.getElementById("dl-solfege"), job.downloads?.solfege || sol, {
    filename: `${title}-唱音阶.mp4`,
    album: true,
  });
  bindDownload(document.getElementById("dl-cello"), job.downloads?.cello || cel, {
    filename: `${title}-大提琴.mp4`,
    album: true,
  });
  bindDownload(
    document.getElementById("dl-fingerings"),
    job.downloads?.fingerings || job.fingeringsUrl,
    { filename: `${title}-指法.json`, album: false }
  );
  results.scrollIntoView({ behavior: "smooth", block: "start" });
  loadGallery();
}

async function watchJob(job) {
  progress.classList.remove("hidden");
  results.classList.add("hidden");
  bar.style.width = `${Math.max(4, job.percent || 2)}%`;
  statusEl.textContent = job.message || "处理中…";

  let cur = job;
  while (cur.status === "queued" || cur.status === "running") {
    bar.style.width = `${Math.max(4, cur.percent || 0)}%`;
    statusEl.textContent = cur.message || "处理中…";
    await new Promise((r) => setTimeout(r, 800));
    cur = await poll(job.id);
  }
  if (cur.status === "error") throw new Error(cur.error || "生成失败");
  bar.style.width = "100%";
  statusEl.textContent = cur.message || "完成";
  showResults(cur);
}

async function startUpload(file) {
  if (!file) return;
  setFile(file);
  submit.disabled = true;
  statusEl.textContent = "上传中…";
  progress.classList.remove("hidden");
  results.classList.add("hidden");
  bar.style.width = "2%";

  const body = new FormData();
  body.append("score", file);

  try {
    const up = await fetch("/api/upload", { method: "POST", body });
    const job = await up.json();
    if (!up.ok) throw new Error(job.error || "上传失败");
    await watchJob(job);
  } catch (err) {
    statusEl.textContent = err.message || "出错了";
    submit.disabled = false;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await startUpload(fileInput.files?.[0]);
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) startUpload(f);
});

again.addEventListener("click", () => {
  results.classList.add("hidden");
  progress.classList.add("hidden");
  uploadPanel.classList.remove("hidden");
  form.reset();
  fileName.textContent = "";
  submit.disabled = true;
  bar.style.width = "0%";
  fileInput.click();
});

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function uploadCardHtml() {
  return `<button type="button" class="video-card video-card-upload" id="upload-card">
    <div class="video-card-upload-inner">
      <span class="video-card-upload-plus" aria-hidden="true">+</span>
      <strong>上传</strong>
      <span>谱面 PNG / MusicXML</span>
    </div>
  </button>`;
}

function videoCardHtml(e) {
  const poster = e.posterUrl
    ? `poster="${escapeHtml(e.posterUrl)}"`
    : "";
  const title = e.title || "成片";
  const dlCello =
    e.downloadCelloUrl ||
    e.downloadUrl ||
    `/api/gallery/${encodeURIComponent(e.id)}/download/cello`;
  const dlSolfege =
    e.downloadSolfegeUrl ||
    (e.solfegeUrl
      ? `/api/gallery/${encodeURIComponent(e.id)}/download/solfege`
      : null);
  const solfegeBtn = dlSolfege
    ? `<a class="video-card-dl btn-dl" href="${escapeHtml(dlSolfege)}" data-download-name="${escapeHtml(title + "-跟唱.mp4")}">跟唱</a>`
    : "";
  return `<article class="video-card">
    <div class="video-card-media">
      <video src="${escapeHtml(e.videoUrl)}" ${poster} controls playsinline preload="metadata"></video>
    </div>
    <div class="video-card-body">
      <h3 class="video-card-title">${escapeHtml(title)}</h3>
      <p class="video-card-artist">${escapeHtml(e.artist || "未知歌手")}</p>
      <div class="video-card-actions">
        ${solfegeBtn}
        <a class="video-card-dl btn-dl" href="${escapeHtml(dlCello)}" data-download-name="${escapeHtml(title + "-大提琴.mp4")}">大提琴</a>
      </div>
    </div>
  </article>`;
}

async function loadGallery() {
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
          videoUrl: `gallery/${e.id}/cello.mp4`,
          solfegeUrl: `gallery/${e.id}/solfege.mp4`,
          posterUrl: e.hasPoster ? `gallery/${e.id}/poster.jpg` : null,
          downloadCelloUrl: `gallery/${e.id}/cello.mp4`,
          downloadSolfegeUrl: `gallery/${e.id}/solfege.mp4`,
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
  }

  grid.querySelectorAll(".video-card-dl").forEach((el) => {
    const href = el.getAttribute("href");
    const name = el.getAttribute("data-download-name") || "cello.mp4";
    bindDownload(el, href, { filename: name, album: true });
  });
}

loadGallery();
