//! ChordBridge Tauri 后端：乐理核心 + 曲谱持久化 + 局域网预览服务器 + 关闭拦截
//!
//! 命令清单：
//!   - convert_score           简谱→MIDI+指板（保留原有）
//!   - get_scores_dir          获取跨平台曲谱目录
//!   - save_score              保存曲谱 JSON 到应用数据目录
//!   - list_scores             列出已保存的曲谱
//!   - load_score              读取指定曲谱
//!   - delete_score            删除指定曲谱
//!   - start_lan_server        启动局域网只读预览服务器（默认 8848）
//!   - update_lan_score        更新当前展示的曲谱数据
//!   - stop_lan_server          停止局域网服务器
//!   - approve_close           前端确认放弃未保存改动后调用，真正关闭窗口

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, WindowEvent};

use chordbridge_theory as theory;

// ============================================================
// 关闭拦截
// ============================================================
static ALLOW_CLOSE: AtomicBool = AtomicBool::new(false);

// ============================================================
// 局域网服务器全局状态
// ============================================================
static STOP_FLAG: AtomicBool = AtomicBool::new(false);
static SERVER_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static LAN_HTML: Mutex<String> = Mutex::new(String::new());
static LAN_SCORE: Mutex<String> = Mutex::new(String::new());
static SCORES_DIR: Mutex<String> = Mutex::new(String::new());
static SELECTED_SCORE: Mutex<String> = Mutex::new(String::new());

// ============================================================
// 乐理命令（保留原有）
// ============================================================

#[derive(Serialize)]
struct ConvertResult {
    midis: Vec<i32>,
    frets: Vec<Option<theory::FretPos>>,
    errors: Vec<String>,
}

#[tauri::command]
fn convert_score(jianpu: String, key: String, octave: i32, position: String) -> ConvertResult {
    let k = match theory::resolve_key(&key) {
        Some(k) => k,
        None => {
            return ConvertResult {
                midis: vec![],
                frets: vec![],
                errors: vec![format!("未知调号: {key}")],
            };
        }
    };
    let (beats, errs) = theory::parse_jianpu(&jianpu);
    let errors = errs.iter().map(|(i, e)| format!("token#{i}: {e:?}")).collect();
    let mut midis: Vec<i32> = Vec::new();
    let mut frets: Vec<Option<theory::FretPos>> = Vec::new();
    for beat in &beats {
        if beat.is_rest {
            continue;
        }
        for n in &beat.notes {
            let m = theory::note_to_midi(n, &k, octave);
            midis.push(m);
            frets.push(theory::find_fret(m, &position));
        }
    }
    ConvertResult {
        midis,
        frets,
        errors,
    }
}

// ============================================================
// 曲谱持久化（跨平台应用数据目录）
//   macOS:  ~/Library/Application Support/com.ranlian.chordbridge/scores/
//   Windows: %APPDATA%\com.ranlian.chordbridge\scores\
//   Linux:  ~/.local/share/com.ranlian.chordbridge/scores/
// ============================================================

#[derive(Serialize)]
struct ScoreEntry {
    name: String,
    modified: u64,
}

#[tauri::command]
fn get_scores_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let scores = dir.join("scores");
    std::fs::create_dir_all(&scores).map_err(|e| e.to_string())?;
    Ok(scores.to_string_lossy().to_string())
}

