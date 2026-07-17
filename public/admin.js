const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const adminPanel = document.getElementById("admin-panel");
const listEl = document.getElementById("library-list");
const metaEl = document.getElementById("library-meta");
const logoutBtn = document.getElementById("logout");

const SOURCE_LABEL = {
  builtin: "内建",
  demo: "试听",
  upload: "用户上传",
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

function showLoggedOut() {
  loginForm.classList.remove("hidden");
  adminPanel.classList.add("hidden");
}

function showLoggedIn() {
  loginForm.classList.add("hidden");
  adminPanel.classList.remove("hidden");
}

async function checkSession() {
  const res = await fetch("/api/admin/me", { credentials: "same-origin" });
  const data = await res.json();
  if (data.admin) {
    showLoggedIn();
    await loadLibrary();
  } else {
    showLoggedOut();
  }
}

async function loadLibrary() {
  metaEl.textContent = "加载中…";
  listEl.innerHTML = "";
  const res = await fetch("/api/admin/library", { credentials: "same-origin" });
  if (res.status === 401) {
    showLoggedOut();
    return;
  }
  if (!res.ok) {
    metaEl.textContent = "加载失败";
    return;
  }
  const data = await res.json();
  const entries = data.entries || [];
  metaEl.textContent = entries.length
    ? `共 ${entries.length} 首 · 可下载`
    : "库里还没有谱";

  for (const entry of entries) {
    const row = document.createElement("article");
    row.className = "library-row";
    const source = SOURCE_LABEL[entry.source] || entry.source || "";
    const used = formatTime(entry.lastUsedAt);
    row.innerHTML = `
      <div class="library-row-copy">
        <h2>${escapeHtml(entry.title)}</h2>
        <p>${escapeHtml(source)} · 使用 ${entry.uses || 1} 次${
          used ? ` · ${escapeHtml(used)}` : ""
        }</p>
      </div>
      <a class="btn-dl library-dl" href="${entry.downloadUrl}">下载 MusicXML</a>
    `;
    listEl.appendChild(row);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const password = document.getElementById("password").value;
  const res = await fetch("/api/admin/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    loginError.textContent = data.error || "登录失败";
    return;
  }
  document.getElementById("password").value = "";
  showLoggedIn();
  await loadLibrary();
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/admin/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  showLoggedOut();
});

checkSession();
