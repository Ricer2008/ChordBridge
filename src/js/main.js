// ============================================================
// ChordBridge 主控制器：多音轨管理 → 校验 → 四谱同步生成 → 播放高亮 → 导出
// ============================================================
import { KEY_LIST, resolveKey, parseJianpu, parseChordMarks, parseMeter } from "./theory.js";
import { renderJianpu, renderStaff, renderTab, renderChordCard } from "./render.js";
import * as midi from "./midi.js";
import { chordMidiNotes } from "./chords.js";
import { downloadBlob, svgBlob, svgToPng, makeZip, blobToU8 } from "./exporter.js";
import { parseMidi, midiToScore, suggestKeyName } from "./midi-import.js";

const THEMES = [
  ["brushed", "拉丝金属（默认）"], ["linen", "亚麻纸"],
  ["win98", "Win 经典（Windows 98）"], ["win10", "Windows 10"],
  ["kde", "KDE（Breeze）"], ["thinkpad", "ThinkPad · IBM（彩蛋）"],
];
const $ = (id) => document.getElementById(id);

let tracks = [];          // [{id,name,enabled,jianpu,octave,chords}]
let nextId = 1;
let currentScore = null;
let currentSvgs = {};     // {jianpu:[svg,...], staff:[...], tab:[...], chordtab:[...]}
let highlightBeat = -1;

// ---- 主题 ----
THEMES.forEach(([v, t]) => {
  const o = document.createElement("option");
  o.value = v; o.textContent = t; $("theme").appendChild(o);
});
$("theme").onchange = (e) => {
  document.documentElement.dataset.theme = e.target.value;
  if (currentScore) generate(); // 主题色变化 → 重新渲染
};

// ---- 调号 ----
KEY_LIST.forEach((k) => {
  const o = document.createElement("option");
  o.value = k;
  o.textContent = k.endsWith("m") ? `${k}（小调）` : `${k} 大调`;
  $("key").appendChild(o);
});

// ---- 弹窗 ----
function showModal(html) { $("modal-body").innerHTML = html; $("modal").classList.remove("hidden"); }
$("modal-close").onclick = () => $("modal").classList.add("hidden");
function highlightTokens(tokens, badIdx) {
  return tokens.map((t, i) => (badIdx.has(i) ? `<mark>${t}</mark>` : t)).join(" ");
}

// ---- 音轨管理 ----
function makeTrack(idx) {
  const defaults = [
    { jianpu: "1 2 3+4 0 5 6 7 1!", chords: "[1:C] [5:G7]" },
    { jianpu: "5 6 1' 0 3 2 1 0", chords: "[1:Am] [5:F]" },
    { jianpu: "3 0 4 0 5 0 6 0", chords: "" },
  ];
  const d = defaults[(idx - 1) % defaults.length];
  return { id: nextId++, name: `音轨 ${idx}`, enabled: true,
    jianpu: d.jianpu, octave: 0, chords: d.chords, beats: null, fromMidi: false };
}

function createTrackEl(track) {
  const el = document.createElement("div");
  el.className = "track" + (track.enabled ? "" : " disabled");
  el.dataset.id = track.id;
  el.innerHTML = `
    <div class="track-head">
      <input type="checkbox" class="tk-enabled" ${track.enabled ? "checked" : ""} title="启用此音轨">
      <input type="text" class="tk-name" value="${track.name}">
      <button class="tk-del" title="删除音轨">×</button>
    </div>
    <textarea class="tk-jianpu" rows="2" placeholder="${track.fromMidi ? "（来自 MIDI 导入，可直接改写为简谱）" : "1-7（#/b半音，!升八度 ?降八度）；0=空一拍；3+4=一拍两音"}">${track.jianpu}</textarea>
    <div class="grid2">
      <div><label class="hint">八度</label><select class="tk-octave">
        ${[-1,0,1,2,3].map(o=>`<option value="${o}" ${o===track.octave?"selected":""}>${o}${o===0?"（默认）":""}</option>`).join("")}
      </select></div>
      <div><label class="hint">和弦 [拍号:名]</label><input class="tk-chords" type="text" value="${track.chords}" placeholder="[1:C] [5:G7]"></div>
    </div>
    <div class="tk-err error hidden"></div>`;

  const en = el.querySelector(".tk-enabled");
  en.onchange = () => { track.enabled = en.checked; el.classList.toggle("disabled", !en.checked); };
  el.querySelector(".tk-name").oninput = (e) => (track.name = e.target.value || `音轨`);
  el.querySelector(".tk-jianpu").oninput = (e) => {
    track.jianpu = e.target.value;
    track.beats = null; track.fromMidi = false;   // 改写即退回简谱模式
    clearImportBanner();
  };
  el.querySelector(".tk-octave").onchange = (e) => (track.octave = +e.target.value);
  el.querySelector(".tk-chords").oninput = (e) => (track.chords = e.target.value);
  el.querySelector(".tk-del").onclick = () => {
    if (tracks.length <= 1) { showModal("至少保留一个音轨。"); return; }
    tracks = tracks.filter((t) => t.id !== track.id);
    renderTracksUI();
  };
  return el;
}

