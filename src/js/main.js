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
  ["kde", "KDE（Breeze）"],
];
const $ = (id) => document.getElementById(id);

// ---- Tauri 桥（桌面环境；浏览器预览时优雅降级）----
const tauriAPI = window.__TAURI__ || null;
const hasTauri = !!tauriAPI;
function invoke(cmd, args) {
  if (!hasTauri) return Promise.reject(new Error("该功能仅在桌面应用内可用"));
  return tauriAPI.core.invoke(cmd, args || {});
}

let tracks = [];          // [{id,name,enabled,jianpu,octave,chords}]
let nextId = 1;
let currentScore = null;
let currentSvgs = {};     // {jianpu:[svg,...], staff:[...], tab:[...], chordtab:[...]}
let highlightBeat = -1;
let dirty = false;        // 是否有未保存改动（关闭窗口时提示）
let currentLibName = "";  // 当前关联的曲谱库名称

// ---- 主题 ----
THEMES.forEach(([v, t]) => {
  const o = document.createElement("option");
  o.value = v; o.textContent = t; $("theme").appendChild(o);
});
// 旧存档可能带已下线的主题（如 thinkpad）：回落到默认
function applyTheme(v) {
  const ok = THEMES.some(([id]) => id === v);
  const final = ok ? v : "brushed";
  $("theme").value = final;
  document.documentElement.dataset.theme = final;
  return final;
}
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
function showModal(html, title = "提示") {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal").classList.remove("hidden");
}
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
      showModal(`<b>${tr.name}</b> 简谱有误：<br>${detail}<br><br>${highlightTokens(tokens, badIdx)}`, "输入有误");
      return null;
    }
    const { marks, errors: cErr } = parseChordMarks(tr.chords, beats.length);
    if (cErr.length) {
      if (errBox) { errBox.innerHTML = cErr.map((e) => `<mark>${e.token}</mark> ${e.reason}`).join("<br>"); errBox.classList.remove("hidden"); }
      showModal(`<b>${tr.name}</b> 和弦标记有误：<br>` + cErr.map((e) => `「${e.token}」：${e.reason}`).join("<br>"), "输入有误");
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
  try {
    score.tracks.forEach((tr, tk) => {
      if (!tr.enabled) return;
      currentSvgs.jianpu.push(renderJianpu(tr, g, tk, perLine));
      currentSvgs.staff.push(renderStaff(tr, g, tk, perLine));
      currentSvgs.tab.push(renderTab(tr, g, tk, false, perLine));
      currentSvgs.chordtab.push(renderTab(tr, g, tk, true, perLine));
    });
  } catch (err) { console.error("渲染异常:", err); }
  const fill = (type) => {
    const arr = currentSvgs[type];
    $("svg-" + type).innerHTML = arr.length ? arr.join("") : '<div class="placeholder">无启用的音轨</div>';
  };
  fill("jianpu"); fill("staff"); fill("tab"); fill("chordtab");
  pushLanScore();   // 局域网预览同步更新
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

// ---- 状态采集 / 应用 ----
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

function applyState(data) {
  if (data.app !== "ChordBridge") { showModal("不是有效的 ChordBridge 存档文件。"); return false; }
  const s = data.settings || {};
  if (s.key) $("key").value = s.key;
  if (s.meter) $("meter").value = s.meter;
  if (s.bpm) $("bpm").value = s.bpm;
  if (s.position) $("position").value = s.position;
  if (s.accomp) $("accomp").value = s.accomp;
  if (s.multi) $("multi-track").value = s.multi;
  if (s.lineBeats !== undefined) $("line-beats").value = s.lineBeats;
  if (s.theme) applyTheme(s.theme);
  if (Array.isArray(data.tracks) && data.tracks.length) {
    tracks = data.tracks.map((t) => ({
      id: nextId++, name: t.name || "音轨", enabled: t.enabled !== false,
      jianpu: t.jianpu || "", octave: t.octave || 0, chords: t.chords || "",
      beats: t.beats || null, fromMidi: t.fromMidi || false,
    }));
    renderTracksUI();
    generate();
  }
  return true;
}

function defaultScoreName() {
  const d = new Date().toISOString().slice(0, 10);
  const imported = !$("import-banner").classList.contains("hidden");
  const src = imported ? ($("import-name").textContent || "MIDI") : "";
  return src ? `${src}_${d}` : `曲谱_${d}`;
}

// ---- 保存到曲谱库（应用数据目录）----
$("save-file").onclick = async () => {
  if (!hasTauri) {
    // 浏览器预览模式回退：下载 JSON 文件
    const blob = new Blob([JSON.stringify(collectState(), null, 2)], { type: "application/json" });
    downloadBlob(blob, `ChordBridge_${new Date().toISOString().slice(0, 10)}.json`);
    return;
  }
  $("save-name").value = currentLibName || defaultScoreName();
  try { $("save-dir").textContent = "保存位置：" + (await invoke("get_scores_dir")); } catch (_) {}
  $("save-modal").classList.remove("hidden");
  $("save-name").focus();
};
$("save-cancel").onclick = () => $("save-modal").classList.add("hidden");
$("save-confirm").onclick = async () => {
  const name = $("save-name").value.trim() || defaultScoreName();
  try {
    await invoke("save_score", { name, json: JSON.stringify(collectState(), null, 2) });
    currentLibName = name;
    dirty = false;
    $("save-modal").classList.add("hidden");
    showModal("✅ 已保存到曲谱库：" + name);
  } catch (err) { showModal("保存失败：" + err); }
};

// ---- 从文件载入（保留，便于导入旧存档）----
$("load-file-btn").onclick = () => $("load-file").click();
$("load-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (applyState(JSON.parse(await file.text()))) {
      currentLibName = "";
      dirty = false;
      showModal("✅ 载入成功");
    }
  } catch (err) { showModal("载入失败：" + err.message); }
  e.target.value = "";
};

