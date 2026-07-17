/**
 * 真實琴弓疊在大提琴上：滑鼠拉弓 → 出聲 + 弓尖散發音符光效
 */

(() => {
  const banner = document.getElementById("hero-banner");
  const stage = document.getElementById("cello-stage");
  const canvas = document.getElementById("ripple-canvas");
  const cue = document.getElementById("hero-cue");
  const audioEl = document.getElementById("first-love-audio");
  const celloImg = document.getElementById("cello-img");
  const bowEl = document.getElementById("cello-bow");
  if (!banner || !stage || !canvas || !celloImg || !bowEl) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  const NOTES = ["♪", "♫", "♩", "♬"];

  const notes = [];
  const sparks = [];
  let raf = 0;
  let playing = false;
  let audioMode = "none";
  let audioCtx = null;
  let synthNodes = null;
  let pointerInside = false;
  let cssW = 0;
  let cssH = 0;
  let imgReady = false;

  // 弓沿水平拉奏位置（px，相對中心）
  let bowSlide = 0;
  let bowSlideTarget = 0;
  let lastPointerX = null;
  let lastEmit = 0;
  let bowEnergy = 0; // 拉動強度，控制發光與音符密度

  const SLIDE_MAX = 64; // 左右最大位移（手机滑动更明显）

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = stage.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function ensureImage() {
    if (imgReady) return true;
    if (celloImg.complete && celloImg.naturalWidth > 0) {
      imgReady = true;
      return true;
    }
    return false;
  }

  function drawCelloWhole() {
    if (!ensureImage()) return;
    const iw = celloImg.naturalWidth;
    const ih = celloImg.naturalHeight;
    const scale = Math.min(cssW / iw, cssH / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const ox = (cssW - dw) / 2;
    const oy = (cssH - dh) / 2;
    ctx.drawImage(celloImg, ox, oy, dw, dh);
  }

  /** 弓中心：參考圖約 51.5% × 63.7% */
  function bowCenter() {
    return {
      x: cssW * 0.515 + bowSlide,
      y: cssH * 0.637,
    };
  }

  function emitFromBow(burst = false) {
    const { x, y } = bowCenter();
    const n = burst ? 8 : 1 + Math.floor(bowEnergy * 3);
    for (let i = 0; i < n; i++) {
      const ang =
        -Math.PI / 2 +
        (Math.random() - 0.5) * 1.2 +
        (Math.random() < 0.5 ? -0.3 : 0.3);
      const spd = 0.9 + Math.random() * 2.2 * (0.4 + bowEnergy);
      notes.push({
        ch: NOTES[(Math.random() * NOTES.length) | 0],
        x: x + (Math.random() - 0.5) * 20,
        y: y + (Math.random() - 0.5) * 8,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 0.5,
        life: 1,
        rot: (Math.random() - 0.5) * 0.5,
        spin: (Math.random() - 0.5) * 0.05,
        size: 13 + Math.random() * 15,
        glow: 0.6 + Math.random() * 0.4,
      });
    }
    // 光點火花
    const sn = burst ? 14 : 3 + Math.floor(bowEnergy * 6);
    for (let i = 0; i < sn; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.4 + Math.random() * 2.5;
      sparks.push({
        x: x + (Math.random() - 0.5) * 12,
        y: y + (Math.random() - 0.5) * 6,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 0.8,
        life: 1,
        size: 1.2 + Math.random() * 2.4,
      });
    }
    if (notes.length > 70) notes.splice(0, notes.length - 70);
    if (sparks.length > 100) sparks.splice(0, sparks.length - 100);
  }

  function drawBowGlowAura() {
    if (bowEnergy < 0.05 && !playing) return;
    const { x, y } = bowCenter();
    const a = 0.08 + bowEnergy * 0.22;
    const g = ctx.createRadialGradient(x, y, 4, x, y, 70 + bowEnergy * 40);
    g.addColorStop(0, `rgba(180, 255, 245, ${a})`);
    g.addColorStop(0.45, `rgba(80, 210, 220, ${a * 0.45})`);
    g.addColorStop(1, "rgba(40, 180, 190, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 70 + bowEnergy * 40, 0, Math.PI * 2);
    ctx.fill();

    // 沿弓方向的細光帶
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0);
    const band = ctx.createLinearGradient(-cssW * 0.28, 0, cssW * 0.28, 0);
    band.addColorStop(0, "rgba(160,240,230,0)");
    band.addColorStop(0.5, `rgba(200, 255, 250, ${0.12 + bowEnergy * 0.25})`);
    band.addColorStop(1, "rgba(160,240,230,0)");
    ctx.fillStyle = band;
    ctx.fillRect(-cssW * 0.28, -3, cssW * 0.56, 6);
    ctx.restore();
  }

  function drawNotes() {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      n.x += n.vx;
      n.y += n.vy;
      n.vy -= 0.015;
      n.vx *= 0.994;
      n.rot += n.spin;
      n.life *= 0.976;
      if (n.life < 0.04) {
        notes.splice(i, 1);
        continue;
      }
      const alpha = n.life * n.glow;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.rotate(n.rot);
      ctx.font = `${n.size * (0.75 + n.life * 0.25)}px "Fraunces", "Apple Symbols", "Segoe UI Symbol", serif`;
      ctx.shadowColor = `rgba(80, 240, 230, ${alpha})`;
      ctx.shadowBlur = 14;
      ctx.fillStyle = `rgba(190, 255, 248, ${alpha})`;
      ctx.fillText(n.ch, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawSparks() {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.02;
      s.life *= 0.94;
      if (s.life < 0.05) {
        sparks.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(170, 255, 245, ${s.life})`;
      ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function applyBowTransform() {
    // 平滑跟隨
    bowSlide += (bowSlideTarget - bowSlide) * 0.28;
    stage.style.setProperty("--bow-slide", bowSlide.toFixed(2));
    stage.style.setProperty(
      "--bow-lift",
      `${(-bowEnergy * 2).toFixed(2)}px`
    );
  }

  function frame() {
    // 能量自然衰減
    bowEnergy *= 0.92;
    if (bowEnergy < 0.02) bowEnergy = 0;

    ctx.clearRect(0, 0, cssW, cssH);
    // 琴身與弓用 DOM 圖層；畫布只疊光效與音符
    drawBowGlowAura();
    drawSparks();
    drawNotes();
    applyBowTransform();

    raf = requestAnimationFrame(frame);
  }

  function localXY(e) {
    const rect = stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerMove(e) {
    const { x } = localXY(e);
    const nx = (x / Math.max(1, cssW)) * 2 - 1;
    bowSlideTarget = Math.max(-SLIDE_MAX, Math.min(SLIDE_MAX, nx * SLIDE_MAX));

    let speed = 0;
    if (lastPointerX != null) speed = Math.abs(x - lastPointerX);
    lastPointerX = x;
    const boost = e.pointerType === "touch" ? 0.07 : 0.045;
    bowEnergy = Math.min(1, bowEnergy + speed * boost);

    const now = performance.now();
    if (speed > 0.6 && now - lastEmit > 36) {
      emitFromBow(false);
      lastEmit = now;
    }
  }

  function playCelloNote(ac, dest, freq, when, dur, gain = 0.09) {
    const osc = ac.createOscillator();
    const fil = ac.createBiquadFilter();
    const g = ac.createGain();
    const lfo = ac.createOscillator();
    const lfoG = ac.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, when);
    fil.type = "lowpass";
    fil.frequency.setValueAtTime(900, when);
    fil.Q.value = 0.7;

    lfo.frequency.value = 5.2;
    lfoG.gain.value = 4.5;
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);

    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.12);
    g.gain.exponentialRampToValueAtTime(gain * 0.7, when + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    osc.connect(fil);
    fil.connect(g);
    g.connect(dest);
    osc.start(when);
    lfo.start(when);
    osc.stop(when + dur + 0.05);
    lfo.stop(when + dur + 0.05);
  }

  let startLock = null;
  let serverAudio = false;
  let keepAliveTimer = 0;
  let stopTimer = 0;
  let stroking = false; // 手指/鼠标按住滑动中
  const coarsePointer =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    "ontouchstart" in window;
  const isLocalHost =
    location.hostname === "127.0.0.1" || location.hostname === "localhost";
  // 手机或远程访问：必须用浏览器播，afplay 只会在服务器本机响
  const allowServerAudio = isLocalHost && !coarsePointer;

  function setCueIdle() {
    if (!cue) return;
    cue.textContent = coarsePointer
      ? "手指按住琴身滑动 · 拉弓出声"
      : "鼠标移上或按住滑动 · 拉弓出声";
  }

  function setCuePlaying(label) {
    if (cue) cue.textContent = label;
  }

  async function pingServerAudio(path) {
    try {
      const res = await fetch(path, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      return res.ok && data.ok !== false;
    } catch {
      return false;
    }
  }

  function stopServerAudio() {
    if (!allowServerAudio) return;
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/banner-audio/stop");
    } else {
      fetch("/api/banner-audio/stop", { method: "POST", keepalive: true }).catch(
        () => {}
      );
    }
  }

  function clearKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = 0;
    }
  }

  function beginKeepAlive() {
    if (!allowServerAudio) return;
    clearKeepAlive();
    keepAliveTimer = setInterval(() => {
      if (!stroking && !pointerInside) return;
      pingServerAudio("/api/banner-audio/ensure");
    }, 1500);
  }

  async function ensureAudioUnlocked() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {
        /* noop */
      }
    }
    return audioCtx.state === "running";
  }

  async function startSynth() {
    await ensureAudioUnlocked();
    if (synthNodes) return;
    if (audioCtx?.state !== "running") return;

    const master = audioCtx.createGain();
    master.gain.value = 0.95;
    const comp = audioCtx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(audioCtx.destination);

    const pad = audioCtx.createOscillator();
    const padF = audioCtx.createBiquadFilter();
    const padG = audioCtx.createGain();
    pad.type = "triangle";
    pad.frequency.value = 98;
    padF.type = "lowpass";
    padF.frequency.value = 280;
    padG.gain.value = 0.06;
    pad.connect(padF);
    padF.connect(padG);
    padG.connect(master);
    pad.start();

    const theme = [
      [220.0, 1.6],
      [246.94, 1.2],
      [261.63, 1.8],
      [246.94, 1.0],
      [220.0, 1.4],
      [196.0, 1.8],
      [174.61, 2.2],
      [196.0, 1.4],
      [220.0, 2.0],
      [261.63, 1.2],
      [293.66, 1.6],
      [261.63, 1.4],
      [246.94, 2.0],
      [220.0, 2.4],
    ];

    let t = audioCtx.currentTime + 0.05;
    const scheduleLoop = () => {
      if (!playing || audioMode !== "synth") return;
      const start = Math.max(audioCtx.currentTime + 0.02, t);
      let cursor = start;
      for (const [freq, beats] of theme) {
        const dur = beats * 0.55;
        playCelloNote(audioCtx, master, freq, cursor, dur, 0.12);
        playCelloNote(audioCtx, master, freq / 2, cursor, dur, 0.07);
        cursor += dur * 0.92;
      }
      t = cursor + 0.35;
      synthNodes.timer = setTimeout(scheduleLoop, (cursor - audioCtx.currentTime) * 1000);
    };

    synthNodes = { master, pad, padG, timer: null };
    scheduleLoop();
  }

  function stopSynth() {
    if (!synthNodes) return;
    clearTimeout(synthNodes.timer);
    try {
      synthNodes.pad.stop();
    } catch {
      /* noop */
    }
    try {
      synthNodes.master.disconnect();
    } catch {
      /* noop */
    }
    synthNodes = null;
  }

  function siteUrl(path) {
    const clean = String(path || "").replace(/^\//, "");
    const base =
      document.querySelector("base")?.href || `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`;
    return new URL(clean, base).href;
  }

  function waitCanPlay(el, ms = 5000) {
    if (el.readyState >= 2 && !el.error) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        el.removeEventListener("canplay", onOk);
        el.removeEventListener("error", onErr);
        clearTimeout(timer);
        resolve(ok);
      };
      const onOk = () => finish(true);
      const onErr = () => finish(false);
      const timer = setTimeout(() => finish(el.readyState >= 2 && !el.error), ms);
      el.addEventListener("canplay", onOk, { once: true });
      el.addEventListener("error", onErr, { once: true });
    });
  }

  async function startBrowserAudio() {
    if (!audioEl) return false;
    try {
      await ensureAudioUnlocked();
      const fallbacks = [
        "audio/first-love-cello.mp3",
        "audio/hao-jiu-bu-jian-cello.mp3",
      ].map(siteUrl);

      // 公网站 / 子路径下必须显式设对 src，不能依赖根路径 /audio/...
      const needReload =
        audioEl.error ||
        audioEl.readyState < 2 ||
        !audioEl.currentSrc ||
        fallbacks.every((u) => !audioEl.currentSrc.includes("/audio/"));

      if (needReload) {
        for (const src of fallbacks) {
          try {
            const probe = await fetch(src, {
              method: "GET",
              headers: { Range: "bytes=0-1" },
            });
            if (!probe.ok) continue;
            audioEl.pause();
            audioEl.removeAttribute("src");
            audioEl.innerHTML = "";
            audioEl.src = src;
            audioEl.load();
            const ok = await waitCanPlay(audioEl);
            if (ok) break;
          } catch {
            /* try next */
          }
        }
      }

      audioEl.muted = false;
      audioEl.volume = 0.9;
      try {
        // 取消 muted autoplay 后必须再 play 一次，部分浏览器才会出声
        await audioEl.play();
      } catch (err) {
        console.warn("[hero-cello] play() blocked", err);
        return false;
      }
      return !audioEl.paused && !audioEl.muted;
    } catch (err) {
      console.warn("[hero-cello] browser audio failed", err);
      return false;
    }
  }

  /** 按住/滑过琴身 → 出声；松开离开 → 停 */
  async function startMusic() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = 0;
    }
    if (playing && (audioMode === "server" || audioMode === "file" || audioMode === "synth")) {
      banner.classList.add("is-playing");
      return;
    }
    if (startLock) return startLock;

    startLock = (async () => {
      banner.classList.add("is-playing");

      // 手机/远程：优先浏览器内播放（触控按下即可解锁）
      const fileOk = await startBrowserAudio();
      if (fileOk) {
        playing = true;
        audioMode = "file";
        stopSynth();
        setCuePlaying("拉弓中 · 大提琴");
        return;
      }

      // 仅本机桌面可回退 afplay
      if (allowServerAudio && serverAudio) {
        const ok = await pingServerAudio("/api/banner-audio/start");
        if (ok) {
          playing = true;
          audioMode = "server";
          stopSynth();
          audioEl?.pause();
          beginKeepAlive();
          setCuePlaying("拉弓中 · 大提琴");
          return;
        }
        serverAudio = false;
      }

      audioMode = "synth";
      playing = true;
      await startSynth();
      if (synthNodes && audioCtx?.state === "running") {
        setCuePlaying("拉弓中 · 大提琴曲");
        return;
      }

      playing = false;
      audioMode = "none";
      stopSynth();
      banner.classList.remove("is-playing");
      setCueIdle();
    })().finally(() => {
      startLock = null;
    });

    return startLock;
  }

  function stopMusic() {
    clearKeepAlive();
    playing = false;
    banner.classList.remove("is-playing");
    stopServerAudio();
    if (audioEl) {
      audioEl.pause();
    }
    stopSynth();
    setCueIdle();
    audioMode = "none";
  }

  function scheduleStop() {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = 0;
      if (!stroking && !pointerInside) stopMusic();
    }, 220);
  }

  function beginStroke(e) {
    stroking = true;
    pointerInside = true;
    banner.classList.add("is-hover");
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    lastPointerX = localXY(e).x;
    onPointerMove(e);
    bowEnergy = Math.min(1, bowEnergy + 0.55);
    emitFromBow(true);
    startMusic();
  }

  function endStroke(e) {
    stroking = false;
    try {
      if (e?.pointerId != null) stage.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    // 触控没有 hover：松手即准备停；鼠标可仍在舞台内则继续
    if (e?.pointerType && e.pointerType !== "mouse") {
      pointerInside = false;
      banner.classList.remove("is-hover");
      lastPointerX = null;
      bowSlideTarget = 0;
    }
    scheduleStop();
  }

  // —— 统一指针模型：桌面鼠标 / 手机手指同一套 ——
  stage.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      beginStroke(e);
    },
    { passive: false }
  );

  stage.addEventListener(
    "pointermove",
    (e) => {
      // 手机：必须按住滑；桌面：悬停也可动弓
      const active =
        stroking || (e.pointerType === "mouse" && pointerInside);
      if (!active) return;
      onPointerMove(e);
      if (!playing) startMusic();
      else if (
        allowServerAudio &&
        serverAudio &&
        audioMode === "server" &&
        bowEnergy > 0.35
      ) {
        pingServerAudio("/api/banner-audio/ensure");
      }
    },
    { passive: true }
  );

  stage.addEventListener("pointerup", endStroke);
  stage.addEventListener("pointercancel", endStroke);

  // 桌面：移入即可出声（与按住滑动并存）
  stage.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    pointerInside = true;
    banner.classList.add("is-hover");
    lastPointerX = localXY(e).x;
    startMusic();
  });
  stage.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    if (stroking) return;
    pointerInside = false;
    banner.classList.remove("is-hover");
    lastPointerX = null;
    bowSlideTarget = 0;
    scheduleStop();
  });

  window.addEventListener("pagehide", () => stopMusic());
  window.addEventListener("beforeunload", () => stopMusic());

  celloImg.addEventListener("load", () => {
    imgReady = true;
  });
  if (celloImg.complete) imgReady = true;

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  raf = requestAnimationFrame(frame);

  setCueIdle();
  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      serverAudio = allowServerAudio && Boolean(h.bannerAudio);
      setCueIdle();
    })
    .catch(() => {
      setCueIdle();
    });
})();