function renderTracksUI() {
  const list = $("tracks-list");
  list.innerHTML = "";
  const multi = $("multi-track").value === "on";
  const shown = multi ? tracks : tracks.slice(0, 1);
  shown.forEach((t) => list.appendChild(createTrackEl(t)));
  $("add-track").style.display = multi ? "" : "none";
  $("track-hint").textContent = multi ? `（共 ${tracks.length} 轨）` : "（单轨模式）";
}
$("add-track").onclick = () => { tracks.push(makeTrack(tracks.length + 1)); renderTracksUI(); };
$("multi-track").onchange = () => {
  if ($("multi-track").value === "on" && tracks.length < 2) tracks.push(makeTrack(2));
  renderTracksUI();
};

// ---- 采集 + 校验 ----
function collectScore() {
  const key = resolveKey($("key").value);
  if (!key) { showModal("调号无效。"); return null; }
  const meter = parseMeter($("meter").value);
  if (!meter) { showModal("节拍格式无效，应如 4/4。"); return null; }
  let bpm = parseInt($("bpm").value, 10);
  if (isNaN(bpm)) bpm = 120;
  if (bpm < 40 || bpm > 240) { bpm = Math.min(240, Math.max(40, bpm)); $("bpm").value = bpm; }

  const multi = $("multi-track").value === "on";
  const used = multi ? tracks : tracks.slice(0, 1);
  const outTracks = [];
  // 先清所有错误条
  document.querySelectorAll(".tk-err").forEach((e) => e.classList.add("hidden"));

  for (const tr of used) {
    const el = document.querySelector(`.track[data-id="${tr.id}"]`);
    const errBox = el ? el.querySelector(".tk-err") : null;
    let beats, tokens = [], errors = [];
    if (tr.beats && tr.beats.length) {
      beats = tr.beats;            // 已解析（如 MIDI 导入）直接复用
    } else {
      if (!tr.jianpu.trim()) {
        if (errBox) { errBox.textContent = `${tr.name}：简谱为空`; errBox.classList.remove("hidden"); }
        showModal(`<b>${tr.name}</b>：简谱输入为空。`);
        return null;
      }
      const r = parseJianpu(tr.jianpu);
      tokens = r.tokens; beats = r.beats; errors = r.errors;
    }
    if (errors.length) {
      const badIdx = new Set(errors.map((e) => e.index));
      const detail = errors.map((e) => `「${e.token}」：${e.reason}`).join("<br>");
      if (errBox) { errBox.innerHTML = highlightTokens(tokens, badIdx); errBox.classList.remove("hidden"); }
      showModal(`<b>${tr.name}</b> 简谱有误：<br>${detail}<br><br>${highlightTokens(tokens, badIdx)}`);
      return null;
    }
    const { marks, errors: cErr } = parseChordMarks(tr.chords, beats.length);
    if (cErr.length) {
      if (errBox) { errBox.innerHTML = cErr.map((e) => `<mark>${e.token}</mark> ${e.reason}`).join("<br>"); errBox.classList.remove("hidden"); }
      showModal(`<b>${tr.name}</b> 和弦标记有误：<br>` + cErr.map((e) => `「${e.token}」：${e.reason}`).join("<br>"));
      return null;
    }
    const chordMap = {};
    marks.forEach((m) => (chordMap[m.pos] = m.name));
    outTracks.push({ name: tr.name, enabled: tr.enabled, beats, octave: tr.octave, chordMap });
  }
  return {
    tracks: outTracks, key, meter, bpm,
    position: $("position").value, multi,
  };
}