// ---- 曲谱库 ----
$("score-lib").onclick = () => { $("scorelib-modal").classList.remove("hidden"); refreshLib(); };
$("lib-close").onclick = () => $("scorelib-modal").classList.add("hidden");
$("lib-refresh").onclick = refreshLib;

async function refreshLib() {
  const list = $("lib-list");
  if (!hasTauri) { list.innerHTML = '<div class="hint">曲谱库仅在桌面应用内可用。</div>'; return; }
  list.innerHTML = "加载中…";
  try {
    const entries = await invoke("list_scores");
    try { $("lib-dir").textContent = "位置：" + (await invoke("get_scores_dir")); } catch (_) {}
    if (!entries.length) {
      list.innerHTML = '<div class="hint">（曲谱库为空，点「保存到曲谱库」存入第一份）</div>';
      return;
    }
    list.innerHTML = "";
    entries.forEach((en) => {
      const row = document.createElement("div");
      row.className = "lib-item";
      const d = new Date(en.modified * 1000);
      row.innerHTML = `
        <span class="lib-name"></span>
        <span class="hint lib-time">${d.toLocaleDateString()} ${d.toTimeString().slice(0, 5)}</span>
        <button class="mini lib-load">载入</button>
        <button class="mini lib-del">删除</button>`;
      row.querySelector(".lib-name").textContent = en.name;
      row.querySelector(".lib-load").onclick = () => loadFromLib(en.name);
      const delBtn = row.querySelector(".lib-del");
      delBtn.onclick = async () => {
        if (delBtn.dataset.arm !== "1") {   // 两段式确认，防误删
          delBtn.dataset.arm = "1"; delBtn.textContent = "确认?";
          setTimeout(() => { delBtn.dataset.arm = ""; delBtn.textContent = "删除"; }, 2500);
          return;
        }
        try { await invoke("delete_score", { name: en.name }); refreshLib(); }
        catch (err) { showModal("删除失败：" + err); }
      };
      list.appendChild(row);
    });
  } catch (err) { list.textContent = "读取失败：" + err; }
}

