// ============================================================
// ChordBridge 乐理核心（JS 版，与 src-tauri/theory/src/lib.rs 逻辑一致）
// 音高映射 / 调号（五度循环）/ 指板查找 / 简谱解析（beats 模型）
// ============================================================

// 大调调号 → 主音 pitch class + 升降号数量（正=升，负=降）
export const KEYS = {
  "C": { pc: 0, acc: 0 },  "G": { pc: 7, acc: 1 },  "D": { pc: 2, acc: 2 },
  "A": { pc: 9, acc: 3 },  "E": { pc: 4, acc: 4 },  "B": { pc: 11, acc: 5 },
  "F#": { pc: 6, acc: 6 }, "C#": { pc: 1, acc: 7 },
  "F": { pc: 5, acc: -1 }, "Bb": { pc: 10, acc: -2 }, "Eb": { pc: 3, acc: -3 },
  "Ab": { pc: 8, acc: -4 }, "Db": { pc: 1, acc: -5 }, "Gb": { pc: 6, acc: -6 },
};

// 小调 → 关系大调（简谱 1= 关系大调主音，调号相同）
export const MINOR_TO_RELATIVE = {
  "Am": "C", "Em": "G", "Bm": "D", "F#m": "A", "C#m": "E", "G#m": "B",
  "D#m": "F#", "A#m": "C#", "Dm": "F", "Gm": "Bb", "Cm": "Eb",
  "Fm": "Ab", "Bbm": "Db", "Ebm": "Gb",
};

export const KEY_LIST = [
  "C","G","D","A","E","B","F#","C#","F","Bb","Eb","Ab","Db","Gb",
  ...Object.keys(MINOR_TO_RELATIVE),
];

const DEGREE_SEMIS = [0, 2, 4, 5, 7, 9, 11]; // 1..7 → 半音
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function resolveKey(keyName) {
  const major = MINOR_TO_RELATIVE[keyName] || keyName;
  const info = KEYS[major];
  if (!info) return null;
  return { name: keyName, major, ...info, isMinor: !!MINOR_TO_RELATIVE[keyName] };
}

