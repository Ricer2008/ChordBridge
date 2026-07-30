// ============================================================
// MIDI 导入与解析：Standard MIDI File (SMF) → 本应用 beats 模型
// 解析器零依赖，支持 MThd/MTrk、VLQ、Running Status、常见 Meta 事件。
// 转换：音符事件按「四分音符栅格」量化成 beats[]，长音用 tie 延续，
// 音高按所选调号映射为 {degree, acc, octShift}（保证还原回原 MIDI 音高）。
// ============================================================
import { resolveKey } from "./theory.js";

const DEGREE_SEMIS = [0, 2, 4, 5, 7, 9, 11]; // 1..7 → 半音

// ---------------- 1. SMF 解析 ----------------
function readStr(dv, start, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(start + i));
  return s;
}

export function parseMidi(buf) {
  const dv = new DataView(buf);
  let p = 0;
  const u8 = () => dv.getUint8(p++);
  const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const tag = () => String.fromCharCode(u8(), u8(), u8(), u8());
  const readVlq = () => {
    let v = 0;
    while (true) {
      const b = u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };

  if (tag() !== "MThd") throw new Error("文件头不是 MThd，可能不是标准 MIDI 文件");
  const hdrLen = u32();
  const format = u16();
  const ntracks = u16();
  const division = u16();
  p += Math.max(0, hdrLen - 6); // 跳过额外头字节

  const ppq = (division & 0x8000) ? 480 : division; // SMPTE 时 fallback 480
  const tracks = [];

  for (let ti = 0; ti < ntracks; ti++) {
    if (p + 8 > dv.byteLength || tag() !== "MTrk") break;
    const len = u32();
    const end = p + len;
    const notes = [];
    const tempo = [];
    let timeSig = null, keySig = null, name = "", abs = 0, running = 0;
    const onStack = {}; // `${ch}:${note}` → {tick, vel, ch, note}

    while (p < end) {
      abs += readVlq();
      let status = u8();
      if (status & 0x80) running = status;
      else { p--; status = running; } // running status
      const type = status & 0xf0;
      const ch = status & 0x0f;

      if (status === 0xff) {
        const mtype = u8();
        const mlen = readVlq();
        const mstart = p;
        if (mtype === 0x03) name = readStr(dv, mstart, mlen);
        else if (mtype === 0x51) {
          const us = (dv.getUint8(mstart) << 16) | (dv.getUint8(mstart + 1) << 8) | dv.getUint8(mstart + 2);
          tempo.push({ tick: abs, bpm: Math.round(60000000 / us) });
        } else if (mtype === 0x58) {
          timeSig = { num: dv.getUint8(mstart), den: Math.pow(2, dv.getUint8(mstart + 1)) };
        } else if (mtype === 0x59) {
          keySig = { sf: dv.getInt8(mstart), mi: dv.getUint8(mstart + 1) };
        }
        p = mstart + mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        p += readVlq();
      } else {
        const d1 = u8();
        if (type === 0xc0 || type === 0xd0) {
          // 1 data byte
        } else {
          const d2 = u8();
          if (type === 0x90 && d2 > 0) {
            onStack[ch + ":" + d1] = { tick: abs, vel: d2, ch, note: d1 };
          } else if (type === 0x90 || type === 0x80) {
            const k = ch + ":" + d1;
            const o = onStack[k];
            if (o) {
              delete onStack[k];
              notes.push({ midi: o.note, startTick: o.tick, durTick: Math.max(1, abs - o.tick), vel: o.vel, ch: o.ch });
            }
          }
        }
      }
    }
    // 收尾：未配对的 note-on 在轨道末尾结束
    Object.values(onStack).forEach((o) =>
      notes.push({ midi: o.note, startTick: o.tick, durTick: Math.max(1, end - o.tick), vel: o.vel, ch: o.ch }));
    notes.sort((a, b) => a.startTick - b.startTick);
    tracks.push({ name: name.trim(), channel: undefined, notes, tempo, timeSig, keySig });
  }

  // 汇总：速度（取首个 tempo）、拍号、调号
  const allTempo = [];
  tracks.forEach((t) => t.tempo.forEach((x) => allTempo.push(x)));
  allTempo.sort((a, b) => a.tick - b.tick);
  const bpm = allTempo.length ? allTempo[0].bpm : 120;
  let ts = null, ks = null;
  for (const t of tracks) { if (t.timeSig && !ts) ts = t.timeSig; if (t.keySig && !ks) ks = t.keySig; }

  return { format, ntracks, division, ppq, bpm, timeSig: ts, keySig: ks, tracks };
}

// ---------------- 2. 音高 → 简谱 degree/acc/octShift ----------------
// 选取使 noteToPitch(note, key, 0) 还原为原始 midi 的表示。
function midiToDegree(midi, key) {
  const tonicMidi = 60 + ((key.pc + 6) % 12) - 6;
  const interval = midi - tonicMidi;
  const rel = ((interval % 12) + 12) % 12;
  let best = null;
  for (let deg = 1; deg <= 7; deg++) {
    const base = DEGREE_SEMIS[deg - 1];
    for (const acc of [0, 1, -1]) {
      if ((((base + acc) % 12) + 12) % 12 === rel) {
        const octShift = Math.round((interval - (base + acc)) / 12);
        // 优先无升降；其次优先与调号同符号的拼写
        let score = acc === 0 ? 0 : 1;
        if (acc !== 0 && Math.sign(acc) !== Math.sign(key.acc)) score += 0.5;
        if (!best || score < best.score) best = { degree: deg, acc, octShift, score };
      }
    }
  }
  return best || { degree: 1, acc: 0, octShift: Math.round(interval / 12) };
}

// 音符事件 → beats[]（四分音符栅格；长音用 tie 延续）
function notesToBeats(notes, ppq, key) {
  const evs = notes.map((n) => ({
    midi: n.midi,
    sB: Math.round(n.startTick / ppq),
    eB: Math.round((n.startTick + n.durTick) / ppq),
  }));
  evs.forEach((e) => { if (e.eB <= e.sB) e.eB = e.sB + 1; });
  const total = evs.reduce((m, e) => Math.max(m, e.eB), 0);
  const slots = Array.from({ length: total }, () => ({ notes: [], tie: false }));
  evs.forEach((e) => {
    slots[e.sB].notes.push(midiToDegree(e.midi, key));
    for (let b = e.sB + 1; b < e.eB; b++) {
      if (slots[b].notes.length === 0) slots[b].tie = true; // 冲突（同拍另有新音）时放弃 tie，属可接受近似
    }
  });
  return slots.map((s) => {
    if (s.notes.length) return { notes: s.notes, isRest: false, isTie: false };
    if (s.tie) return { notes: [], isRest: false, isTie: true };
    return { notes: [], isRest: true, isTie: false };
  });
}

// ---------------- 3. 组装本应用 score ----------------
// opts: { key, trackFilter?, sourceName? }
export function midiToScore(parsed, opts) {
  const key = resolveKey(opts.key) || resolveKey("C");
  const ppq = parsed.ppq || 480;
  const meter = parsed.timeSig && parsed.timeSig.num
    ? { num: parsed.timeSig.num, den: parsed.timeSig.den }
    : { num: 4, den: 4 };
  const bpm = parsed.bpm || 120;
  const trks = (opts.trackFilter && opts.trackFilter.length ? opts.trackFilter : parsed.tracks)
    .filter((t) => t.notes.length);
  const tracks = trks.map((t, idx) => ({
    name: t.name || `MIDI 音轨 ${idx + 1}`,
    enabled: true,
    beats: notesToBeats(t.notes, ppq, key),
    octave: 0,
    chordMap: {},
    fromMidi: true,
  }));
  return {
    tracks, key, meter, bpm, position: "low", multi: tracks.length > 1,
    imported: true, ppq, sourceName: opts.sourceName || "",
  };
}

// 由 MIDI 调号(若含)推断候选主音名：sf 为升号数（负=降号），mi=1 小调
export function suggestKeyName(parsed) {
  if (!parsed.keySig) return "C";
  const sf = parsed.keySig.sf, mi = parsed.keySig.mi;
  const majorBySf = ["C", "C#", "D", "E", "F#", "G#", "A#", "C", "F", "Bb", "Eb", "Ab", "Db", "Gb"];
  const idx = ((sf % 12) + 12) % 12;
  const major = majorBySf[idx] || "C";
  if (mi) {
    // 关系大调 → 小调
    const relMinor = { C: "Am", "C#": "A#m", D: "Bm", E: "C#m", "F#": "D#m", "G#": "E#m",
      F: "Dm", "Bb": "Gm", Eb: "Cm", Ab: "Fm", Db: "Bbm", Gb: "Ebm" };
    return relMinor[major] || "Am";
  }
  return major;
}