async function loadFromLibSilent(name) {
  try {
    const json = await invoke("load_score", { name });
    if (applyState(JSON.parse(json))) {
      currentLibName = name;
      dirty = false;
    }
  } catch (err) { console.error("网页请求载入失败:", err); }
}

async function loadFromLib(name) {
  try {
    if (applyState(JSON.parse(await invoke("load_score", { name })))) {
      currentLibName = name;
      dirty = false;
      $("scorelib-modal").classList.add("hidden");
      showModal("✅ 已载入「" + name + "」");
    }
  } catch (err) { showModal("载入失败：" + err); }
}

// ---- 局域网只读预览服务器 ----
const LAN_PORT = 8848;
let lanOn = false;
let lanPort = LAN_PORT;   // 实际绑定端口（后端可能自动避让 +1）

$("lan-btn").onclick = async () => { $("lan-modal").classList.remove("hidden"); updateLanStatus(); };
$("lan-close").onclick = () => $("lan-modal").classList.add("hidden");
$("lan-toggle").onclick = async () => {
  if (!hasTauri) { showModal("局域网功能仅在桌面应用内可用。"); return; }
  if (!lanOn) {
    try {
      const url = await invoke("start_lan_server", { html: lanViewerHtml(), port: LAN_PORT });
      const m = /:(\d+)$/.exec(String(url));
      lanPort = m ? +m[1] : LAN_PORT;
      lanOn = true;
      pushLanScore();
    } catch (err) {
      showModal("启动失败：" + err);
      return;
    }
  } else {
    try { await invoke("stop_lan_server"); } catch (_) {}
    lanOn = false;
  }
  updateLanStatus();
};

async function updateLanStatus() {
  const el = $("lan-status");
  if (!hasTauri) { el.innerHTML = "⚪ 仅在桌面应用内可用"; $("lan-toggle").textContent = "▶ 启动服务器"; return; }
  let ip = "127.0.0.1";
  try { ip = await invoke("get_lan_ip"); } catch (_) {}
  el.innerHTML = lanOn
    ? `🟢 运行中 · 局域网设备访问 <b>http://${ip}:${lanPort}</b><br>本机预览 <b>http://localhost:${lanPort}</b>${lanPort !== LAN_PORT ? `<br><span class="hint">（端口 ${LAN_PORT} 被占用，已自动使用 ${lanPort}）</span>` : ""}`
    : "⚪ 未启动";
  $("lan-toggle").textContent = lanOn ? "⏹ 停止服务器" : "▶ 启动服务器";
}

function pushLanScore() {
  if (!lanOn || !hasTauri) return;
  const meta = currentScore
    ? `${currentScore.key.name} · ${currentScore.meter.num}/${currentScore.meter.den} · ${currentScore.bpm} BPM · ${currentScore.tracks.length} 轨`
    : "";
  invoke("update_lan_score", {
    json: JSON.stringify({
      title: currentLibName || "未命名曲谱",
      meta, time: Date.now(),
      types: {
        简谱: currentSvgs.jianpu || [],
        五线谱: currentSvgs.staff || [],
        六线谱TAB: currentSvgs.tab || [],
        六线和弦谱: currentSvgs.chordtab || [],
      },
    }),
  }).catch(() => {});
}

