// ============================================================
// 和弦指法库（CAGED 基础形状 + 常用扩展）
// frets: 6条弦从低音E到高音e；-1=不弹, 0=空弦, n=品位
// fingers 可省略；barre: {fret, from, to}（弦序同上，1-based）
// ============================================================

const OPEN_SHAPES = {
  "C":    { frets: [-1, 3, 2, 0, 1, 0] },
  "Cmaj7":{ frets: [-1, 3, 2, 0, 0, 0] },
  "C7":   { frets: [-1, 3, 2, 3, 1, 0] },
  "D":    { frets: [-1, -1, 0, 2, 3, 2] },
  "Dm":   { frets: [-1, -1, 0, 2, 3, 1] },
  "D7":   { frets: [-1, -1, 0, 2, 1, 2] },
  "Dm7":  { frets: [-1, -1, 0, 2, 1, 1] },
  "E":    { frets: [0, 2, 2, 1, 0, 0] },
  "Em":   { frets: [0, 2, 2, 0, 0, 0] },
  "E7":   { frets: [0, 2, 0, 1, 0, 0] },
  "Em7":  { frets: [0, 2, 0, 0, 0, 0] },
  "F":    { frets: [1, 3, 3, 2, 1, 1], barre: { fret: 1, from: 1, to: 6 } },
  "Fmaj7":{ frets: [-1, -1, 3, 2, 1, 0] },
  "G":    { frets: [3, 2, 0, 0, 0, 3] },
  "G7":   { frets: [3, 2, 0, 0, 0, 1] },
  "A":    { frets: [-1, 0, 2, 2, 2, 0] },
  "Am":   { frets: [-1, 0, 2, 2, 1, 0] },
  "A7":   { frets: [-1, 0, 2, 0, 2, 0] },
  "Am7":  { frets: [-1, 0, 2, 0, 1, 0] },
  "Asus2":{ frets: [-1, 0, 2, 2, 0, 0] },
  "Asus4":{ frets: [-1, 0, 2, 2, 3, 0] },
  "B7":   { frets: [-1, 2, 1, 2, 0, 2] },
  "Bm":   { frets: [-1, 2, 4, 4, 3, 2], barre: { fret: 2, from: 2, to: 6 } },
  "B":    { frets: [-1, 2, 4, 4, 4, 2], barre: { fret: 2, from: 2, to: 6 } },
  "Dsus4":{ frets: [-1, -1, 0, 2, 3, 3] },
  "Esus4":{ frets: [0, 2, 2, 2, 0, 0] },
  "Gmaj7":{ frets: [3, 2, 0, 0, 0, 2] },
  "Amaj7":{ frets: [-1, 0, 2, 1, 2, 0] },
  "Dmaj7":{ frets: [-1, -1, 0, 2, 2, 2] },
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
  };
  // A 型：根音在5弦。A=pc9
  const aFret = (rootPc - 9 + 12) % 12 || 12;
  const aTemplates = {
    "": [-1, 0, 2, 2, 2, 0], "m": [-1, 0, 2, 2, 1, 0],
    "7": [-1, 0, 2, 0, 2, 0], "m7": [-1, 0, 2, 0, 1, 0],
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

// 查询和弦指法；未知和弦返回 null（渲染层做降级处理）
export function getChordShape(name) {
  if (OPEN_SHAPES[name]) return { name, ...OPEN_SHAPES[name] };
  const m = /^([A-G][#b]?)(maj7|m7|m|7|sus4|sus2|dim|aug|add9|6|9)?$/.exec(name);
  if (!m) return null;
  const pc = NOTE_PC[m[1]];
  if (pc === undefined) return null;
  const quality = m[2] || "";
  if (["", "m", "7", "m7"].includes(quality)) {
    const s = barreShape(pc, quality);
    if (s) return { name, ...s };
  }
  return null; // 优雅降级：渲染层只显示和弦名
}

// 和弦名 → 组成音 MIDI（用于伴奏），根音取 C3 附近
export function chordMidiNotes(name) {
  const m = /^([A-G][#b]?)(maj7|m7|m|7|sus4|sus2|dim|aug|add9|6|9)?$/.exec(name);
  if (!m) return [];
  const pc = NOTE_PC[m[1]];
  if (pc === undefined) return [];
  const q = m[2] || "";
  const INT = {
    "": [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
    maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus2: [0, 2, 7],
    dim: [0, 3, 6], aug: [0, 4, 8], add9: [0, 4, 7, 14], 6: [0, 4, 7, 9], 9: [0, 4, 7, 10, 14],
  }[q];
  const root = 48 + ((pc - 0 + 12) % 12); // C3 起
  return INT.map((i) => root + i);
}
