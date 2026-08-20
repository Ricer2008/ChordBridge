// ============================================================
// ChordBridge 谱面渲染引擎：四类谱面统一输出 SVG
// 简谱 / 五线谱 / 六线单音谱 / 六线和弦谱
// 支持：beats 模型（休止/同拍多音）、多音轨、主题色、播放高亮锚点、自动换行
// ------------------------------------------------------------
//   perLine = 0 或省略 → 不换行（单行，旧行为）
//   perLine > 0        → 每 perLine 拍折一行，谱图按行堆叠，阅读性更强
// ============================================================
import { noteToPitch, findFret, jianpuDots } from "./theory.js";
import { getChordShape, chordMidiNotes } from "./chords.js";

const NOTE_W = 46;          // 每拍占宽
const MARGIN = 28;

// 从 CSS 变量读取当前主题色（切换主题后重新渲染即可生效）
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (v, fb) => (cs.getPropertyValue(v).trim() || fb);
  return {
    fg: g("--fg", "#e8e6e3"),
    accent: g("--accent", "#e8b04b"),
    dim: g("--dim", "#9a968f"),
    card: g("--card", "#1e1f22"),
    hl: g("--hl", "#5bc0eb"),
    danger: g("--danger", "#e05252"),
  };
}

function svgOpen(w, h, card) {
  // 背景透明：让容器（谱纸）的纸质纹理透出，更拟物
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="'Helvetica Neue',Arial,'PingFang SC',sans-serif">`;
}
const T = (x, y, s, size, fill, anchor, weight, extra) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight || "normal"}" ${extra || ""}>${s}</text>`;
const L = (x1, y1, x2, y2, w, stroke) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"/>`;

// 和弦标签：根据 x 位置自动选择对齐方式，防止渲染出界
function chordLabel(x, y, text, size, C, W) {
  const estW = text.length * size * 0.62;
  let anchor = "middle", ax = x;
  if (x - estW / 2 < 10) { anchor = "start"; ax = 6; }
  else if (x + estW / 2 > W - 10) { anchor = "end"; ax = W - 6; }
  return T(ax, y, text, size, C.accent, anchor, "bold");
}

function accSymbol(acc) { return acc > 0 ? "♯" : acc < 0 ? "♭" : ""; }

function header(x, y, title, keyName, meter, bpm, C, trackName) {
  const sub = trackName ? `  ·  ${trackName}` : "";
  return T(x, y, title, 15, C.accent, "start", "bold") +
    T(x, y + 20, `1=${keyName}   ${meter.num}/${meter.den}   ♩=${bpm}${sub}`, 12, C.dim, "start");
}

// 布局：每行 perLine 拍，返回每拍的二维坐标 {x,y}（y 为行基准，调用方叠加到具体音符）
//   pos[i]   = {x, y}    第 i 拍中心坐标
//   bars[r]  = [x, ...]  第 r 行内小节线（含行尾竖线）
//   width    = 内容最大宽（取各行最宽）
//   rows     = 总行数
function layout(beats, meter, x0, y0, rowStep, perLine) {
  const perBar = meter.num;
  const cols = perLine > 0 ? perLine : (beats.length || 1);
  const rows = Math.max(1, Math.ceil(beats.length / cols));
  const pos = new Array(beats.length);
  const bars = [];
  let contentW = 0;
  for (let r = 0; r < rows; r++) {
    const startI = r * cols;
    const endI = Math.min(startI + cols, beats.length);
    const rowBars = [];
    let x = x0;
    for (let i = startI; i < endI; i++) {
      if (i > startI && i % perBar === 0) { rowBars.push(x); x += 14; }
      pos[i] = { x: x + NOTE_W / 2, y: y0 + r * rowStep };
      x += NOTE_W;
    }
    rowBars.push(x + 4); // 行尾竖线
    bars.push(rowBars);
    contentW = Math.max(contentW, x);
  }
  return { pos, bars, width: contentW + 20, rows };
}

// 高亮锚点属性
const HL = (tk, bi, ni) =>
  `class="cb-note" data-tk="${tk}" data-bt="${bi}"${ni !== undefined ? ` data-nt="${ni}"` : ""}`;

// ---------------- 1. 简谱 ----------------
export function renderJianpu(track, global, tk, perLine) {
  const { beats, octave, chordMap } = track;
  const { key, meter, bpm } = global;
  const C = themeColors();
  const y0 = 92, rowStep = 64, block = 30;
  const { pos, bars, width, rows } = layout(beats, meter, MARGIN, y0, rowStep, perLine);
  const W = Math.max(width + MARGIN, 360);
  const H = y0 + (rows - 1) * rowStep + block + 24;
  let s = svgOpen(W, H, C.card);
  s += header(MARGIN, 30, "简谱", key.name, meter, bpm, C, track.name);
  beats.forEach((beat, bi) => {
    const { x, y } = pos[bi];
    if (chordMap[bi + 1]) s += chordLabel(x, y - 30, chordMap[bi + 1], 13, C, W);
    if (beat.isTie) {
      s += `<line x1="${x - 15}" y1="${y - 2}" x2="${x + 15}" y2="${y - 2}" stroke="${C.fg}" stroke-width="3" stroke-linecap="round" ${HL(tk, bi)}/>`;
      return;
    }
    if (beat.isRest) {
      s += T(x, y, "0", 20, C.dim, "middle", "bold", HL(tk, bi));
      for (let d = 0; d < (beat.dots || 0); d++)
        s += `<circle cx="${x + 11 + d * 6}" cy="${y - 6}" r="2.5" fill="${C.dim}"/>`;
      return;
    }
    const n = beat.notes.length;
    beat.notes.forEach((note, ni) => {
      const nx = n === 1 ? x : x + (ni - (n - 1) / 2) * 17;
      const sym = accSymbol(note.acc);
      if (sym) s += T(nx - 11, y + 1, sym, 11, C.dim);
      s += T(nx, y, String(note.degree), 20, C.fg, "middle", "bold", HL(tk, bi, ni));
      const dots = jianpuDots(note) + octave;
      for (let d = 1; d <= Math.abs(dots); d++) {
        const dy = dots > 0 ? -18 - (d - 1) * 5 : 12 + (d - 1) * 5;
        s += `<circle cx="${nx}" cy="${y + dy}" r="2.5" fill="${C.fg}"/>`;
      }
    });
    // 附点（记在拍右侧）
    if (beat.dots) {
      const lastNx = n === 1 ? x : x + ((n - 1) / 2) * 17;
      for (let d = 0; d < beat.dots; d++)
        s += `<circle cx="${lastNx + 12 + d * 6}" cy="${y - 6}" r="2.5" fill="${C.fg}"/>`;
    }
    // 三连音标记（一拍均分 3 音）
    if (n === 3) {
      const x1 = x - 25, x2 = x + 25;
      s += `<path d="M ${x1} ${y + 12} Q ${x} ${y + 20} ${x2} ${y + 12}" fill="none" stroke="${C.dim}" stroke-width="1"/>` +
        T(x, y + 32, "3", 10, C.dim, "middle", "bold");
    }
  });
  bars.forEach((rowBars, r) => {
    const by0 = y0 + r * rowStep - 16, by1 = y0 + r * rowStep + 6;
    rowBars.forEach((bx, i) =>
      s += L(bx + 7, by0, bx + 7, by1, i === rowBars.length - 1 ? 2.5 : 1, C.dim));
  });
  return s + "</svg>";
}

// ---------------- 2. 五线谱 ----------------
const LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

export function renderStaff(track, global, tk, perLine) {
  const { beats, octave, chordMap } = track;
  const { key, meter, bpm } = global;
  const C = themeColors();
  // 预算所有音高中位数
  const allP = [];
  beats.forEach((b) => b.notes.forEach((n) => allP.push(noteToPitch(n, key, octave))));
  const median = allP.length
    ? [...allP].sort((a, b) => a.midi - b.midi)[Math.floor(allP.length / 2)].midi : 60;
  const useTreble = median >= 57;

  const SP = 9;
  const y0 = 84, rowStep = 122;
  const lineY = (i, ty) => ty + i * SP;
  const dia = (p) => p.octaveSci * 7 + LETTER_IDX[p.letter];
  const topDia = useTreble ? 5 * 7 + 3 : 3 * 7 + 5;
  const yOf = (p, ty) => ty + (topDia - dia(p)) * (SP / 2);

  const nAcc = Math.abs(key.acc);
  const keySigW = nAcc * 11 + 8;
  const x0 = MARGIN + 40 + keySigW + 26;
  const { pos, bars, width, rows } = layout(beats, meter, x0, y0, rowStep, perLine);
  const W = Math.max(width + MARGIN, 420);
  const H = y0 + (rows - 1) * rowStep + 4 * SP + 40;

  let s = svgOpen(W, H, C.card);
  s += header(MARGIN, 26, "五线谱", key.name, meter, bpm, C, track.name);

  // 每行谱表 + 谱号 + 调号 + 拍号 + 左端竖线
  for (let r = 0; r < rows; r++) {
    const ty = y0 + r * rowStep;
    for (let i = 0; i < 5; i++) s += L(MARGIN, lineY(i, ty), W - MARGIN, lineY(i, ty), 1, C.dim);
    s += useTreble
      ? T(MARGIN + 16, lineY(3, ty) + 12, "𝄞", 46, C.fg)
      : T(MARGIN + 16, lineY(2, ty) + 8, "𝄢", 34, C.fg);
    for (let i = 0; i < nAcc; i++) {
      const letter = key.acc > 0 ? SHARP_ORDER[i] : FLAT_ORDER[i];
      let d = key.acc > 0
        ? { F: 38, C: 35, G: 39, D: 36, A: 33, E: 37, B: 34 }[letter]
        : { B: 34, E: 37, A: 33, D: 36, G: 32, C: 35, F: 31 }[letter];
      if (!useTreble) d -= 2;
      const y = ty + (topDia - d) * (SP / 2);
      s += T(MARGIN + 44 + i * 11, y + 4, key.acc > 0 ? "♯" : "♭", 16, C.fg);
    }
    s += T(MARGIN + 44 + keySigW, lineY(1, ty) + 5, String(meter.num), 16, C.fg, "middle", "bold");
    s += T(MARGIN + 44 + keySigW, lineY(3, ty) + 5, String(meter.den), 16, C.fg, "middle", "bold");
    s += L(MARGIN, ty, MARGIN, ty + 4 * SP, 1.4, C.dim);
  }

  beats.forEach((beat, bi) => {
    const { x, y: ty } = pos[bi];
    if (chordMap[bi + 1]) s += chordLabel(x, ty - 22, chordMap[bi + 1], 13, C, W);
    if (beat.isTie) {
      const ty2 = lineY(2, ty);
      s += `<path d="M ${x-15} ${ty2+3} Q ${x} ${ty2-6} ${x+15} ${ty2+3}" fill="none" stroke="${C.fg}" stroke-width="1.8" ${HL(tk, bi)}/>`;
      return;
    }
    if (beat.isRest) {
      s += T(x, lineY(2, ty) + 6, "𝄽", 30, C.dim, "middle", "normal", HL(tk, bi));
      for (let d = 0; d < (beat.dots || 0); d++)
        s += `<circle cx="${x + 12 + d * 5}" cy="${lineY(2, ty)}" r="2.2" fill="${C.dim}"/>`;
      return;
    }
    // 同拍多音：和弦式符头
    const ps = beat.notes.map((n) => noteToPitch(n, key, octave));
    let topY2 = Infinity, botY2 = -Infinity;
    ps.forEach((p, ni) => {
      const y = yOf(p, ty);
      const dd = dia(p);
      for (let ld = topDia + 2; ld <= dd; ld += 2) {
        const ly = ty + (topDia - ld) * (SP / 2);
        s += L(x - 9, ly, x + 9, ly, 1, C.dim);
      }
      for (let ld = topDia - 10; ld >= dd; ld -= 2) {
        const ly = ty + (topDia - ld) * (SP / 2);
        s += L(x - 9, ly, x + 9, ly, 1, C.dim);
      }
      // 调号感知：仅当拼写超出调号覆盖范围才画变音记号
      if (p.showAcc !== 0)
        s += T(x - 13, y + 4, accSymbol(p.showAcc), 14, C.fg);
      s += `<ellipse cx="${x}" cy="${y}" rx="5.5" ry="4" fill="${C.fg}" transform="rotate(-15 ${x} ${y})" ${HL(tk, bi, ni)}/>`;
      topY2 = Math.min(topY2, y); botY2 = Math.max(botY2, y);
    });
    // 共用符干
    const stemUp = (topY2 + botY2) / 2 >= lineY(2, ty);
    if (stemUp) s += L(x + 5, botY2 - 1, x + 5, topY2 - 30, 1.4, C.fg);
    else s += L(x - 5, topY2 + 1, x - 5, botY2 + 30, 1.4, C.fg);
    // 附点（符头右侧）
    for (let d = 0; d < (beat.dots || 0); d++)
      s += `<circle cx="${x + 13 + d * 5}" cy="${topY2}" r="2.2" fill="${C.fg}"/>`;
    // 三连音标记（一拍均分 3 音）
    if (beat.notes.length === 3)
      s += T(x, ty - 8, "3", 11, C.dim, "middle", "bold");
  });
  bars.forEach((rowBars, r) => {
    const ty = y0 + r * rowStep;
    rowBars.forEach((bx, i) =>
      s += L(bx + 7, ty, bx + 7, ty + 4 * SP, i === rowBars.length - 1 ? 2.5 : 1, C.dim));
  });
  return s + "</svg>";
}

// ---------------- 3. 六线谱（单音/和弦） ----------------
export function renderTab(track, global, tk, withChords = false, perLine) {
  const { beats, octave, chordMap } = track;
  const { key, meter, bpm, position } = global;
  const C = themeColors();
  const SP = 11;
  const y0 = withChords ? 190 : 92;
  const rowStep = withChords ? 200 : 190;
  const lineY = (i, ty) => ty + i * SP;
  const x0 = MARGIN + 46;
  const { pos, bars, width, rows } = layout(beats, meter, x0, y0, rowStep, perLine);
  const W = Math.max(width + MARGIN, 420);
  const H = y0 + (rows - 1) * rowStep + 5 * SP + 40;

  let s = svgOpen(W, H, C.card);
  s += header(MARGIN, 26, withChords ? "六线和弦谱" : "六线单音谱（TAB）", key.name, meter, bpm, C, track.name);
  const names = ["e", "B", "G", "D", "A", "E"];

  // 每行 6 线 + 弦名 + TAB 标签 + 左端竖线
  for (let r = 0; r < rows; r++) {
    const ty = y0 + r * rowStep;
    for (let i = 0; i < 6; i++) {
      s += L(MARGIN + 34, lineY(i, ty), W - MARGIN, lineY(i, ty), 1, C.dim);
      s += T(MARGIN + 22, lineY(i, ty) + 4, names[i], 10, C.dim);
    }
    s += T(MARGIN + 40, lineY(2, ty) + 8, "T A B", 11, C.dim, "middle", "bold",
      `transform="rotate(-90 ${MARGIN + 40} ${lineY(2, ty) + 8})" letter-spacing="2"`);
    s += L(MARGIN + 34, ty, MARGIN + 34, ty + 5 * SP, 1.4, C.dim);
  }

  beats.forEach((beat, bi) => {
    const { x, y: ty } = pos[bi];
    if (withChords && chordMap[bi + 1]) {
      const dcx = Math.max(40, Math.min(W - 40, x));
      s += drawChordDiagram(chordMap[bi + 1], dcx, ty - 116, C);
    } else if (!withChords && chordMap[bi + 1]) {
      s += chordLabel(x, ty - 18, chordMap[bi + 1], 12, C, W);
    }
    if (beat.isTie) {
      s += `<line x1="${x - 14}" y1="${lineY(2, ty)}" x2="${x + 14}" y2="${lineY(2, ty)}" stroke="${C.fg}" stroke-width="3" stroke-linecap="round" ${HL(tk, bi)}/>`;
      return;
    }
    if (beat.isRest) {
      s += T(x, lineY(2, ty) + 4, "×", 13, C.dim, "middle", "bold", HL(tk, bi));
      for (let d = 0; d < (beat.dots || 0); d++)
        s += `<circle cx="${x + 12 + d * 5}" cy="${lineY(2, ty)}" r="2.2" fill="${C.dim}"/>`;
      return;
    }
    beat.notes.forEach((note, ni) => {
      const p = noteToPitch(note, key, octave);
      const f = findFret(p.midi, position);
      if (!f) { s += T(x, lineY(2, ty), "?", 13, C.danger); return; }
      const y = lineY(f.string - 1, ty);
      s += `<rect x="${x - 8}" y="${y - 7}" width="16" height="13" fill="${C.card}"/>`;
      s += T(x, y + 4, String(f.fret), 12, f.transposed ? C.accent : C.fg, "middle", "bold", HL(tk, bi, ni));
    });
    // 附点（数字右侧）
    for (let d = 0; d < (beat.dots || 0); d++)
      s += `<circle cx="${x + 12 + d * 5}" cy="${lineY(2, ty)}" r="2.2" fill="${C.fg}"/>`;
    // 三连音标记（一拍均分 3 音）
    if (beat.notes.length === 3)
      s += T(x, lineY(5, ty) + 14, "3", 10, C.dim, "middle", "bold");
  });
  bars.forEach((rowBars, r) => {
    const ty = y0 + r * rowStep;
    rowBars.forEach((bx, i) =>
      s += L(bx + 7, ty, bx + 7, ty + 5 * SP, i === rowBars.length - 1 ? 2.5 : 1, C.dim));
  });
  return s + "</svg>";
}

// 和弦指法小方格
function drawChordDiagram(name, cx, top, C) {
  const shape = getChordShape(name);
  let s = T(cx, top + 10, name, 12, C.accent, "middle", "bold");
  if (!shape) return s + T(cx, top + 24, "(未收录)", 8, C.dim);
  const gw = 44, gh = 52, x0 = cx - gw / 2, y0 = top + 26;
  const colW = gw / 5, rowH = gh / 4;
  const played = shape.frets.filter((f) => f > 0);
  const minF = played.length ? Math.min(...played) : 1;
  const maxF = played.length ? Math.max(...played) : 1;
  const base = maxF <= 4 ? 1 : minF;
  for (let i = 0; i < 6; i++) s += L(x0 + i * colW, y0, x0 + i * colW, y0 + gh, 1, C.dim);
  for (let i = 0; i <= 4; i++) s += L(x0, y0 + i * rowH, x0 + gw, y0 + i * rowH, i === 0 && base === 1 ? 2.5 : 1, C.dim);
  if (base > 1) s += T(x0 - 6, y0 + rowH * 0.7, String(base), 9, C.dim, "end");
  shape.frets.forEach((f, i) => {
    const x = x0 + i * colW;
    if (f < 0) s += T(x, y0 - 4, "×", 9, C.dim);
    else if (f === 0) s += `<circle cx="${x}" cy="${y0 - 7}" r="3" fill="none" stroke="${C.dim}"/>`;
    else {
      const row = f - base;
      s += `<circle cx="${x}" cy="${y0 + (row + 0.5) * rowH}" r="4" fill="${C.fg}"/>`;
    }
  });
  if (shape.barre) {
    const row = shape.barre.fret - base;
    const xa = x0 + (shape.barre.from - 1) * colW, xb = x0 + (shape.barre.to - 1) * colW;
    const y = y0 + (row + 0.5) * rowH;
    s += `<rect x="${xa - 4}" y="${y - 4}" width="${xb - xa + 8}" height="8" rx="4" fill="${C.fg}" opacity="0.85"/>`;
  }
  return s;
}

// ---------------- 和弦测试卡（大图，供弹窗用）----------------
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(m) { return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

function drawChordDiagramBig(name, cx, top, C) {
  const shape = getChordShape(name);
  if (!shape) return T(cx, top + 40, "(未收录)", 14, C.dim, "middle");
  const gw = 96, gh = 116, x0 = cx - gw / 2, y0 = top + 10;
  const colW = gw / 5, rowH = gh / 4;
  const played = shape.frets.filter((f) => f > 0);
  const minF = played.length ? Math.min(...played) : 1;
  const maxF = played.length ? Math.max(...played) : 1;
  const base = maxF <= 4 ? 1 : minF;
  let s = "";
  for (let i = 0; i < 6; i++) s += L(x0 + i * colW, y0, x0 + i * colW, y0 + gh, 1.5, C.dim);
  for (let i = 0; i <= 4; i++) s += L(x0, y0 + i * rowH, x0 + gw, y0 + i * rowH, i === 0 && base === 1 ? 3 : 1.5, C.dim);
  if (base > 1) s += T(x0 - 10, y0 + rowH * 0.7, String(base), 12, C.dim, "end");
  shape.frets.forEach((f, i) => {
    const x = x0 + i * colW;
    if (f < 0) s += T(x, y0 - 6, "×", 13, C.dim);
    else if (f === 0) s += `<circle cx="${x}" cy="${y0 - 10}" r="5" fill="none" stroke="${C.dim}" stroke-width="1.5"/>`;
    else { const row = f - base; s += `<circle cx="${x}" cy="${y0 + (row + 0.5) * rowH}" r="7" fill="${C.accent}"/>`; }
  });
  if (shape.barre) {
    const row = shape.barre.fret - base;
    const xa = x0 + (shape.barre.from - 1) * colW, xb = x0 + (shape.barre.to - 1) * colW;
    const y = y0 + (row + 0.5) * rowH;
    s += `<rect x="${xa - 7}" y="${y - 7}" width="${xb - xa + 14}" height="14" rx="7" fill="${C.accent}" opacity="0.85"/>`;
  }
  return s;
}

export function renderChordCard(name) {
  const C = themeColors();
  const shape = getChordShape(name);
  const tones = chordMidiNotes(name);
  const W = 260, H = 290;
  let s = svgOpen(W, H, C.card);
  s += T(W / 2, 40, name || "—", 28, C.accent, "middle", "bold");
  if (!shape) {
    s += T(W / 2, 150, "（未收录该和弦指法）", 14, C.dim, "middle");
    s += T(W / 2, 178, "可试：C D E F G A B 及 m/7/m7/maj7/sus4 等", 11, C.dim, "middle");
    return s + "</svg>";
  }
  s += drawChordDiagramBig(name, W / 2, 56, C);
  if (tones.length) {
    s += T(W / 2, H - 24, "组成音：" + tones.map(midiToName).join("  "), 13, C.fg, "middle");
  }
  return s + "</svg>";
}