/// 局域网展示页（自包含 HTML，由 Rust 端 HTTP 服务器直接返回）
function lanViewerHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChordBridge 曲谱预览</title>
<style>
*{box-sizing:border-box;margin:0}
:root{--bg:#f7f5ef;--panel:#fff;--ink:#2e2c29;--muted:#6e6a63;--line:#d8d3c6;--accent:#8b4513;--accent2:#1f6feb;--shadow:0 2px 10px rgba(0,0,0,.08)}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.5}
.app{display:flex;height:100vh;overflow:hidden}
aside{width:260px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;box-shadow:var(--shadow);z-index:2}
aside h2{padding:14px 16px 8px;font-size:15px;color:var(--muted);font-weight:600}
#lib-list{flex:1;overflow:auto;padding:0 8px 12px}
.lib-item{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background .15s;border:1px solid transparent}
.lib-item:hover{background:#f0ece3;border-color:var(--line)}
.lib-item.active{background:#ede8dc;border-color:#c7bca4}
.lib-name{font-size:14px;font-weight:500;color:var(--ink);word-break:break-all}
.lib-time{font-size:11px;color:var(--muted)}
#lib-empty{padding:20px 16px;color:var(--muted);font-size:13px;text-align:center}
main{flex:1;display:flex;flex-direction:column;min-width:0}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}
header .t{font-weight:700;color:var(--accent);font-size:15px}
nav{display:flex;gap:6px;flex-wrap:wrap;flex:1}
nav button{background:#f7f5ef;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px}
nav button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.z{display:flex;gap:6px}
.z button{width:32px;height:28px;background:#f7f5ef;color:var(--ink);border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:15px}
#meta{padding:8px 16px;color:var(--muted);font-size:13px;min-height:32px}
#wrap{flex:1;overflow:auto;padding:0 16px 40px;background:var(--bg)}
#sheets{transform-origin:0 0;width:max-content;background:#fffdf7;padding:20px 24px;border-radius:8px;border:1px solid #e5e0d4;box-shadow:var(--shadow)}
#sheets svg{display:block;margin:12px 0}
.empty{padding:80px 20px;text-align:center;color:var(--muted)}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#2e2c29;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none}
.toast.show{opacity:.95}
@media(max-width:640px){aside{position:absolute;left:-280px;transition:left .25s}aside.open{left:0}#menu-btn{display:inline-block}}
</style></head><body>
<div class="app">
<aside id="sidebar"><h2>📚 曲谱库</h2><div id="lib-list"><div id="lib-empty">加载中…</div></div></aside>
<main>
<header><span class="t">🎸 <span id="title">ChordBridge</span></span>
<nav id="tabs"></nav>
<div class="z"><button onclick="zoom(-1)">−</button><button onclick="zoom(1)">＋</button><button onclick="zoom(0)">1:1</button></div>
</header>
<div id="meta"></div>
<div id="wrap"><div id="sheets"><div class="empty">等待曲谱数据…<br>在 ChordBridge 中点「生成」后，这里会自动刷新。</div></div></div>
</main>
</div>
<div id="toast" class="toast"></div>
<script>
var TYPES=["简谱","五线谱","六线谱TAB","六线和弦谱"],cur="简谱",scale=1,last=0,data=null,libSel="";
function zoom(d){scale=d===0?1:Math.min(3,Math.max(0.4,scale+d*0.2));apply();}
function apply(){document.getElementById("sheets").style.transform="scale("+scale+")";}
function toast(msg){var t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(function(){t.classList.remove("show");},2000);}
function render(){
 document.getElementById("title").textContent=data.title||"ChordBridge";
 document.getElementById("meta").textContent=data.meta||"";
 var nav=document.getElementById("tabs");nav.innerHTML="";
 TYPES.forEach(function(t){var b=document.createElement("button");b.textContent=t;
  if(t===cur)b.className="on";b.onclick=function(){cur=t;render();};nav.appendChild(b);});
 var arr=(data.types&&data.types[cur])||[];
 document.getElementById("sheets").innerHTML=arr.length?arr.join(""):'<div class="empty">暂无内容：请在 ChordBridge 中点「生成四类谱面」</div>';
 apply();}
function renderLib(list){
 var box=document.getElementById("lib-list");
 if(!list.length){box.innerHTML='<div id="lib-empty">曲谱库为空</div>';return;}
 box.innerHTML="";
 list.forEach(function(en){
  var row=document.createElement("div");row.className="lib-item"+(en.name===libSel?" active":"");
  var d=new Date(en.modified*1000);
  row.innerHTML='<span class="lib-name">'+esc(en.name)+'</span><span class="lib-time">'+d.toLocaleDateString()+' '+d.toTimeString().slice(0,5)+'</span>';
  row.onclick=function(){openScore(en.name);};
  box.appendChild(row);
 });}
function esc(s){return s.replace(/[&<>"]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":"&quot;";});}
function openScore(name){
 libSel=name;
 fetch("/api/open/"+encodeURIComponent(name)).then(function(r){return r.json();}).then(function(d){
  if(d.error){toast(d.error);return;}
  toast("已请求打开「"+name+"」，请稍候…");
  renderLibLast();
 }).catch(function(){toast("打开失败");});}
var lastLib=[];
function renderLibLast(){renderLib(lastLib);}
function pollScore(){fetch("/api/score").then(function(r){return r.json();}).then(function(d){
 if(d&&d.time&&d.time!==last){last=d.time;data=d;render();}}).catch(function(){});}
function pollLib(){fetch("/api/scores").then(function(r){return r.json();}).then(function(list){
 lastLib=list;renderLib(list);}).catch(function(){});}
pollScore();pollLib();setInterval(pollScore,3000);setInterval(pollLib,12000);
</script></body></html>`;
}

// ---- 网页端曲谱库点选：应用轮询并自动载入 ----
if (hasTauri) {
  setInterval(async () => {
    try {
      const name = await invoke("get_selected_score");
      if (name && name !== currentLibName) await loadFromLibSilent(name);
    } catch (_) {}
  }, 1000);
}
if (hasTauri) {
  tauriAPI.event.listen("cb-close-requested", () => {
    if (dirty) {
      $("close-modal").classList.remove("hidden");
    } else {
      invoke("approve_close").catch(() => {});
    }
  }).catch((err) => console.error("close-requested 监听注册失败（检查 capabilities 权限）:", err));
}
$("close-cancel").onclick = () => $("close-modal").classList.add("hidden");
$("close-quit").onclick = () => {
  $("close-modal").classList.add("hidden");
  invoke("approve_close").catch(() => {});
};
$("close-save").onclick = async () => {
  let name = currentLibName || defaultScoreName();
  try {
    await invoke("save_score", { name, json: JSON.stringify(collectState(), null, 2) });
    currentLibName = name;
    dirty = false;
  } catch (err) {
    $("close-modal").classList.add("hidden");
    showModal("保存失败，已取消退出：" + err);
    return;
  }
  $("close-modal").classList.add("hidden");
  invoke("approve_close").catch(() => {});
};

// ---- 脏状态追踪：任何输入/修改都视为未保存 ----
document.addEventListener("input", () => (dirty = true));
document.addEventListener("change", () => (dirty = true));

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
  dirty = true;      // 程序化填充不走 input 事件，手动标记
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
  $("modal").classList.add("hidden");
  clearImportBanner();
  $("import-name").textContent = pendingMidi.tracks[0]?.name || "MIDI";
  $("import-meta").textContent = `${chosen.length} 轨 · ${key} · ${score.meter.num}/${score.meter.den}`;
  $("import-banner").classList.remove("hidden");
  renderTracksUI();
  generate();
  dirty = true;      // MIDI 导入替换了全部音轨，手动标记
};
$("import-clear").onclick = () => {
  tracks = [makeTrack(1)];
  nextId = 2;
  $("multi-track").value = "off";
  clearImportBanner();
  renderTracksUI();
  generate();
  dirty = true;
};

// ---- 初始化 ----
tracks = [makeTrack(1)];
renderTracksUI();
generate();
