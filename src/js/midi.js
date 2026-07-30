// ============================================================
// MIDI 模块：Web Audio 合成预览（拨弦音色）+ 标准 MIDI 文件导出
// 支持：beats 模型（休止/同拍多音均分时值）、多音轨同时播放、播放高亮回调
// ============================================================
import { noteToPitch } from "./theory.js";
import { chordMidiNotes } from "./chords.js";

let ctx = null, master = null;
let scheduled = [];
let state = "stopped";        // stopped | playing | paused
let pauseAt = 0, startAt = 0, totalDur = 0, onEndCb = null, endTimer = null;
let onTickCb = null, rafId = null, lastBeat = -1, curSpb = 0.5;
let currentEvents = [];

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function setVolume(v) { ensureCtx(); master.gain.value = v; }

// 简易吉他拨弦：三角波 + 快衰减包络 + 低通
function pluck(midi, t, dur, vel = 0.9) {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = f;
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(f * 6, t);
  lp.frequency.exponentialRampToValueAtTime(f * 1.5, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel * 0.28, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(dur * 1.1, 0.25));
  osc.connect(lp).connect(g).connect(master);
  osc.start(t);
  osc.stop(t + Math.max(dur * 1.2, 0.3));
  scheduled.push(osc);
}

// score → 事件列表 [{midi, start(beat), dur(beat), vel, track, beat}]
// 同拍多音均分该拍时值；休止不发声；多音轨合并
export function buildEvents(score, withAccomp) {
  const { tracks, key, meter } = score;
  const ev = [];
  tracks.forEach((tr, tk) => {
    if (!tr.enabled) return;
    let lastEvs = [];
    tr.beats.forEach((beat, bi) => {
      if (beat.isTie) { lastEvs.forEach((e) => (e.dur += 1)); return; }
      if (beat.isRest) { lastEvs = []; return; }
      lastEvs = [];
      const n = beat.notes.length || 1;
      beat.notes.forEach((note, ni) => {
        const p = noteToPitch(note, key, tr.octave);
        const e = { midi: p.midi, start: bi + ni / n, dur: 1 / n, vel: 0.9, track: tk, beat: bi };
        ev.push(e);
        lastEvs.push(e);
      });
    });
    if (withAccomp) {
      const marks = Object.entries(tr.chordMap)
        .map(([pos, name]) => ({ pos: +pos - 1, name })).sort((a, b) => a.pos - b.pos);
      const beatCount = tr.beats.length;
      marks.forEach((mk, mi) => {
        const end = mi + 1 < marks.length ? marks[mi + 1].pos : beatCount;
        const tones = chordMidiNotes(mk.name);
        if (!tones.length) return;
        for (let b = mk.pos; b < end; b += meter.num) {
          tones.forEach((m, ti) => {
            ev.push({ midi: m - 12 * (ti === 0 ? 1 : 0), start: b + ti * 0.5,
              dur: Math.min(meter.num, end - b), vel: 0.4, track: tk, beat: b });
          });
        }
      });
    }
  });
  return ev;
}

function rafLoop() {
  if (state !== "playing") return;
  const beat = (ctx.currentTime - startAt) / curSpb;
  const bi = Math.floor(beat);
  if (bi !== lastBeat) { lastBeat = bi; onTickCb && onTickCb(bi); }
  rafId = requestAnimationFrame(rafLoop);
}
function stopRaf() { if (rafId) cancelAnimationFrame(rafId); rafId = null; lastBeat = -1; }

export function play(score, withAccomp, onEnd, onTick) {
  stop();
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  currentEvents = buildEvents(score, withAccomp);
  if (!currentEvents.length) { onEnd && onEnd(); return; }
  curSpb = 60 / score.bpm;
  const t0 = ctx.currentTime + 0.08;
  currentEvents.forEach((e) => pluck(e.midi, t0 + e.start * curSpb, e.dur * curSpb, e.vel));
  totalDur = (Math.max(...currentEvents.map((e) => e.start + e.dur), 1) + 0.5) * curSpb;
  startAt = t0;
  state = "playing";
  onEndCb = onEnd;
  onTickCb = onTick;
  rafLoop();
  endTimer = setTimeout(() => { stopRaf(); state = "stopped"; onEndCb && onEndCb(); },
    (totalDur + 0.2) * 1000);
}

export function pause() {
  if (state !== "playing") return;
  ctx.suspend();
  state = "paused";
  stopRaf();
  clearTimeout(endTimer);
}
export function resume() {
  if (state !== "paused") return;
  ctx.resume();
  state = "playing";
  rafLoop();
  const remain = totalDur - (ctx.currentTime - startAt);
  endTimer = setTimeout(() => { stopRaf(); state = "stopped"; onEndCb && onEndCb(); },
    Math.max(remain, 0) * 1000 + 200);
}
export function stop() {
  clearTimeout(endTimer);
  stopRaf();
  scheduled.forEach((n) => { try { n.stop(); } catch (_) {} });
  scheduled = [];
  if (ctx && ctx.state === "suspended") ctx.resume();
  state = "stopped";
}
export function getState() { return state; }

// 试听一组音（和弦）。arpeggio=true 琶音依次奏响，false 柱式同时奏响
export function playChordNotes(midiNotes, arpeggio = true) {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  const t0 = ctx.currentTime + 0.05;
  midiNotes.forEach((m, i) => pluck(m, t0 + (arpeggio ? i * 0.08 : 0), 1.4, 0.7));
}

// ---------------- SMF 导出（format 1：tempo 轨 + 每音轨一轨）----------------
function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
function trackChunk(events) { // events: [{tick, data}]
  const t = [];
  let last = 0;
  events.forEach((m) => { t.push(...vlq(m.tick - last), ...m.data); last = m.tick; });
  t.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b,
    (t.length >> 24) & 0xff, (t.length >> 16) & 0xff, (t.length >> 8) & 0xff, t.length & 0xff, ...t];
}

export function exportMidiFile(score, withAccomp) {
  const ev = buildEvents(score, withAccomp);
  const TPQ = 480;
  const enabled = score.tracks.map((t, i) => ({ tr: t, tk: i })).filter((x) => x.tr.enabled);

  // tempo 轨
  const uspq = Math.round(60000000 / score.bpm);
  const dd = Math.log2(score.meter.den);
  const tempoTrk = trackChunk([
    { tick: 0, data: [0xff, 0x51, 3, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff] },
    { tick: 0, data: [0xff, 0x58, 4, score.meter.num, dd, 24, 8] },
  ]);

  // 每个启用音轨一个 track
  const trks = [tempoTrk];
  enabled.forEach(({ tr, tk }) => {
    const my = ev.filter((e) => e.track === tk && e.vel >= 0.9); // 仅旋律，不含伴奏（伴奏可另算）
    const msgs = [];
    my.forEach((e) => {
      msgs.push({ tick: Math.round(e.start * TPQ), data: [0x90, e.midi, Math.round(e.vel * 100)] });
      msgs.push({ tick: Math.round((e.start + e.dur) * TPQ), data: [0x80, e.midi, 0] });
    });
    msgs.sort((a, b) => a.tick - b.tick);
    msgs.unshift({ tick: 0, data: [0xc0, 24] }); // nylon guitar
    trks.push(trackChunk(msgs));
  });

  const ntrks = trks.length;
  const hd = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (ntrks >> 8) & 0xff, ntrks & 0xff,
    (TPQ >> 8) & 0xff, TPQ & 0xff];
  return new Uint8Array([...hd, ...trks.flat()]);
}
