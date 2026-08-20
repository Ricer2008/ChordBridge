// ============================================================
// 和弦指法库（CAGED 基础形状 + 常用扩展）
// frets: 6条弦从低音E到高音e；-1=不弹, 0=空弦, n=品位
// fingers 可省略；barre: {fret, from, to}（弦序同上，1-based）
// ============================================================

const OPEN_SHAPES = {
  "C":     { frets: [-1, 3, 2, 0, 1, 0] },
  "Cmaj7": { frets: [-1, 3, 2, 0, 0, 0] },
  "C7":    { frets: [-1, 3, 2, 3, 1, 0] },
  "C9":    { frets: [-1, 3, 2, 3, 3, 3], barre: { fret: 3, from: 2, to: 6 } },
  "Cadd9": { frets: [-1, 3, 2, 0, 3, 0] },
  "D":     { frets: [-1, -1, 0, 2, 3, 2] },
  "Dm":    { frets: [-1, -1, 0, 2, 3, 1] },
  "D7":    { frets: [-1, -1, 0, 2, 1, 2] },
  "Dm7":   { frets: [-1, -1, 0, 2, 1, 1] },
  "Dmaj7": { frets: [-1, -1, 0, 2, 2, 2] },
  "Dm9":   { frets: [-1, -1, 0, 1, 1, 0] },
  "Ddim7": { frets: [-1, -1, 0, 1, 0, 1] },
  "E":     { frets: [0, 2, 2, 1, 0, 0] },
  "Em":    { frets: [0, 2, 2, 0, 0, 0] },
  "E7":    { frets: [0, 2, 0, 1, 0, 0] },
  "Em7":   { frets: [0, 2, 0, 0, 0, 0] },
  "Em9":   { frets: [0, 2, 0, 0, 0, 2] },
  "F":     { frets: [1, 3, 3, 2, 1, 1], barre: { fret: 1, from: 1, to: 6 } },
  "Fmaj7": { frets: [-1, -1, 3, 2, 1, 0] },
  "Fmaj9": { frets: [-1, -1, 3, 2, 1, 3], barre: { fret: 1, from: 4, to: 6 } },
  "G":     { frets: [3, 2, 0, 0, 0, 3] },
  "G7":    { frets: [3, 2, 0, 0, 0, 1] },
  "Gmaj7": { frets: [3, 2, 0, 0, 0, 2] },
  "A":     { frets: [-1, 0, 2, 2, 2, 0] },
  "Am":    { frets: [-1, 0, 2, 2, 1, 0] },
  "A7":    { frets: [-1, 0, 2, 0, 2, 0] },
  "Am7":   { frets: [-1, 0, 2, 0, 1, 0] },
  "Amaj7": { frets: [-1, 0, 2, 1, 2, 0] },
  "Am9":   { frets: [-1, 0, 2, 0, 1, 3] },
  "Asus2": { frets: [-1, 0, 2, 2, 0, 0] },
  "Asus4": { frets: [-1, 0, 2, 2, 3, 0] },
  "A6":    { frets: [-1, 0, 2, 2, 2, 2] },
  "B7":    { frets: [-1, 2, 1, 2, 0, 2] },
  "Bm":    { frets: [-1, 2, 4, 4, 3, 2], barre: { fret: 2, from: 2, to: 6 } },
  "B":     { frets: [-1, 2, 4, 4, 4, 2], barre: { fret: 2, from: 2, to: 6 } },
  "Bm7":   { frets: [-1, 2, 0, 2, 0, 2] },
  "Bm7b5": { frets: [-1, 2, 3, 2, 3, 2] },
  "Dsus4": { frets: [-1, -1, 0, 2, 3, 3] },
  "Esus4": { frets: [0, 2, 2, 2, 0, 0] },
};

// E 型 / A 型大横按模板（根音品位可移动）
const NOTE_PC = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };

