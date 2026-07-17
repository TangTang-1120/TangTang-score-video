const listEl = document.getElementById("library-list");
const metaEl = document.getElementById("library-meta");
const progress = document.getElementById("progress");
const bar = document.getElementById("bar");
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const again = document.getElementById("again");

const SOURCE_LABEL = {
  builtin: "精选",
  demo: "试听",
  upload: "用户贡献",
};

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bindDownload(el, url, opts) {
  if (window.TangDownload) {
    window.TangDownload.bindDownload(el, url, opts);
    return;
  }
  el.href = url;
  el.setAttribute("download", "");
}

function showResults(job) {
  progress.classList.add("hidden");
  listEl.classList.add("hidden");
  metaEl.classList.add("hidden");
  results.classList.remove("hidden");
  document.getElementById("piece-title").textContent = job.title || "成片";
  document.getElementById("v-solfege").src = job.videos.solfege;
  document.getElementById("v-cello").src = job.videos.cello;
  const title = (job.title || "成片").replace(/[\\/:*?"<>|]+/g, "");
  bindDownload(
    document.getElementById("dl-solfege"),
    job.downloads?.solfege || job.videos.solfege,
    { filename: `${title}-唱音阶.mp4`, album: true }
  );
  bindDownload(
    document.getElementById("dl-cello"),
    job.downloads?.cello || job.videos.cello,
    { filename: `${title}-大提琴.mp4`, album: true }
  );
  bindDownload(
    document.getElementById("dl-fingerings"),
    job.downloads?.fingerings || job.fingeringsUrl,
    { filename: `${title}-指法.json`, album: false }
  );
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function poll(id) {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) throw new Error("无法查询进度");
  return res.json();
}

async function watchJob(job) {
  progress.classList.remove("hidden");
  results.classList.add("hidden");
  progress.scrollIntoView({ behavior: "smooth", block: "center" });
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

async function startDemo(id, btn) {
  if (!id) return;
  if (btn) btn.disabled = true;
  statusEl.textContent = "开始试听出片…";
  progress.classList.remove("hidden");
  results.classList.add("hidden");
  bar.style.width = "2%";
  try {
    const res = await fetch(`/api/demo/${encodeURIComponent(id)}`, {
      method: "POST",
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "试听失败");
    await watchJob(job);
  } catch (err) {
    progress.classList.remove("hidden");
    statusEl.textContent = err.message || "出错了";
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadLibrary() {
  try {
    const res = await fetch("/api/library");
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    const entries = data.entries || [];
    metaEl.textContent = entries.length
      ? `共 ${entries.length} 首`
      : "曲目会随使用逐渐丰富";
    listEl.innerHTML = "";

    if (!entries.length) {
      const empty = document.createElement("article");
      empty.className = "library-row";
      empty.innerHTML = `
        <div class="library-row-copy">
          <h2>还没有曲目</h2>
          <p>回首页一键试听或上传谱面，成片后会自动出现在这里</p>
        </div>
        <a class="btn-dl library-dl" href="/">回首页</a>
      `;
      listEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("article");
      row.className = "library-row";
      const source = SOURCE_LABEL[entry.source] || entry.source || "";
      const used = formatTime(entry.lastUsedAt);
      const action = entry.canDemo
        ? `<button type="button" class="btn-dl library-dl" data-demo="${escapeHtml(entry.id)}">试听出片</button>`
        : `<a class="ghost library-dl" href="/">去上传</a>`;
      row.innerHTML = `
        <div class="library-row-copy">
          <h2>${escapeHtml(entry.title)}</h2>
          <p>${escapeHtml(source)} · 使用 ${entry.uses || 1} 次${
            used ? ` · ${escapeHtml(used)}` : ""
          }</p>
        </div>
        ${action}
      `;
      listEl.appendChild(row);
    }

    listEl.querySelectorAll("[data-demo]").forEach((btn) => {
      btn.addEventListener("click", () =>
        startDemo(btn.getAttribute("data-demo"), btn)
      );
    });
  } catch (e) {
    metaEl.textContent = e.message || "加载失败";
  }
}

again.addEventListener("click", () => {
  results.classList.add("hidden");
  progress.classList.add("hidden");
  listEl.classList.remove("hidden");
  metaEl.classList.remove("hidden");
  bar.style.width = "0%";
  window.scrollTo({ top: 0, behavior: "smooth" });
});

loadLibrary();
