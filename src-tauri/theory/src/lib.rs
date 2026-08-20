//! ChordBridge 乐理核心库（阶段一）
//! 音高映射 / 调号计算（五度循环）/ 吉他指板查找 / 简谱解析（beats 模型）
//! 与前端 src/js/theory.js 保持同构，本库是权威实现并带单元测试。

use serde::{Deserialize, Serialize};

/// 大调调号信息：主音 pitch class + 升降号数量（正=升，负=降）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Key {
    pub pc: i32,
    pub acc: i32,
    pub is_minor: bool,
}

/// 五度循环表：大调
pub fn resolve_key(name: &str) -> Option<Key> {
    let major = match name {
        "Am" => "C", "Em" => "G", "Bm" => "D", "F#m" => "A", "C#m" => "E",
        "G#m" => "B", "D#m" => "F#", "A#m" => "C#", "Dm" => "F", "Gm" => "Bb",
        "Cm" => "Eb", "Fm" => "Ab", "Bbm" => "Db", "Ebm" => "Gb",
        other => other,
    };
    let is_minor = name.ends_with('m') && name != major;
    let (pc, acc) = match major {
        "C" => (0, 0), "G" => (7, 1), "D" => (2, 2), "A" => (9, 3),
        "E" => (4, 4), "B" => (11, 5), "F#" => (6, 6), "C#" => (1, 7),
        "F" => (5, -1), "Bb" => (10, -2), "Eb" => (3, -3), "Ab" => (8, -4),
        "Db" => (1, -5), "Gb" => (6, -6),
        _ => return None,
    };
    Some(Key { pc, acc, is_minor })
}

/// 简谱音符
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct JianpuNote {
    pub degree: u8,   // 1..=7
    pub acc: i32,     // -1 / 0 / 1
    pub oct_shift: i32,
}

/// 一拍：可含多个同拍音（+ 连接）、休止（0）或延音（-）
/// dots = 附点数（3. → 1，时长 ×1.5；3.. → 2，时长 ×1.75）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Beat {
    pub notes: Vec<JianpuNote>,
    pub is_rest: bool,
    pub is_tie: bool,
    #[serde(default)]
    pub dots: u8,
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    IllegalDigit(String),   // 8、9
    BadToken(String),
    DoubleAccidental(String),
}

/// 解析简谱字符串（空格分隔，每 token 一拍）。
/// 语法：0=休止；3+4=一拍两音；#/#=升；b=降；!/?=八度；-/3-=延音一拍
pub fn parse_jianpu(text: &str) -> (Vec<Beat>, Vec<(usize, ParseError)>) {
    let mut beats = Vec::new();
    let mut errors = Vec::new();
    for (i, tok) in text.split_whitespace().enumerate() {
        // 展开 token 尾部的 - 为独立延音拍（仅当 token 不含 +）
        let parts: Vec<String> = if !tok.contains('+') {
            if tok.chars().all(|c| c == '-') && !tok.is_empty() {
                tok.chars().map(|_| "-".to_string()).collect()
            } else if let Some(split_at) = find_tie_split(tok) {
                let head = tok[..split_at].to_string();
                let ties = tok[split_at..].chars().map(|_| "-".to_string());
                let mut v = vec![head];
                v.extend(ties);
                v
            } else {
                vec![tok.to_string()]
            }
        } else {
            vec![tok.to_string()]
        };
        for part in &parts {
            if part == "-" {
                beats.push(Beat { notes: Vec::new(), is_rest: false, is_tie: true, dots: 0 });
                continue;
            }
            match parse_beat(part) {
                Ok(b) => beats.push(b),
                Err(e) => errors.push((i, e)),
            }
        }
    }
    (beats, errors)
}

/// 找 token 尾部 - 序列的起点（返回 head 长度）。全 - 返回 None（由调用方单独处理）
fn find_tie_split(tok: &str) -> Option<usize> {
    if !tok.ends_with('-') { return None; }
    let bytes = tok.as_bytes();
    let mut idx = bytes.len();
    while idx > 0 && bytes[idx - 1] == b'-' { idx -= 1; }
    if idx == 0 { None } else { Some(idx) }
}

fn is_half_acc(c: char) -> bool {
    matches!(c, '#' | 'b')
}