function barreShape(rootPc, quality) {
  // E 型：根音在6弦。E=pc4
  const eFret = (rootPc - 4 + 12) % 12 || 12;
  const eTemplates = {
    "": [0, 2, 2, 1, 0, 0], "m": [0, 2, 2, 0, 0, 0],
    "7": [0, 2, 0, 1, 0, 0], "m7": [0, 2, 0, 0, 0, 0],
    "maj7": [0, 2, 1, 1, 0, 0], "m7b5": [0, 1, 0, 0, 0, 0],
    "dim": [0, 1, 2, 0, 0, 0], "dim7": [0, 1, 0, 0, 0, 0],
    "sus4": [0, 2, 2, 2, 0, 0], "7sus4": [0, 2, 0, 2, 0, 0],
    "6": [0, 2, 2, 1, 2, 0], "m6": [0, 2, 1, 0, 2, 0],
    "9": [0, 2, 0, 1, 0, 2], "m9": [0, 2, 0, 0, 0, 2],
    "7b9": [0, 2, 0, 1, 0, 1], "7#9": [0, 2, 0, 1, 0, 3],
    "aug": [0, 3, 2, 1, 1, 0], "7#5": [0, 3, 0, 1, 1, 0],
    "7b5": [0, 2, 0, 1, 0, -1], "add9": [0, 2, 2, 1, 0, 2],
  };
  // A 型：根音在5弦。A=pc9
  const aFret = (rootPc - 9 + 12) % 12 || 12;
  const aTemplates = {
    "": [-1, 0, 2, 2, 2, 0], "m": [-1, 0, 2, 2, 1, 0],
    "7": [-1, 0, 2, 0, 2, 0], "m7": [-1, 0, 2, 0, 1, 0],
    "maj7": [-1, 0, 2, 1, 2, 0], "m7b5": [-1, 0, 1, 0, 1, 0],
    "dim": [-1, 0, 1, 2, 1, 0], "dim7": [-1, 0, 1, 0, 1, 0],
    "sus4": [-1, 0, 2, 2, 3, 0], "7sus4": [-1, 0, 2, 0, 3, 0],
    "6": [-1, 0, 2, 2, 2, 2], "m6": [-1, 0, 2, 1, 2, 2],
    "9": [-1, 0, 2, 0, 2, 3], "m9": [-1, 0, 2, 0, 1, 3],
    "7b9": [-1, 0, 2, 0, 2, 1], "7#9": [-1, 0, 2, 0, 2, 3],
    "aug": [-1, 0, 3, 2, 2, 0], "7#5": [-1, 0, 3, 0, 2, 0],
    "7b5": [-1, 0, 2, 0, 2, -1], "add9": [-1, 0, 2, 2, 2, 2],
  };
  const pick = (base, tpl, from) => ({
    frets: tpl.map((f) => (f < 0 ? -1 : f + base)),
    barre: { fret: base, from, to: 6 },
  });
  if (!(quality in eTemplates)) return null;
  // 选品位更低的形状
  if (eFret <= aFret) return pick(eFret, eTemplates[quality], 1);
  return pick(aFret, aTemplates[quality], 2);
}

// 和弦名解析：返回 { root, quality, bass }（bass 非 null 时为 slash 转位）
const QUALITY_RE = "maj9|maj7|m7b5|m7\\(b5\\)|m6|m9|m11|m7|m|maj|sus4|sus2|dim7|dim|aug|add9|add11|6/9|6|9|11|13|7b9|7#9|7b5|7#5|7sus4|7|5";
const NAME_RE = new RegExp("^([A-G][#b]?)(" + QUALITY_RE + ")?(?:/([A-G][#b]?))?$");

export function parseChordName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const pc = NOTE_PC[m[1]];
  if (pc === undefined) return null;
  return { root: pc, quality: m[2] || "", bass: m[3] ? NOTE_PC[m[3]] : null };
}

// 查询和弦指法；未知和弦返回 null（渲染层做降级处理）
export function getChordShape(name) {
  if (OPEN_SHAPES[name]) return { name, ...OPEN_SHAPES[name] };
  const p = parseChordName(name);
  if (!p) return null;
  const s = barreShape(p.root, p.quality);
  if (s) return { name, ...s };
  return null; // 优雅降级：渲染层只显示和弦名
}

// 和弦名 → 组成音 MIDI（用于伴奏），根音取 C3 附近
export function chordMidiNotes(name) {
  const p = parseChordName(name);
  if (!p) return [];
  const INT = {
    "": [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
    maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus2: [0, 2, 7],
    dim: [0, 3, 6], dim7: [0, 3, 6, 9], aug: [0, 4, 8],
    add9: [0, 4, 7, 14], add11: [0, 4, 7, 17], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
    "6/9": [0, 4, 7, 9, 14], 9: [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14],
    maj9: [0, 4, 7, 11, 14], 11: [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17],
    13: [0, 4, 7, 10, 14, 21], m7b5: [0, 3, 6, 10], "m7(b5)": [0, 3, 6, 10],
    "7b9": [0, 4, 7, 10, 13], "7#9": [0, 4, 7, 10, 15],
    "7b5": [0, 4, 6, 10], "7#5": [0, 4, 8, 10],
    "7sus4": [0, 5, 7, 10], 5: [0, 7],
  };
  const ints = INT[p.quality];
  if (!ints) return [];
  let root = 48 + p.root; // C3 起
  let notes = ints.map((i) => root + i);
  // slash 转位：把低音声部换为指定音
  if (p.bass !== null) {
    let bass = 36 + p.bass; // C2 起
    while (bass > notes[0] - 1) bass -= 12;
    notes = [bass, ...notes.filter((n) => n > bass)];
  }
  return notes;
}