// ---- 生成（四谱面同步，不可部分生成）----
function generate() {
  const score = collectScore();
  if (!score) return;
  currentScore = score;
  currentSvgs = { jianpu: [], staff: [], tab: [], chordtab: [] };
  const g = { key: score.key, meter: score.meter, bpm: score.bpm, position: score.position };
  let lb = parseInt($("line-beats").value, 10);
  if (isNaN(lb) || lb < 0) lb = 16;
  if (lb > 128) lb = 128;
  const perLine = lb === 0 ? 0 : lb;   // 0 = 不换行（单行）
  score.tracks.forEach((tr, tk) => {
    if (!tr.enabled) return;
    currentSvgs.jianpu.push(renderJianpu(tr, g, tk, perLine));
    currentSvgs.staff.push(renderStaff(tr, g, tk, perLine));
    currentSvgs.tab.push(renderTab(tr, g, tk, false, perLine));
    currentSvgs.chordtab.push(renderTab(tr, g, tk, true, perLine));
  });
  const fill = (type) => {
    const arr = currentSvgs[type];
    $("svg-" + type).innerHTML = arr.length ? arr.join("") : '<div class="placeholder">无启用的音轨</div>';
  };
  fill("jianpu"); fill("staff"); fill("tab"); fill("chordtab");
}
$("generate").onclick = generate;

// ---- 播放高亮 ----
function clearHighlight() {
  document.querySelectorAll(".cb-note.hl").forEach((e) => e.classList.remove("hl"));
  highlightBeat = -1;
}
function onTick(beat) {
  if (beat === highlightBeat) return;
  clearHighlight();
  highlightBeat = beat;
  document.querySelectorAll(`.cb-note[data-bt="${beat}"]`).forEach((e) => e.classList.add("hl"));
}

function setPlayerUI(st) {
  $("play").disabled = st === "playing";
  $("pausebtn").disabled = st !== "playing" && st !== "paused";
  $("stopbtn").disabled = st === "stopped";
  $("pausebtn").textContent = st === "paused" ? "⏵ 继续" : "⏸ 暂停";
}
$("play").onclick = () => {
  generate();
  if (!currentScore) return;
  clearHighlight();
  midi.play(currentScore, $("accomp").value === "on",
    () => { setPlayerUI("stopped"); clearHighlight(); }, onTick);
  setPlayerUI("playing");
};
$("pausebtn").onclick = () => {
  if (midi.getState() === "playing") { midi.pause(); setPlayerUI("paused"); }
  else if (midi.getState() === "paused") { midi.resume(); setPlayerUI("playing"); }
};
$("stopbtn").onclick = () => { midi.stop(); setPlayerUI("stopped"); clearHighlight(); };
$("volume").oninput = (e) => midi.setVolume(e.target.value / 100);

// ---- 多轨 SVG 合并（用于单谱导出）----
function combineSvgs(svgs) {
  if (svgs.length === 1) return svgs[0];
  let totalH = 0, maxW = 0;
  const items = svgs.map((s) => {
    const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(s);
    const w = m ? +m[1] : 400, h = m ? +m[2] : 150;
    totalH += h + 8; maxW = Math.max(maxW, w);
    return { s, h };
  });
  let y = 0, inner = "";
  items.forEach((it) => {
    inner += it.s.replace(/^<svg /, `<svg y="${y}" `);
    y += it.h + 8;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${totalH}" viewBox="0 0 ${maxW} ${totalH}">${inner}</svg>`;
}

// ---- 单谱导出 ----
const NAME_MAP = { jianpu: "简谱", staff: "五线谱", tab: "六线谱TAB", chordtab: "六线和弦谱" };
document.querySelectorAll(".mini").forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type, fmt = btn.dataset.fmt;
    if (!currentSvgs[type] || !currentSvgs[type].length) { showModal("请先点击「生成」。"); return; }
    const svg = combineSvgs(currentSvgs[type]);
    if (fmt === "svg") {
      downloadBlob(svgBlob(svg), `ChordBridge_${NAME_MAP[type]}.svg`);
    } else {
      try { downloadBlob(await svgToPng(svg), `ChordBridge_${NAME_MAP[type]}_300dpi.png`); }
      catch (err) { showModal("PNG 导出失败：" + err.message); }
    }
  };
});