fn parse_beat(tok: &str) -> Result<Beat, ParseError> {
    // 剥离尾部附点（记在拍上，作用于整拍时值）
    let body = tok.trim_end_matches('.');
    let dots = tok.chars().count() as u8 - body.chars().count() as u8;
    let subs: Vec<&str> = body.split('+').filter(|s| !s.is_empty()).collect();
    if subs.is_empty() {
        return Err(ParseError::BadToken(tok.into()));
    }
    let mut notes = Vec::new();
    for sub in &subs {
        match parse_sub(sub, tok)? {
            Some(n) => notes.push(n),
            None => {
                // 休止：不允许与 + 连用
                if subs.len() > 1 {
                    return Err(ParseError::BadToken(
                        format!("休止符 0 不能与 + 连用：{}", sub)));
                }
                return Ok(Beat { notes: Vec::new(), is_rest: true, is_tie: false, dots });
            }
        }
    }
    Ok(Beat { notes, is_rest: false, is_tie: false, dots })
}

/// 解析单个音/休止子串。返回 Ok(Some)=音，Ok(None)=休止，Err=错误
/// #/b=半音升降（前后缀），!/?=八度升降（可叠加），0=休止
fn parse_sub(sub: &str, tok: &str) -> Result<Option<JianpuNote>, ParseError> {
    let chars: Vec<char> = sub.chars().collect();
    let mut idx = 0;
    let mut acc = 0i32;
    let mut acc_count = 0;
    // 前缀 #/b
    if idx < chars.len() && is_half_acc(chars[idx]) {
        acc = if chars[idx] == '#' { 1 } else { -1 };
        acc_count += 1;
        idx += 1;
    }
    if idx >= chars.len() || !chars[idx].is_ascii_digit() {
        return Err(ParseError::BadToken(tok.into()));
    }
    let d = chars[idx] as u8 - b'0';
    idx += 1;
    if d == 0 {
        if acc_count > 0 || idx < chars.len() {
            return Err(ParseError::BadToken(format!("休止符 0 不能带任何符号：{}", sub)));
        }
        return Ok(None);
    }
    if !(1..=7).contains(&d) {
        return Err(ParseError::IllegalDigit(tok.into()));
    }
    // 后缀 #/b
    if idx < chars.len() && is_half_acc(chars[idx]) {
        if acc_count > 0 {
            return Err(ParseError::DoubleAccidental(tok.into()));
        }
        acc = if chars[idx] == '#' { 1 } else { -1 };
        idx += 1;
    }
    // !/? 八度（可叠加）
    let mut oct_shift = 0i32;
    while idx < chars.len() {
        match chars[idx] {
            '!' => oct_shift += 1,
            '?' => oct_shift -= 1,
            c if is_half_acc(c) => return Err(ParseError::DoubleAccidental(tok.into())),
            _ => return Err(ParseError::BadToken(tok.into())),
        }
        idx += 1;
    }
    Ok(Some(JianpuNote { degree: d, acc, oct_shift }))
}

/// 大调音级 → 半音偏移
const DEGREE_SEMIS: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];

/// 简谱音符 → MIDI 音高。主音贴近中央 C（54..=65），global_octave 为全局八度 -1..=3
pub fn note_to_midi(note: &JianpuNote, key: &Key, global_octave: i32) -> i32 {
    let go = global_octave.clamp(-1, 3); // 越界优雅降级
    let tonic = 60 + ((key.pc + 6) % 12) - 6;
    tonic + DEGREE_SEMIS[(note.degree - 1) as usize] + note.acc + 12 * (go + note.oct_shift)
}

/// 拍的实际时长（以一拍为单位）：附点 ×1.5 / ×1.75
pub fn beat_duration(beat: &Beat) -> f64 {
    let mut d = 1.0;
    for i in 0..beat.dots {
        d += 0.5f64.powi(i as i32 + 1);
    }
    d
}

// ---------------- 五线谱拼写（调号感知）----------------

pub const LETTERS: [&str; 7] = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER: [usize; 7] = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B（字母索引）
const FLAT_ORDER: [usize; 7] = [6, 2, 5, 1, 4, 0, 3];  // B E A D G C F

