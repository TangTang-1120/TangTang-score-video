/**
 * 手机端尽量把视频存进相册：
 * iOS Safari 只能靠 Web Share（「存储视频」），download 属性无效。
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

  function isIos() {
    const ua = navigator.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 桌面 UA
    if (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || "")) {
      return true;
    }
    return false;
  }

  function absoluteUrl(url) {
    try {
      return new URL(url, document.baseURI || location.href).href;
    } catch {
      return url;
    }
  }

  /** WebKit 对中文文件名 canShare 常失败，分享时用 ASCII 名 */
  function asciiShareName(filename) {
    const ext = (filename.match(/\.[^.]+$/) || [".mp4"])[0];
    const base = filename.replace(/\.[^.]+$/, "") || "tangtang";
    const safe = base
      .replace(/[^\w\-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return `${safe || "tangtang-video"}${ext}`;
  }

  function bindClassicDownload(el, url) {
    const abs = absoluteUrl(url);
    el.href = abs;
    el.setAttribute("download", "");
    el.onclick = (e) => {
      if (!isMobileUa()) return;
      if (isIos()) {
        e.preventDefault();
        window.open(abs, "_blank", "noopener");
      }
    };
  }

  async function fetchVideoFile(url, filename) {
    const abs = absoluteUrl(url);
    const res = await fetch(abs, { credentials: "same-origin", cache: "no-cache" });
    if (!res.ok) throw new Error("视频获取失败，请检查网络后重试");
    const buf = await res.arrayBuffer();
    const type = "video/mp4";
    const shareName = asciiShareName(filename.endsWith(".mp4") ? filename : `${filename}.mp4`);
    return new File([buf], shareName, { type });
  }

  async function shareFileToAlbum(file) {
    if (!navigator.share) {
      throw new Error("当前浏览器不支持系统分享");
    }

    const payload = { files: [file], title: file.name.replace(/\.mp4$/i, "") };

    // iOS：canShare 有时误报 false，仍应直接尝试 share
    if (typeof navigator.canShare === "function") {
      try {
        if (!navigator.canShare(payload) && !navigator.canShare({ files: [file] })) {
          // 仍尝试一次；失败再走 fallback
        }
      } catch {
        /* ignore canShare quirks */
      }
    }

    await navigator.share(payload);
  }

  function iosFallbackOpen(url) {
    const abs = absoluteUrl(url);
    alert(
      "请在弹出的页面里点分享按钮 ▢↑，再选「存储到照片」。\n\n也可以回到本页，长按上方视频 →「存储到照片」。"
    );
    window.open(abs, "_blank", "noopener");
  }

  async function saveMediaToAlbum(url, filename) {
    const file = await fetchVideoFile(url, filename);

    try {
      await shareFileToAlbum(file);
      return;
    } catch (err) {
      if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) {
        // 用户取消分享面板
        return;
      }
      // iOS 分享失败时走明确指引
      if (isIos()) {
        iosFallbackOpen(url);
        return;
      }
      throw err;
    }
  }

  function bindDownload(el, url, opts = {}) {
    const filename = opts.filename || "video.mp4";
    const wantAlbum =
      opts.album === true ||
      (opts.album !== false && /\.mp4($|\?)/i.test(filename));
    const mobile = isMobileUa();
    const abs = absoluteUrl(url);

    if (mobile && wantAlbum) {
      if (!el.dataset.origLabel) el.dataset.origLabel = el.textContent;
      el.textContent = isIos() ? "存到照片" : "保存到相册";
      el.removeAttribute("download");
      el.href = abs;
      el.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const prev = el.textContent;
        el.textContent = "准备中…";
        el.setAttribute("aria-busy", "true");
        try {
          await saveMediaToAlbum(abs, filename);
        } catch (err) {
          if (
            err &&
            (err.name === "AbortError" || err.name === "NotAllowedError")
          ) {
            return;
          }
          if (isIos()) {
            iosFallbackOpen(abs);
          } else {
            alert(
              (err && err.message) ||
                "请在弹出的菜单里选择保存；若没有，可长按上方视频保存"
            );
            window.open(abs, "_blank", "noopener");
          }
        } finally {
          el.textContent = prev;
          el.removeAttribute("aria-busy");
        }
      };
      return;
    }

    bindClassicDownload(el, abs);
  }

  global.TangDownload = {
    isMobileUa,
    isIos,
    bindDownload,
    saveMediaToAlbum,
  };
})(window);