// ------------------------------------------------------------
// 简谱解析（beats 模型）
// 语法：
//   · 空白分隔的每个 token = 一拍
//   · 0          → 休止一拍
//   · 3          → 单音 3（占一拍）
//   · 3+4        → 一拍内依次演奏 3 和 4（时值均分；3 个音即为三连音）
//   · #3 或 3#   → 升 3（半音）
//   · b3 或 3b   → 降 3（半音）
//   · 3!         → 3 升八度（可叠加，如 3!!）
//   · 3?         → 3 降八度（可叠加，如 3??）
//   · 3- 或 -    → 3 延音一拍（增时线，可叠加 3-- = 延两拍）
//   · 3.         → 附点（时长 ×1.5，可叠加 3.. = ×1.75）
// 返回 { tokens, beats, errors }
//   beats[i] = { notes: [{degree,acc,octShift}], isRest, isTie, dots, tokenIndex, raw }
// ------------------------------------------------------------
export function parseJianpu(text) {
  const rawTokens = text.trim().split(/\s+/).filter(Boolean);
  const beats = [];
  const errors = [];
  // 单个音/休止子串：可选 #/b + 数字0-7 + 可选 #/b + 任意 !/?（八度，!升?降可叠加）
  const subRe = /^([#b]?)([0-7])([#b]?)([!?]*)$/;

  rawTokens.forEach((tok, ti) => {
    // 展开 token 尾部的 - 为独立延音拍（仅当 token 不含 +）；3- → [3, -]
    let parts;
    if (!tok.includes("+")) {
      if (/^-+$/.test(tok)) {
        parts = tok.split("");  // 全是 -，每个一个延音拍
      } else {
        const tm = /^([^+-]+?)(-+)$/.exec(tok);
        parts = tm ? [tm[1], ...tm[2].split("")] : [tok];
      }
    } else {
      parts = [tok];
    }
    for (const part of parts) {
      if (part === "-") {
        beats.push({ notes: [], isRest: false, isTie: true, dots: 0, tokenIndex: ti, raw: tok });
        continue;
      }
      // 剥离尾部附点（记在拍上，作用于整拍时值）
      let dots = 0;
      let body = part;
      const dm = /^(.*?)\.+$/.exec(part);
      if (dm) { dots = part.length - dm[1].length; body = dm[1]; }
      const subs = body.split("+").filter((s) => s.length);
      if (!subs.length) { errors.push({ index: ti, token: tok, reason: "空记号" }); return; }
      const notes = [];
      let isRest = false;
      let bad = null;
      for (const sub of subs) {
        const m = subRe.exec(sub);
        if (!m) {
          bad = { sub, reason: /[89]/.test(sub) ? "简谱只允许 0-7" : "非法记号（半音 #/b，八度 !/?，延音 -，附点 .）" };
          break;
        }
        const deg = +m[2];
        const accChr = m[1] || m[3];
        if (m[1] && m[3] && m[1] !== m[3]) { bad = { sub, reason: "升降号冲突" }; break; }
        const acc = accChr === "#" ? 1 : accChr === "b" ? -1 : 0;
        if (deg === 0) {
          if (accChr || m[4]) { bad = { sub, reason: "休止符 0 不能带任何符号" }; break; }
          if (subs.length > 1) { bad = { sub, reason: "休止符 0 不能与 + 连用" }; break; }
          isRest = true;
        } else {
          let octShift = 0;
          for (const c of m[4]) octShift += c === "!" ? 1 : -1;
          notes.push({ degree: deg, acc, octShift });
        }
      }
      if (bad) { errors.push({ index: ti, token: tok, reason: `${bad.reason}：「${bad.sub}」` }); return; }
      beats.push({ notes: isRest ? [] : notes, isRest, isTie: false, dots, tokenIndex: ti, raw: tok });
    }
  });
  return { tokens: rawTokens, beats, errors };
}

// 拍的实际时长（以一拍为单位，附点 ×1.5 / ×1.75）
export function beatDuration(beat) {
  let d = 1;
  for (let i = 0; i < (beat.dots || 0); i++) d += Math.pow(0.5, i + 1);
  return d;
}

// 统计非休止的音符总数（用于显示）
export function noteCountOf(beats) {
  let n = 0;
  for (const b of beats) if (!b.isRest && !b.isTie) n += b.notes.length;
  return n;
}

// ------------------------------------------------------------
// 简谱音符 → MIDI 音高 + 五线谱拼写（letter/accidental/octave）
// 调性主音落在最接近中央 C 的八度；octave 为全局八度偏移 -1..3
// showAcc：相对调号还需画的变音记号（0 = 调号已覆盖，无需画）
// ------------------------------------------------------------
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"]; // 升号出现顺序
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];  // 降号出现顺序

// 调号：每个字母的默认升降（如 G 大调 F 为 +1）
export function keySignature(key) {
  const sig = {};
  LETTERS.forEach((l) => (sig[l] = 0));
  if (key.acc > 0) for (let i = 0; i < key.acc; i++) sig[SHARP_ORDER[i]] = 1;
  else if (key.acc < 0) for (let i = 0; i < -key.acc; i++) sig[FLAT_ORDER[i]] = -1;
  return sig;
}

export function noteToPitch(note, key, globalOctave = 0) {
  const tonicMidi = 60 + ((key.pc + 6) % 12) - 6; // 主音贴近 C4（54..65）
  const midi = tonicMidi + DEGREE_SEMIS[note.degree - 1] + note.acc +
    12 * (globalOctave + note.octShift);

  const tonicLetter = key.major[0];
  const li = (LETTERS.indexOf(tonicLetter) + note.degree - 1) % 7;
  const letter = LETTERS[li];
  let spellAcc = ((midi % 12) - LETTER_PC[letter] + 12) % 12;
  if (spellAcc > 6) spellAcc -= 12;
  const octaveSci = Math.floor((midi - spellAcc) / 12) - 1;
  // 调号感知：拼写与调号一致时无需记号；差值才是要画的变音记号
  const sig = keySignature(key);
  const showAcc = spellAcc - sig[letter];
  return { midi, letter, spellAcc, octaveSci, showAcc };
}

// ------------------------------------------------------------
// 指板查找：标准调弦 EADGBE，弦序从高到低 e B G D A E（索引0=第1弦）
// position: "low"（0-4品优先）| "high"（5品以上优先）
// ------------------------------------------------------------
export const STRING_MIDI = [64, 59, 55, 50, 45, 40]; // e4 B3 G3 D3 A2 E2
const MAX_FRET = 17;

export function findFret(midi, position = "low") {
  let m = midi, transposed = 0;
  while (m < 40) { m += 12; transposed++; }        // 低于 E2：升八度兜底
  while (m > STRING_MIDI[0] + MAX_FRET) { m -= 12; transposed--; }
  const candidates = [];
  STRING_MIDI.forEach((open, si) => {
    const fret = m - open;
    if (fret >= 0 && fret <= MAX_FRET) candidates.push({ string: si + 1, fret });
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    position === "high"
      ? (a.fret < 5 ? 100 + a.fret : Math.abs(a.fret - 7)) - (b.fret < 5 ? 100 + b.fret : Math.abs(b.fret - 7))
      : a.fret - b.fret || a.string - b.string
  );
  return { ...candidates[0], transposed };
}

// ------------------------------------------------------------
// 和弦标记解析：[位置:和弦] 位置为 1-based 拍号（beat 序号）
// ------------------------------------------------------------
export function parseChordMarks(text, beatCount) {
  const marks = [];
  const errors = [];
  if (!text.trim()) return { marks, errors };
  const quality = "maj9|maj7|m7\\(b5\\)|m7b5|m6|m9|m11|m7|m|maj|sus4|sus2|dim7|dim|aug|add9|add11|6/9|6|9|11|13|7b9|7#9|7b5|7#5|7sus4|7|5";
  const re = new RegExp("\\[\\s*(\\d+)\\s*:\\s*([A-G][#b]?(?:" + quality + ")?(?:/[A-G][#b]?)?)\\s*\\]", "g");
  let m, matchedLen = 0;
  while ((m = re.exec(text))) {
    matchedLen += m[0].length;
    const pos = +m[1];
    if (pos < 1 || pos > beatCount) {
      errors.push({ token: m[0], reason: `位置 ${pos} 超出拍数（共 ${beatCount} 拍）` });
    } else {
      marks.push({ pos, name: m[2] });
    }
  }
  const stripped = text.replace(/\s/g, "").length;
  if (matchedLen === 0 && stripped > 0) {
    errors.push({ token: text.trim(), reason: "格式应为 [拍号:和弦名]，如 [3:C]" });
  }
  marks.sort((a, b) => a.pos - b.pos);
  return { marks, errors };
}

// 简谱八度点数（相对全局八度）：>0 上加点，<0 下加点
export function jianpuDots(note) {
  return note.octShift;
}

// 节拍解析 "4/4" → {num, den}
export function parseMeter(s) {
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const num = +m[1], den = +m[2];
  if (num < 1 || num > 16 || ![2, 4, 8, 16].includes(den)) return null;
  return { num, den };
}