/// 调号：每个字母（索引 0..7）的默认升降（如 G 大调 F 为 +1）
pub fn key_signature(key: &Key) -> [i32; 7] {
    let mut sig = [0i32; 7];
    if key.acc > 0 {
        for &li in SHARP_ORDER.iter().take(key.acc as usize) { sig[li] = 1; }
    } else if key.acc < 0 {
        for &li in FLAT_ORDER.iter().take((-key.acc) as usize) { sig[li] = -1; }
    }
    sig
}

/// 拼写结果：letter/spell_acc/octave_sci + show_acc（相对调号还需画的变音记号）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpelledNote {
    pub midi: i32,
    pub letter: usize,  // 0..=6 → C..B
    pub spell_acc: i32, // 拼写升降（含调号）
    pub octave_sci: i32,
    pub show_acc: i32,  // 相对调号的差值：0 = 调号已覆盖，无需画
}

/// 大调主音字母（升号调用 sharp 拼写，降号调用 flat 拼写）
fn major_tonic_letter(key: &Key) -> usize {
    // pc → 字母（双拼名按 acc 方向取舍）
    let sharp = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let flat = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
    let name = if key.acc >= 0 { sharp[key.pc as usize % 12] } else { flat[key.pc as usize % 12] };
    LETTERS.iter().position(|&l| name.starts_with(l)).unwrap_or(0)
}

/// 简谱音符 → MIDI + 五线谱拼写（与前端 theory.js noteToPitch 同构）
pub fn note_to_pitch(note: &JianpuNote, key: &Key, global_octave: i32) -> SpelledNote {
    let midi = note_to_midi(note, key, global_octave);
    let ti = major_tonic_letter(key);
    let li = (ti + note.degree as usize - 1) % 7;
    let letter = li;
    let mut spell_acc = ((midi % 12) - LETTER_PC[letter] + 12) % 12;
    if spell_acc > 6 { spell_acc -= 12; }
    let octave_sci = (midi - spell_acc).div_euclid(12) - 1;
    let sig = key_signature(key);
    let show_acc = spell_acc - sig[letter];
    SpelledNote { midi, letter, spell_acc, octave_sci, show_acc }
}

/// 标准调弦（第1弦到第6弦）：e4 B3 G3 D3 A2 E2
pub const STRING_MIDI: [i32; 6] = [64, 59, 55, 50, 45, 40];
pub const MAX_FRET: i32 = 17;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FretPos {
    pub string: u8, // 1..=6
    pub fret: i32,
    pub transposed: i32, // 音域外八度移位次数
}