// ---- ZIP 打包导出 ----
$("export-zip").onclick = async () => {
  if (!currentScore || !currentSvgs.jianpu.length) { showModal("请先点击「生成」。"); return; }
  const enc = new TextEncoder();
  const files = [];
  for (const [type, svgs] of Object.entries(currentSvgs)) {
    const svg = combineSvgs(svgs);
    files.push({ name: `${NAME_MAP[type]}.svg`, data: enc.encode(svg) });
    try { files.push({ name: `${NAME_MAP[type]}_300dpi.png`, data: await blobToU8(await svgToPng(svg)) }); }
    catch (_) {}
  }
  files.push({ name: "ChordBridge.mid", data: midi.exportMidiFile(currentScore, $("accomp").value === "on") });
  downloadBlob(makeZip(files), "ChordBridge_导出.zip");
};

// ---- 和弦测试台 ----
const QUICK_CHORDS = ["C","D","E","F","G","A","B","Am","Em","Dm","C7","G7","D7","A7","E7","B7",
  "Cmaj7","Fmaj7","Am7","Em7","Dm7","Bb","Eb","F#m","Bm","Dsus4","Asus4","Esus4","Gmaj7","Amaj7","Dmaj7"];
const chordQuick = $("chord-quick");
[...new Set(QUICK_CHORDS)].forEach((name) => {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => { $("chord-name").value = name; renderChord(); midi.playChordNotes(chordMidiNotes(name)); };
  chordQuick.appendChild(b);
});
function renderChord() {
  const name = $("chord-name").value.trim() || "C";
  $("chord-view").innerHTML = renderChordCard(name);
}
$("chord-lib").onclick = () => { $("chord-modal").classList.remove("hidden"); renderChord(); };
$("chord-close").onclick = () => $("chord-modal").classList.add("hidden");
$("chord-name").oninput = renderChord;
$("chord-play").onclick = () => {
  const name = $("chord-name").value.trim();
  if (!name) return;
  const tones = chordMidiNotes(name);
  if (!tones.length) { showModal(`未识别和弦「${name}」，可试 C / G7 / Am 等。`); return; }
  midi.playChordNotes(tones);
};

// ---- 文件保存 / 载入 ----
function collectState() {
  return {
    app: "ChordBridge", version: 1, savedAt: new Date().toISOString(),
    settings: {
      key: $("key").value, meter: $("meter").value, bpm: $("bpm").value,
      position: $("position").value, accomp: $("accomp").value,
      multi: $("multi-track").value, theme: $("theme").value,
      lineBeats: $("line-beats").value,
    },
    tracks: tracks.map((t) => ({ name: t.name, enabled: t.enabled, jianpu: t.jianpu, octave: t.octave, chords: t.chords, beats: t.beats || null, fromMidi: t.fromMidi || false })),
  };
}
$("save-file").onclick = () => {
  const blob = new Blob([JSON.stringify(collectState(), null, 2)], { type: "application/json" });
  downloadBlob(blob, `ChordBridge_${new Date().toISOString().slice(0, 10)}.json`);
};
$("load-file-btn").onclick = () => $("load-file").click();
$("load-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "ChordBridge") { showModal("不是有效的 ChordBridge 存档文件。"); return; }
    const s = data.settings || {};
    if (s.key) $("key").value = s.key;
    if (s.meter) $("meter").value = s.meter;
    if (s.bpm) $("bpm").value = s.bpm;
    if (s.position) $("position").value = s.position;
    if (s.accomp) $("accomp").value = s.accomp;
    if (s.multi) $("multi-track").value = s.multi;
    if (s.lineBeats !== undefined) $("line-beats").value = s.lineBeats;
    if (s.theme) { $("theme").value = s.theme; document.documentElement.dataset.theme = s.theme; }
    if (Array.isArray(data.tracks) && data.tracks.length) {
      tracks = data.tracks.map((t) => ({
        id: nextId++, name: t.name || "音轨", enabled: t.enabled !== false,
        jianpu: t.jianpu || "", octave: t.octave || 0, chords: t.chords || "",
        beats: t.beats || null, fromMidi: t.fromMidi || false,
      }));
      renderTracksUI();
      generate();
    }
    showModal("✅ 载入成功");
  } catch (err) { showModal("载入失败：" + err.message); }
  e.target.value = "";
};

