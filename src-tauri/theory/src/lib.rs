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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Beat {
    pub notes: Vec<JianpuNote>,
    pub is_rest: bool,
    pub is_tie: bool,
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
                beats.push(Beat { notes: Vec::new(), is_rest: false, is_tie: true });
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
    let subs: Vec<&str> = tok.split('+').filter(|s| !s.is_empty()).collect();
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
                return Ok(Beat { notes: Vec::new(), is_rest: true, is_tie: false });
            }
        }
    }
    Ok(Beat { notes, is_rest: false, is_tie: false })
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
}