/// 指板查找：position "low" 优先 0-4 品，"high" 优先 5 品以上
pub fn find_fret(midi: i32, position: &str) -> Option<FretPos> {
    let mut m = midi;
    let mut transposed = 0;
    while m < STRING_MIDI[5] { m += 12; transposed += 1; }
    while m > STRING_MIDI[0] + MAX_FRET { m -= 12; transposed -= 1; }

    let mut candidates: Vec<FretPos> = Vec::new();
    for (si, open) in STRING_MIDI.iter().enumerate() {
        let fret = m - open;
        if (0..=MAX_FRET).contains(&fret) {
            candidates.push(FretPos { string: si as u8 + 1, fret, transposed });
        }
    }
    if candidates.is_empty() { return None; }
    if position == "high" {
        candidates.sort_by_key(|c| if c.fret < 5 { 100 + c.fret } else { (c.fret - 7).abs() });
    } else {
        candidates.sort_by_key(|c| (c.fret, c.string));
    }
    Some(candidates[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circle_of_fifths() {
        assert_eq!(resolve_key("C").unwrap().acc, 0);
        assert_eq!(resolve_key("G").unwrap().acc, 1);   // F#
        assert_eq!(resolve_key("D").unwrap().acc, 2);
        assert_eq!(resolve_key("F").unwrap().acc, -1);  // Bb
        assert_eq!(resolve_key("C#").unwrap().acc, 7);
        assert!(resolve_key("H").is_none());
    }

    #[test]
    fn test_minor_relative() {
        let am = resolve_key("Am").unwrap();
        let c = resolve_key("C").unwrap();
        assert_eq!(am.pc, c.pc);
        assert_eq!(am.acc, 0);
        assert!(am.is_minor);
        assert_eq!(resolve_key("Em").unwrap().acc, 1);
    }

    #[test]
    fn test_parse_legal_new_syntax() {
        // #/b 半音；!/? 八度
        let (beats, errs) = parse_jianpu("1 2 3# b7 5! 6?");
        assert!(errs.is_empty(), "{:?}", errs);
        assert_eq!(beats.len(), 6);
        assert_eq!(beats[2].notes[0].acc, 1);   // 3#
        assert_eq!(beats[3].notes[0].acc, -1);  // b7
        assert_eq!(beats[4].notes[0].oct_shift, 1);  // 5!
        assert_eq!(beats[5].notes[0].oct_shift, -1); // 6?
    }

    #[test]
    fn test_parse_octave_stack() {
        // !/? 可叠加
        let (beats, errs) = parse_jianpu("1!! 1?? 1!?");
        assert!(errs.is_empty());
        assert_eq!(beats[0].notes[0].oct_shift, 2);
        assert_eq!(beats[1].notes[0].oct_shift, -2);
        assert_eq!(beats[2].notes[0].oct_shift, 0); // ! 和 ? 抵消
    }

    #[test]
    fn test_parse_half_accidental() {
        // #/b 半音（前缀或后缀）
        let (beats, errs) = parse_jianpu("#3 3# b7 7b");
        assert!(errs.is_empty());
        assert_eq!(beats[0].notes[0].acc, 1);
        assert_eq!(beats[1].notes[0].acc, 1);
        assert_eq!(beats[2].notes[0].acc, -1);
        assert_eq!(beats[3].notes[0].acc, -1);
    }

    #[test]
    fn test_parse_rest() {
        let (beats, errs) = parse_jianpu("1 0 2 0");
        assert!(errs.is_empty());
        assert!(!beats[0].is_rest);
        assert!(beats[1].is_rest);
        assert!(beats[1].notes.is_empty());
        assert!(beats[3].is_rest);
    }

    #[test]
    fn test_parse_chord_beat() {
        // 3+4 一拍两音；#5+b6 同拍升5降6（半音）
        let (beats, errs) = parse_jianpu("3+4 #5+b6");
        assert!(errs.is_empty());
        assert_eq!(beats[0].notes.len(), 2);
        assert_eq!(beats[0].notes[0].degree, 3);
        assert_eq!(beats[0].notes[1].degree, 4);
        assert_eq!(beats[1].notes.len(), 2);
        assert_eq!(beats[1].notes[0].acc, 1);  // #5
        assert_eq!(beats[1].notes[1].acc, -1); // b6
    }

    #[test]
    fn test_parse_illegal() {
        // 8 非法数字；0+5 休止与+连用；x 非法；3## 双升降冲突；3' 旧八度符号已弃用
        let (_, errs) = parse_jianpu("8 0+5 x 3## 3'");
        assert_eq!(errs.len(), 5);
        assert!(matches!(errs[0].1, ParseError::IllegalDigit(_)));
        assert!(matches!(errs[1].1, ParseError::BadToken(_)));
        assert!(matches!(errs[2].1, ParseError::BadToken(_)));
        assert!(matches!(errs[3].1, ParseError::DoubleAccidental(_)));
        assert!(matches!(errs[4].1, ParseError::BadToken(_)));
    }

    #[test]
    fn test_parse_rest_with_symbol_fails() {
        // 休止符不能带 #/b 或 !/?
        let (_, errs) = parse_jianpu("#0 0! b0 0?");
        assert_eq!(errs.len(), 4);
    }

    #[test]
    fn test_parse_tie() {
        // 3- 等价 3 -（3 一拍 + 延音一拍）；-- 为两个延音拍
        let (beats, errs) = parse_jianpu("3- 0 1 --");
        assert!(errs.is_empty(), "{:?}", errs);
        assert_eq!(beats.len(), 6); // 3, -, 0, 1, -, -
        assert!(!beats[0].is_tie && !beats[0].is_rest);
        assert!(beats[1].is_tie);
        assert!(beats[2].is_rest);
        assert!(beats[4].is_tie);
        assert!(beats[5].is_tie);
    }

    #[test]
    fn test_c_major_do_is_c4() {
        let key = resolve_key("C").unwrap();
        let n = JianpuNote { degree: 1, acc: 0, oct_shift: 0 };
        assert_eq!(note_to_midi(&n, &key, 0), 60); // C4
    }

    #[test]
    fn test_g_major_scale_has_fsharp() {
        let key = resolve_key("G").unwrap();
        let n7 = JianpuNote { degree: 7, acc: 0, oct_shift: 0 };
        let midi = note_to_midi(&n7, &key, 0);
        assert_eq!(midi % 12, 6); // F# pitch class = 6
    }

    #[test]
    fn test_octave_clamp() {
        let key = resolve_key("C").unwrap();
        let n = JianpuNote { degree: 1, acc: 0, oct_shift: 0 };
        assert_eq!(note_to_midi(&n, &key, 99), note_to_midi(&n, &key, 3));
        assert_eq!(note_to_midi(&n, &key, -99), note_to_midi(&n, &key, -1));
    }

    #[test]
    fn test_fretboard_open_strings() {
        let f = find_fret(40, "low").unwrap();
        assert_eq!((f.string, f.fret), (6, 0));
        let f = find_fret(64, "low").unwrap();
        assert_eq!((f.string, f.fret), (1, 0));
    }

    #[test]
    fn test_fretboard_high_position() {
        let low = find_fret(60, "low").unwrap();
        assert_eq!((low.string, low.fret), (2, 1));
        let high = find_fret(60, "high").unwrap();
        assert!(high.fret >= 5, "高把位应为5品以上，实际 {:?}", high);
    }

    #[test]
    fn test_out_of_range_fallback() {
        let f = find_fret(28, "low").unwrap(); // E1
        assert_eq!(f.transposed, 1);
        assert_eq!((f.string, f.fret), (6, 0));
    }

    #[test]
    fn test_parse_dotted() {
        // 3. 附点；0. 附点休止；3.. 复附点；3+4. 一拍两音带附点
        let (beats, errs) = parse_jianpu("3. 0. 3.. 3+4.");
        assert!(errs.is_empty(), "{:?}", errs);
        assert_eq!(beats[0].dots, 1);
        assert!(beats[1].is_rest);
        assert_eq!(beats[1].dots, 1);
        assert_eq!(beats[2].dots, 2);
        assert_eq!(beats[3].dots, 1);
        assert_eq!(beats[3].notes.len(), 2);
    }

    #[test]
    fn test_beat_duration() {
        let mk = |dots: u8| Beat { notes: vec![], is_rest: false, is_tie: false, dots };
        assert!((beat_duration(&mk(0)) - 1.0).abs() < 1e-9);
        assert!((beat_duration(&mk(1)) - 1.5).abs() < 1e-9);
        assert!((beat_duration(&mk(2)) - 1.75).abs() < 1e-9);
    }

    #[test]
    fn test_key_signature() {
        let g = resolve_key("G").unwrap();
        let sig = key_signature(&g);
        assert_eq!(sig[3], 1); // F#
        let f = resolve_key("F").unwrap();
        let sig = key_signature(&f);
        assert_eq!(sig[6], -1); // Bb
    }

    #[test]
    fn test_spelling_show_acc() {
        // G 大调：7（F#）在调号内，不画记号；还原的 F（b7）要画还原号（show_acc=-1-1=-2 → ♮♮ 不合常理，按差值处理）
        let g = resolve_key("G").unwrap();
        let n7 = JianpuNote { degree: 7, acc: 0, oct_shift: 0 };
        let p = note_to_pitch(&n7, &g, 0);
        assert_eq!(p.show_acc, 0, "F# 在 G 大调调号内");
        let nb7 = JianpuNote { degree: 7, acc: -1, oct_shift: 0 }; // b7 = F 还原
        let p2 = note_to_pitch(&nb7, &g, 0);
        assert_eq!(p2.spell_acc, 0);
        assert_eq!(p2.show_acc, -1, "还原 F 需画降号中和调号的 #");
        // C 大调：#4 = F#，调号无覆盖，需要画
        let c = resolve_key("C").unwrap();
        let n4 = JianpuNote { degree: 4, acc: 1, oct_shift: 0 };
        let p3 = note_to_pitch(&n4, &c, 0);
        assert_eq!(p3.spell_acc, 1);
        assert_eq!(p3.show_acc, 1);
    }
}