#[tauri::command]
fn save_score(app: tauri::AppHandle, name: String, json: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let scores = dir.join("scores");
    std::fs::create_dir_all(&scores).map_err(|e| e.to_string())?;
    // 文件名安全化：只保留字母数字 _ - .
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    let path = scores.join(format!("{}.json", safe_name));
    std::fs::write(&path, &json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_scores(app: tauri::AppHandle) -> Result<Vec<ScoreEntry>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let scores = dir.join("scores");
    if !scores.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&scores).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(ScoreEntry { name, modified });
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

#[tauri::command]
fn load_score(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("scores").join(format!("{}.json", name));
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_score(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("scores").join(format!("{}.json", name));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================
// 局域网只读预览服务器（默认端口 8848，避开常用端口）
// ============================================================

fn stop_lan_server_impl() -> bool {
    STOP_FLAG.store(true, Ordering::SeqCst);
    let handle = SERVER_HANDLE.lock().unwrap().take();
    if let Some(h) = handle {
        let _ = h.join();
    }
    true
}

#[tauri::command]
fn start_lan_server(app: tauri::AppHandle, html: String, port: Option<u16>) -> Result<String, String> {
    stop_lan_server_impl();
    let port = port.unwrap_or(8848);
    *LAN_HTML.lock().unwrap() = html;
    *LAN_SCORE.lock().unwrap() = String::from("{}");
    if let Ok(dir) = app.path().app_data_dir() {
        let scores = dir.join("scores");
        let _ = std::fs::create_dir_all(&scores);
        *SCORES_DIR.lock().unwrap() = scores.to_string_lossy().to_string();
    }
    STOP_FLAG.store(false, Ordering::SeqCst);

    // 端口自动避让：优先用请求端口，被占用则依次 +1 尝试（最多 10 个）
    let mut listener = None;
    let mut bound = port;
    for p in port..port + 10 {
        match TcpListener::bind(("0.0.0.0", p)) {
            Ok(l) => {
                listener = Some(l);
                bound = p;
                break;
            }
            Err(_) => continue,
        }
    }
    let listener = listener.ok_or_else(|| format!("端口 {}-{} 均绑定失败，可能被占用", port, port + 9))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    let handle = std::thread::spawn(move || {
        while !STOP_FLAG.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    std::thread::spawn(move || {
                        let _ = handle_http(stream);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });

    *SERVER_HANDLE.lock().unwrap() = Some(handle);
    Ok(format!("http://0.0.0.0:{}", bound))
}

#[tauri::command]
fn update_lan_score(json: String) -> Result<(), String> {
    *LAN_SCORE.lock().unwrap() = json;
    Ok(())
}

#[tauri::command]
fn get_selected_score() -> String {
    SELECTED_SCORE.lock().unwrap().drain(..).collect()
}

/// 获取本机局域网 IP（UDP connect 技巧：不实际发包，仅让系统选路）
#[tauri::command]
fn get_lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80").ok();
            s.local_addr().map(|a| a.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[tauri::command]
fn stop_lan_server() -> bool {
    stop_lan_server_impl()
}

/// 处理单个 HTTP 请求：
///   GET /              → 展示页 HTML
///   GET /api/score     → 当前曲谱（含预渲染 SVG）
///   GET /api/scores    → 曲谱库列表
///   GET /api/open/:名   → 网页请求打开某曲谱，应用端轮询 get_selected_score 后载入
fn handle_http(stream: TcpStream) -> std::io::Result<()> {
    let mut buf = String::new();
    {
        let mut reader = BufReader::new(&stream);
        reader.read_line(&mut buf)?;
        // 读空剩余请求头
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            if line.trim().is_empty() {
                break;
            }
        }
    }

    let path = buf.split_whitespace().nth(1).unwrap_or("/");

    let (status, content_type, body) = if path == "/" || path.starts_with("/index") {
        let html = LAN_HTML.lock().unwrap().clone();
        ("200 OK", "text/html; charset=utf-8", html)
    } else if path == "/api/score" {
        let score = LAN_SCORE.lock().unwrap().clone();
        ("200 OK", "application/json; charset=utf-8", score)
    } else if path == "/api/scores" {
        let body = list_scores_http();
        ("200 OK", "application/json; charset=utf-8", body)
    } else if let Some(name) = path.strip_prefix("/api/open/") {
        let decoded = url_decode(name);
        let body = match load_and_select_score(&decoded) {
            Ok(json) => json,
            Err(e) => format!("{{\"error\":\"{}\"}}", e),
        };
        ("200 OK", "application/json; charset=utf-8", body)
    } else {
        (
            "404 Not Found",
            "text/plain; charset=utf-8",
            "Not Found".to_string(),
        )
    };

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        len = body.len(),
        body = body,
    );

    let mut stream = stream;
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn list_scores_http() -> String {
    let dir = SCORES_DIR.lock().unwrap().clone();
    if dir.is_empty() || !std::path::Path::new(&dir).exists() {
        return "[]".to_string();
    }
    let mut entries = Vec::new();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            entries.push(serde_json::json!({ "name": name, "modified": modified }));
        }
    }
    entries.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string())
}

fn load_and_select_score(name: &str) -> Result<String, String> {
    let dir = SCORES_DIR.lock().unwrap().clone();
    if dir.is_empty() {
        return Err("曲谱库未初始化".into());
    }
    let path = std::path::Path::new(&dir).join(format!("{}.json", name));
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    *SELECTED_SCORE.lock().unwrap() = name.to_string();
    Ok(json)
}

fn url_decode(s: &str) -> String {
    // 按 UTF-8 字节解码（中文等多字节字符必须整体还原，不能逐 %XX 转 char）
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ============================================================
// 关闭确认
// ============================================================

#[tauri::command]
fn approve_close(window: tauri::Window) {
    ALLOW_CLOSE.store(true, Ordering::SeqCst);
    let _ = window.close();
}

// ============================================================
// 局域网 HTTP 服务器单元测试（真实 TCP 回环）
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::Shutdown;

    /// 通过回环 TCP 对 handle_http 做一次真实 HTTP 请求
    fn http_get(path: &str) -> String {
        *LAN_HTML.lock().unwrap() = "<html>viewer</html>".into();
        *LAN_SCORE.lock().unwrap() = r#"{"time":123,"title":"t"}"#.into();
        *SCORES_DIR.lock().unwrap() = String::new(); // 让 /api/scores 走空目录分支
        SELECTED_SCORE.lock().unwrap().clear();

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        client
            .write_all(format!("GET {} HTTP/1.1\r\nHost: t\r\n\r\n", path).as_bytes())
            .unwrap();
        let _ = client.shutdown(Shutdown::Write);
        handle_http(server).unwrap();
        let mut resp = String::new();
        client.read_to_string(&mut resp).unwrap();
        resp
    }

    #[test]
    fn route_index_returns_html() {
        let r = http_get("/");
        assert!(r.starts_with("HTTP/1.1 200 OK"), "{}", r);
        assert!(r.contains("text/html"));
        assert!(r.ends_with("<html>viewer</html>"));
    }

    #[test]
    fn route_score_returns_json() {
        let r = http_get("/api/score");
        assert!(r.starts_with("HTTP/1.1 200 OK"));
        assert!(r.contains("application/json"));
        assert!(r.ends_with(r#"{"time":123,"title":"t"}"#));
    }

    #[test]
    fn route_scores_returns_empty_list() {
        let r = http_get("/api/scores");
        assert!(r.starts_with("HTTP/1.1 200 OK"));
        assert!(r.ends_with("[]"));
    }

    #[test]
    fn route_open_without_dir_returns_error_json() {
        let r = http_get("/api/open/whatever");
        assert!(r.starts_with("HTTP/1.1 200 OK"));
        assert!(r.contains("error"));
    }

    #[test]
    fn unknown_route_is_404() {
        let r = http_get("/nope");
        assert!(r.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn url_decode_works() {
        assert_eq!(url_decode("%E6%9B%B2%E8%B0%B1"), "曲谱");
        assert_eq!(url_decode("a+b"), "a b");
    }
}

// ============================================================
// 启动
// ============================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !ALLOW_CLOSE.load(Ordering::SeqCst) {
                    // 通知前端：用户点了关闭，请检查是否有未保存改动
                    let _ = window.emit("cb-close-requested", ());
                    api.prevent_close();
                } else {
                    // 前端已批准，放行并复位
                    ALLOW_CLOSE.store(false, Ordering::SeqCst);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            convert_score,
            get_scores_dir,
            save_score,
            list_scores,
            load_score,
            delete_score,
            start_lan_server,
            update_lan_score,
            get_selected_score,
            get_lan_ip,
            stop_lan_server,
            approve_close,
        ])
        .run(tauri::generate_context!())
        .expect("ChordBridge 启动失败");
}