// ---- 随机曲谱生成器 ----
const RKEY = $("r-key");
KEY_LIST.forEach((k) => {
  const o = document.createElement("option"); o.value = k; o.textContent = k; RKEY.appendChild(o);
});
$("random-btn").onclick = () => { $("random-modal").classList.remove("hidden"); };
$("r-close").onclick = () => $("random-modal").classList.add("hidden");
$("r-generate").onclick = () => {
  const opts = {
    count: Math.max(4, Math.min(64, +$("r-count").value || 16)),
    key: $("r-key").value || "C", meter: $("r-meter").value || "4/4",
    bpm: +$("r-bpm").value || 120,
    chord: $("r-chord").checked, rest: $("r-rest").checked, tie: $("r-tie").checked,
    oct: $("r-oct").checked, half: $("r-half").checked, multi: $("r-multi").checked,
  };
  const result = randomScore(opts);
  $("key").value = opts.key; $("meter").value = opts.meter; $("bpm").value = opts.bpm;
  if (!tracks.length) tracks.push(makeTrack(1));
  tracks[0].jianpu = result.jianpu;
  tracks[0].chords = result.chords;
  renderTracksUI();
  generate();
  $("random-modal").classList.add("hidden");
};

function randomScore(opts) {
  const scale = [1, 2, 3, 4, 5, 6, 7];
  const meterNum = parseInt(opts.meter, 10) || 4;
  const isMinor = opts.key.endsWith("m");
  const tokens = [];
  for (let i = 0; i < opts.count; i++) {
    if (opts.rest && Math.random() < 0.1) { tokens.push("0"); continue; }
    if (opts.tie && tokens.length) {
      const last = tokens[tokens.length - 1];
      if (last !== "0" && last !== "-" && Math.random() < 0.15) { tokens.push("-"); continue; }
    }
    let deg = scale[Math.floor(Math.random() * 7)];
    let pre = opts.half && Math.random() < 0.15 ? (Math.random() < 0.5 ? "#" : "b") : "";
    let oct = opts.oct && Math.random() < 0.2 ? (Math.random() < 0.5 ? "!" : "?") : "";
    let tok = `${pre}${deg}${oct}`;
    if (opts.multi && Math.random() < 0.12) tok += `+${scale[Math.floor(Math.random() * 7)]}`;
    tokens.push(tok);
  }
  let chords = "";
  if (opts.chord) {
    const prog = isMinor ? ["Am", "F", "G", "Em"] : ["C", "G", "Am", "F"];
    const marks = [];
    for (let b = 0; b < tokens.length; b += meterNum) {
      marks.push(`[${b + 1}:${prog[Math.floor(b / meterNum) % prog.length]}]`);
    }
    chords = marks.join(" ");
  }
  return { jianpu: tokens.join(" "), chords };
}

// ---- 关于 ----
$("about-btn").onclick = async () => {
  $("about-modal").classList.remove("hidden");
  try {
    const res = await fetch("about.txt");
    $("about-content").textContent = res.ok ? await res.text() : "（about.txt 读取失败）";
  } catch (e) { $("about-content").textContent = "（about.txt 读取失败：" + e.message + "）"; }
};
$("about-close").onclick = () => $("about-modal").classList.add("hidden");

