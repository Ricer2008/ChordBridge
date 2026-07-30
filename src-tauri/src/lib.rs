//! ChordBridge Tauri 后端：把乐理核心暴露为前端可调用的命令

use chordbridge_theory as theory;
use serde::Serialize;

#[derive(Serialize)]
struct ConvertResult {
    midis: Vec<i32>,
    frets: Vec<Option<theory::FretPos>>,
    errors: Vec<String>,
}

/// 前端可调用：简谱文本 → MIDI 音高 + 指板位置（权威 Rust 实现）
#[tauri::command]
fn convert_score(jianpu: String, key: String, octave: i32, position: String) -> ConvertResult {
    let k = match theory::resolve_key(&key) {
        Some(k) => k,
        None => {
            return ConvertResult { midis: vec![], frets: vec![], errors: vec![format!("未知调号: {key}")] };
        }
    };
    let (beats, errs) = theory::parse_jianpu(&jianpu);
    let errors = errs.iter().map(|(i, e)| format!("token#{i}: {e:?}")).collect();
    let mut midis: Vec<i32> = Vec::new();
    let mut frets: Vec<Option<theory::FretPos>> = Vec::new();
    for beat in &beats {
        if beat.is_rest { continue; }
        for n in &beat.notes {
            let m = theory::note_to_midi(n, &k, octave);
            midis.push(m);
            frets.push(theory::find_fret(m, &position));
        }
    }
    ConvertResult { midis, frets, errors }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![convert_score])
        .run(tauri::generate_context!())
        .expect("ChordBridge 启动失败");
}
