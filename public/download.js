/**
 * 手机端尽量把视频存进相册：优先系统分享（「存储视频」），否则回退下载。
 */
(function (global) {
  function isMobileUa() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || "")) {
      return true;
    }
    return false;
  }

  function bindClassicDownload(el, url) {
    el.href = url;
    el.setAttribute("download", "");
    el.onclick = (e) => {
      if (!isMobileUa()) return;
      const ua = navigator.userAgent || "";
      if (/iPad|iPhone|iPod/.test(ua)) {
        e.preventDefault();
        window.location.href = url;
      }
    };
  }

  async function saveMediaToAlbum(url, filename) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("文件获取失败");
    const blob = await res.blob();
    const type =
      blob.type && blob.type !== "application/octet-stream"
        ? blob.type
        : filename.endsWith(".json")
          ? "application/json"
          : "video/mp4";
    const file = new File([blob], filename, { type });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: filename.replace(/\.[^.]+$/, ""),
      });
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    }
  }

  function bindDownload(el, url, opts = {}) {
    const filename = opts.filename || "video.mp4";
    const wantAlbum =
      opts.album === true ||
      (opts.album !== false && /\.mp4($|\?)/i.test(filename));
    const mobile = isMobileUa();

    if (mobile && wantAlbum) {
      if (!el.dataset.origLabel) el.dataset.origLabel = el.textContent;
      el.textContent = "保存到相册";
      el.removeAttribute("download");
      el.href = "#";
      el.onclick = async (e) => {
        e.preventDefault();
        const prev = el.textContent;
        el.textContent = "准备中…";
        try {
          await saveMediaToAlbum(url, filename);
        } catch (err) {
          if (
            err &&
            (err.name === "AbortError" || err.name === "NotAllowedError")
          ) {
            return;
          }
          alert(
            (err && err.message) ||
              "请在弹出的菜单里选择「存储视频」；若没有，可长按上方视频保存"
          );
          window.open(url, "_blank");
        } finally {
          el.textContent = prev;
        }
      };
      return;
    }

    bindClassicDownload(el, url);
  }

  global.TangDownload = {
    isMobileUa,
    bindDownload,
    saveMediaToAlbum,
  };
})(window);