// ---- MIDI 导入 ----
let pendingMidi = null;
const midiKeySel = $("midi-key");
KEY_LIST.forEach((k) => {
  const o = document.createElement("option");
  o.value = k;
  o.textContent = k.endsWith("m") ? `${k}（小调）` : `${k} 大调`;
  midiKeySel.appendChild(o);
});

function clearImportBanner() {
  $("import-banner").classList.add("hidden");
}

function showMidiModal(parsed, name) {
  pendingMidi = parsed;
  const noteTracks = parsed.tracks.filter((t) => t.notes.length);
  const meta = [
    `格式 <b>${parsed.format}</b>`,
    `音轨 <b>${parsed.ntracks}</b>`,
    `PPQ <b>${parsed.ppq}</b>`,
    `速度 <b>${parsed.bpm}</b> BPM`,
    parsed.timeSig ? `拍号 <b>${parsed.timeSig.num}/${parsed.timeSig.den}</b>` : "拍号 4/4",
    `音符轨 <b>${noteTracks.length}</b>`,
  ].join(" · ");
  $("midi-info").innerHTML = `文件 <b>${name}</b><br>${meta}`;

  midiKeySel.value = suggestKeyName(parsed);

  const box = $("midi-tracks");
  box.innerHTML = "";
  if (!noteTracks.length) {
    box.innerHTML = '<div class="midi-trk"><span class="tn">（该文件没有可解析的音符轨）</span></div>';
  }
  noteTracks.forEach((t, i) => {
    const lab = document.createElement("label");
    lab.className = "midi-trk";
    lab.innerHTML = `
      <input type="checkbox" class="mtk" data-i="${i}" checked>
      <span class="tn">${t.name || "音轨 " + (i + 1)}</span>
      <span class="tc">${t.notes.length} 音 · ch${t.notes[0] ? t.notes[0].ch + 1 : "?"}</span>`;
    box.appendChild(lab);
  });
  $("midi-modal").classList.remove("hidden");
}
$("midi-import-btn").onclick = () => $("midi-file").click();
$("midi-file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const parsed = parseMidi(buf);
    showMidiModal(parsed, f.name);
  } catch (err) {
    showModal("MIDI 解析失败：" + err.message);
  }
  e.target.value = "";
};
$("midi-cancel").onclick = () => $("midi-modal").classList.add("hidden");
$("midi-do-import").onclick = () => {
  if (!pendingMidi) return;
  const key = midiKeySel.value;
  const chosen = [...document.querySelectorAll(".mtk")]
    .filter((c) => c.checked)
    .map((c) => pendingMidi.tracks.filter((t) => t.notes.length)[+c.dataset.i]);
  if (!chosen.length) { showModal("请至少选择一个包含音符的音轨。"); return; }
  const score = midiToScore(pendingMidi, { key, trackFilter: chosen, sourceName: pendingMidi.tracks[0]?.name });

  // 填充音轨（直接携带解析好的 beats）
  tracks = score.tracks.map((t, i) => ({
    id: i + 1, name: t.name, enabled: t.enabled,
    jianpu: "", octave: 0, chords: "", beats: t.beats, fromMidi: true,
  }));
  nextId = tracks.length + 1;
  // 同步全局设置
  if (score.key && score.key.name) $("key").value = score.key.name;
  $("meter").value = `${score.meter.num}/${score.meter.den}`;
  $("bpm").value = score.bpm;
  $("multi-track").value = score.tracks.length > 1 ? "on" : "off";
  $("position").value = "low";

  $("midi-modal").classList.add("hidden");
  clearImportBanner();
  $("import-name").textContent = pendingMidi.tracks[0]?.name || "MIDI";
  $("import-meta").textContent = `${chosen.length} 轨 · ${key} · ${score.meter.num}/${score.meter.den}`;
  $("import-banner").classList.remove("hidden");
  renderTracksUI();
  generate();
};
$("import-clear").onclick = () => {
  tracks = [makeTrack(1)];
  nextId = 2;
  $("multi-track").value = "off";
  clearImportBanner();
  renderTracksUI();
  generate();
};

// ---- 初始化 ----
tracks = [makeTrack(1)];
renderTracksUI();
generate();
