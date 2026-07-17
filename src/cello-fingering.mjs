/**
 * 大提琴指法／把位識別
 * mode:
 *   - natural：該幾把就是幾把（能一把就一把）
 *   - first：強制一把位版本
 *   - multi：多把位教學版（按譜面換把意圖）
 */

const STRINGS = [
  { id: "A", label: "A弦", open: 57 },
  { id: "D", label: "D弦", open: 50 },
  { id: "G", label: "G弦", open: 43 },
  { id: "C", label: "C弦", open: 36 },
];

const POS_NAME = {
  1: "一把位",
  2: "二把位",
  3: "三把位",
  4: "四把位",
  5: "五把位",
  6: "六把位",
  7: "拇指把位",
};

function fingerName(finger) {
  if (finger === 0) return "空弦";
  if (finger === -1) return "拇指";
  return `${finger}指`;
}

function fingerFromLocal(local) {
  if (local <= 2) return 1;
  if (local <= 4) return 2;
  if (local <= 6) return 3;
  return 4;
}

/**
 * 單弦上所有可行把位／指法（半音距離模型）
 * d = midi - open
 */
export function fingeringsOnString(midi, string) {
  const d = midi - string.open;
  if (d < 0 || d > 26) return [];

  const out = [];

  if (d === 0) {
    out.push({
      stringId: string.id,
      stringLabel: string.label,
      position: 1,
      posName: "一把位",
      finger: 0,
      fingerName: "空弦",
      distance: 0,
    });
    return out;
  }

  // 拇指把位（高把）
  if (d >= 17) {
    out.push({
      stringId: string.id,
      stringLabel: string.label,
      position: 7,
      posName: "拇指把位",
      finger: -1,
      fingerName: "拇指",
      distance: d,
    });
  }

  // 各把位：把位 p 的「把位根」約在空弦上方 (p-1)*2 半音（簡化教學模型）
  for (let position = 1; position <= 6; position++) {
    const shift = (position - 1) * 2;
    const local = d - shift;
    if (local < 1 || local > 7) continue;
    // 一把位可到 7；中高把本地距離通常 1–5 更自然
    if (position >= 2 && local > 5) continue;
    const finger = fingerFromLocal(local);
    out.push({
      stringId: string.id,
      stringLabel: string.label,
      position,
      posName: POS_NAME[position] || `${position}把位`,
      finger,
      fingerName: fingerName(finger),
      distance: d,
    });
  }

  return out;
}

/** 兼容舊接口：回傳單一最佳候選（偏一把位） */
export function fingeringOnString(midi, string) {
  const all = fingeringsOnString(midi, string);
  if (!all.length) return null;
  return all.find((c) => c.position === 1) || all[0];
}

function scoreNatural(c, prev) {
  // 該幾把就是幾把：能一把就一把，少換把、少換弦
  let s = c.position * 12 + (c.finger === 0 ? 0 : c.finger);
  const stringPref = { A: 0, D: 1, G: 2, C: 3 };
  s += (stringPref[c.stringId] ?? 2) * 0.5;
  if (prev) {
    if (c.stringId === prev.stringId) s -= 22;
    if (c.position === prev.position) s -= 18;
    s += Math.abs(c.position - prev.position) * 10;
    if (c.stringId !== prev.stringId) s += 6;
  }
  if (c.finger === 0) s -= 12;
  if (c.position === 1) s -= 8;
  return s;
}

function scoreMulti(c, prev) {
  // 多把位版：同弦同把優先，並按音高落在合理把位（對齊教學譜換把）
  let s = c.finger === 0 ? -6 : c.finger;
  const stringPref = { A: 0, D: 1, G: 2, C: 3 };
  s += (stringPref[c.stringId] ?? 2) * 0.4;
  if (prev) {
    if (c.stringId === prev.stringId) s -= 16;
    if (c.position === prev.position) s -= 20;
    const jump = Math.abs(c.position - prev.position);
    if (jump === 1) s -= 6;
    else if (jump >= 3) s += 8;
  }
  if (c.finger === 0) {
    s -= 10;
  } else if (c.distance <= 7) {
    // 低音區：一把為主
    if (c.position === 1) s -= 18;
    else s += 8;
  } else if (c.distance <= 12) {
    // 中音：二三把
    if (c.position === 2 || c.position === 3) s -= 22;
    else if (c.position === 1) s += 6;
  } else if (c.distance <= 17) {
    // 偏高：三四把
    if (c.position === 3 || c.position === 4) s -= 22;
    else if (c.position === 2) s -= 8;
    else if (c.position === 1) s += 14;
  } else {
    // 高把／拇指
    if (c.position >= 4) s -= 18;
    else s += 10;
  }
  return s;
}

function scoreFirst(c, prev) {
  // 一把位版：只留一把／空弦，同弦優先
  let s = c.finger === 0 ? -8 : c.finger;
  const stringPref = { A: 0, D: 1, G: 2, C: 3 };
  s += (stringPref[c.stringId] ?? 2) * 0.5;
  if (prev) {
    if (c.stringId === prev.stringId) s -= 24;
    if (c.stringId !== prev.stringId) s += 4;
  }
  return s;
}

/**
 * @param {Array} notes
 * @param {'natural'|'first'|'multi'} [mode]
 */
export function assignCelloFingerings(notes, mode = "natural") {
  const scorer =
    mode === "first"
      ? scoreFirst
      : mode === "multi"
        ? scoreMulti
        : scoreNatural;

  let prev = null;
  return notes.map((note) => {
    let candidates = STRINGS.flatMap((str) =>
      fingeringsOnString(note.midi, str)
    );
    if (mode === "first") {
      const onlyFirst = candidates.filter((c) => c.position === 1);
      if (onlyFirst.length) candidates = onlyFirst;
    }

    if (!candidates.length) {
      const fb = {
        stringId: "?",
        stringLabel: "超出常规",
        position: 0,
        posName: "特殊把位",
        finger: -1,
        fingerName: "—",
        distance: -1,
      };
      return { ...note, fingering: fb };
    }

    let best = candidates[0];
    let bestScore = Infinity;
    for (const c of candidates) {
      const sc = scorer(c, prev);
      if (sc < bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    prev = best;
    return { ...note, fingering: best };
  });
}

export function fingeringLabel(f) {
  if (!f) return "";
  if (f.finger === 0) return `${f.stringLabel} · ${f.posName} · 空弦`;
  return `${f.stringLabel} · ${f.posName} · ${f.fingerName}`;
}

/** 把位分級：供音色／顏色區分（1=一把，2=中，3=高/拇指） */
export function positionTier(position) {
  if (!position || position <= 1) return 1;
  if (position <= 3) return 2;
  return 3;
}
