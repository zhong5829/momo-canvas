//! 本地 GGUF 推理引擎（llama-server）的受控子进程管理。
//!
//! 设计目标（详见《MOMO导演台节点-产品与技术方案》§5）：
//! - 用 `std::process::Command` 的 `args` 逐项传参，**绝不**走 shell 字符串拼接。
//! - Windows 启动时隐藏控制台窗口（`CREATE_NO_WINDOW`）。
//! - 只监听 127.0.0.1，禁止 0.0.0.0。
//! - 一个模型对应一个受管理进程；MOMO 退出时停掉自己启动的进程。
//! - 端口被占用时自动选空闲端口。
//! - 启动期间轮询 `GET /health`，200 才算成功。
//!
//! 不引入 tokio / reqwest：长驻进程用 `std::thread` 监控，/health 用 `std::net::TcpStream` 原生 HTTP。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 隐藏控制台窗口的标志位
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 日志环形缓冲上限（条）
const LOG_MAX: usize = 500;
/// 模型加载超时（秒）：大模型 + 慢盘可能要一两分钟
const LOAD_TIMEOUT_SECS: u64 = 180;
/// /health 轮询间隔（毫秒）
const HEALTH_POLL_MS: u64 = 2000;
/// /health 单次连接超时（毫秒）
const HEALTH_CONN_TIMEOUT_MS: u64 = 1500;
/// 默认起始端口（被占用则自增）
const DEFAULT_PORT: u16 = 18888;
/// 端口探测上限（含）
const PORT_MAX: u16 = 18950;

/// 日志缓冲：每条一行
type LogBuf = VecDeque<String>;

struct RunningProc {
    child: Child,
    pid: u32,
    model_id: String,
    model_name: String,
    port: u16,
    started_at: u64,
    logs: std::sync::Arc<Mutex<LogBuf>>,
}

struct State {
    /// modelId → 运行中的进程
    running: HashMap<String, RunningProc>,
    /// 正在启动中的 modelId（防止并发 start 同一模型 spawn 两个进程抢端口）
    starting: std::collections::HashSet<String>,
    /// 已配置的 llama-server 可执行文件路径
    executable_path: Option<String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        running: HashMap::new(),
        starting: std::collections::HashSet::new(),
        executable_path: None,
    })
});

// ============================ 类型 ============================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub model_id: String,
    pub model_name: String,
    pub executable_path: String,
    pub gguf_path: String,
    pub mmproj_path: Option<String>,
    pub context_size: u32,
    /// 正整数 = 指定层数；字符串 "auto" = 让 llama-server 自己决定
    #[serde(deserialize_with = "de_gpu_layers")]
    pub gpu_layers: GpuLayers,
    pub reasoning_mode: ReasoningMode,
    /// 指定端口；None 或被占用则自动选
    pub port: Option<u16>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum GpuLayers {
    Auto,
    Layers(u32),
}

fn de_gpu_layers<'de, D: serde::Deserializer<'de>>(d: D) -> Result<GpuLayers, D::Error> {
    use serde::de::Error;
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::String(s) if s.eq_ignore_ascii_case("auto") => Ok(GpuLayers::Auto),
        serde_json::Value::Number(n) => n
            .as_u64()
            .map(|x| GpuLayers::Layers(x as u32))
            .ok_or_else(|| Error::custom("gpuLayers 数字无效")),
        _ => Err(Error::custom("gpuLayers 必须是 auto 或正整数")),
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningMode {
    Auto,
    On,
    Off,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub port: u16,
    pub pid: u32,
    pub base_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningInfo {
    pub model_id: String,
    pub model_name: String,
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResult {
    pub lines: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecInfo {
    pub path: Option<String>,
    pub version: Option<String>,
}

// ============================ 命令 ============================

/// 探测 llama-server 可执行文件路径。
///
/// 顺序（任一命中即返回）：
/// 1. `search_paths` 中用户在设置里指定的路径
/// 2. 可执行文件同级目录（便携版同目录捆绑）
/// 3. AppData/tools/llama.cpp/
/// 4. 系统 PATH（直接尝试 `llama-server --version`）
///
/// 验证方式：能跑 `--version`（或 `--help`，旧版本只有 help）且退出码 0 或输出含 `llama-server`。
#[tauri::command]
pub fn detect_llama_server(search_paths: Vec<String>) -> Result<ExecInfo, String> {
    // 1. 用户指定
    for p in &search_paths {
        if let Some(v) = try_executable(p) {
            // 记到全局状态，下次启动复用
            if let Ok(mut st) = STATE.lock() {
                st.executable_path = Some(p.clone());
            }
            return Ok(ExecInfo {
                path: Some(p.clone()),
                version: Some(v),
            });
        }
    }

    // 2. 可执行文件同级目录
    if let Ok(exe_self) = std::env::current_exe() {
        if let Some(dir) = exe_self.parent() {
            for name in llama_server_names() {
                let cand = dir.join(name);
                if cand.exists() {
                    let s = cand.to_string_lossy().into_owned();
                    if let Some(v) = try_executable(&s) {
                        if let Ok(mut st) = STATE.lock() {
                            st.executable_path = Some(s.clone());
                        }
                        return Ok(ExecInfo { path: Some(s), version: Some(v) });
                    }
                }
            }
        }
    }

    // 3. AppData/tools/llama.cpp/
    if let Some(appdata) = appdata_tools_dir() {
        for name in llama_server_names() {
            let cand = appdata.join("llama.cpp").join(name);
            if cand.exists() {
                let s = cand.to_string_lossy().into_owned();
                if let Some(v) = try_executable(&s) {
                    if let Ok(mut st) = STATE.lock() {
                        st.executable_path = Some(s.clone());
                    }
                    return Ok(ExecInfo { path: Some(s), version: Some(v) });
                }
            }
        }
    }

    // 4. PATH
    for name in llama_server_names() {
        if let Some(v) = try_executable(name) {
            // PATH 命中：不记全路径（存 None 让前端下次重探测，更稳健）
            return Ok(ExecInfo {
                path: Some(name.to_string()),
                version: Some(v),
            });
        }
    }

    Ok(ExecInfo {
        path: None,
        version: None,
    })
}

/// 设置已知的 llama-server 路径（用户手动选择后调用）
#[tauri::command]
pub fn set_llama_server_path(path: String) -> Result<ExecInfo, String> {
    // 验证可用
    let v = try_executable(&path).ok_or_else(|| {
        format!("所选文件不是有效的 llama-server：{path}（无法执行或返回异常）")
    })?;
    if let Ok(mut st) = STATE.lock() {
        st.executable_path = Some(path.clone());
    }
    Ok(ExecInfo {
        path: Some(path),
        version: Some(v),
    })
}

/// 启动一个本地模型。结构化传参，绝不走 shell。
#[tauri::command]
pub fn start_local_llm(params: StartParams) -> Result<StartResult, String> {
    // 路径安全校验
    if !params.gguf_path.to_lowercase().ends_with(".gguf") {
        return Err(format!(
            "模型文件扩展名必须是 .gguf：{}",
            params.gguf_path
        ));
    }
    if !std::path::Path::new(&params.gguf_path).exists() {
        return Err(format!("模型文件不存在：{}", params.gguf_path));
    }
    if let Some(ref mm) = params.mmproj_path {
        if !mm.to_lowercase().ends_with(".gguf") {
            return Err(format!("视觉投影文件扩展名必须是 .gguf：{}", mm));
        }
        if !std::path::Path::new(mm).exists() {
            return Err(format!("视觉投影文件不存在：{}", mm));
        }
    }
    if !std::path::Path::new(&params.executable_path).exists()
        && !is_in_path(&params.executable_path)
    {
        return Err(format!(
            "llama-server 可执行文件不存在：{}",
            params.executable_path
        ));
    }

    // 如果同一模型已在运行，先返回现有实例（幂等）
    // 如果同一模型正在启动中（另一个 start_local_llm 还没返回），直接报错避免并发 spawn 抢端口
    {
        let mut st = STATE.lock().map_err(|e| format!("状态锁失败：{e}"))?;
        if let Some(p) = st.running.get(&params.model_id) {
            return Ok(StartResult {
                port: p.port,
                pid: p.pid,
                base_url: format!("http://127.0.0.1:{}", p.port),
            });
        }
        if st.starting.contains(&params.model_id) {
            return Err(format!(
                "模型 {mid} 正在启动中，请稍候再试",
                mid = params.model_id
            ));
        }
        // 标记为启动中（直到 spawn 成功进入 running，或失败时清理）
        st.starting.insert(params.model_id.clone());
    }

    // 选端口
    let prefer = params.port.unwrap_or(DEFAULT_PORT).clamp(DEFAULT_PORT, PORT_MAX);
    // pick_port 失败时必须清理 starting
    let port = match pick_port(prefer) {
        Ok(p) => p,
        Err(e) => {
            clear_starting(&params.model_id);
            return Err(e);
        }
    };

    // 组装参数（逐项 push，绝不字符串拼接）
    let mut args: Vec<String> = Vec::with_capacity(12);
    args.push("--model".into());
    args.push(params.gguf_path.clone());
    if let Some(ref mm) = params.mmproj_path {
        args.push("--mmproj".into());
        args.push(mm.clone());
    }
    args.push("--host".into());
    args.push("127.0.0.1".into());
    args.push("--port".into());
    args.push(port.to_string());
    args.push("--ctx-size".into());
    args.push(params.context_size.to_string());
    // --alias 用 model_name（前端发请求时 model 字段也是 model_name，两者必须一致，
    // 否则严格的 llama.cpp 版本会按 alias 校验并拒绝请求）
    args.push("--alias".into());
    args.push(params.model_name.clone());
    // GPU 卸载层数
    match params.gpu_layers {
        GpuLayers::Auto => {
            // 不传 -ngl：llama.cpp 默认行为（较新版本会自动全层卸载到 GPU）
        }
        GpuLayers::Layers(n) => {
            args.push("-ngl".into());
            args.push(n.to_string());
        }
    }
    // reasoning：llama.cpp 用 --reasoning-format 控制
    // auto / on 都不传（让引擎按模型自动处理，避免对非 DeepSeek 模型套错格式），
    // off 强制 none（明确不输出思考链）
    match params.reasoning_mode {
        ReasoningMode::Auto | ReasoningMode::On => {} // 不传，用引擎默认
        ReasoningMode::Off => {
            args.push("--reasoning-format".into());
            args.push("none".into());
        }
    }

    // 启动
    let mut cmd = Command::new(&params.executable_path);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            clear_starting(&params.model_id);
            return Err(format!(
                "启动 llama-server 失败：{e}\n路径：{}\n参数：{}",
                params.executable_path,
                args.join(" ")
            ));
        }
    };

    let pid = child.id();
    let logs = std::sync::Arc::new(Mutex::new(VecDeque::<String>::with_capacity(LOG_MAX)));
    let started_at = now_secs();

    // 把 stdout / stderr 拉到后台线程，追加进日志环形缓冲
    if let Some(out) = child.stdout.take() {
        let lc = logs.clone();
        let mid = params.model_id.clone();
        std::thread::spawn(move || pump_logs(out, lc, &mid, "out"));
    }
    if let Some(err) = child.stderr.take() {
        let lc = logs.clone();
        let mid = params.model_id.clone();
        std::thread::spawn(move || pump_logs(err, lc, &mid, "err"));
    }

    // 留一份日志 Arc 给本函数的失败诊断用（insert 会 move 走 logs 所有权）
    let logs_for_diag = logs.clone();
    // 登记进全局状态 + 从 starting 移除（已进入 running，并发锁释放）
    {
        let mut st = STATE.lock().map_err(|e| format!("状态锁失败：{e}"))?;
        st.starting.remove(&params.model_id);
        st.running.insert(
            params.model_id.clone(),
            RunningProc {
                child,
                pid,
                model_id: params.model_id.clone(),
                model_name: params.model_name.clone(),
                port,
                started_at,
                logs,
            },
        );
    }

    // 轮询 /health，超时则清理
    let deadline = Instant::now() + Duration::from_secs(LOAD_TIMEOUT_SECS);
    let mut last_err = String::new();
    while Instant::now() < deadline {
        // 进程是否还活着：用 try_wait 检测立即崩溃（#6 修复：旧代码只查 running map 是否存在，
        // 但 spawn 后 child 一直在 map 里，立即崩溃也只能干等 180s 超时）
        {
            let mut st = STATE.lock().map_err(|e| format!("状态锁失败：{e}"))?;
            let exited = match st.running.get_mut(&params.model_id) {
                Some(p) => match p.child.try_wait() {
                    Ok(None) => false,      // 仍活着
                    Ok(Some(_status)) => true, // 已退出
                    Err(_) => false,        // 访问失败，保守认为还活着
                },
                None => true, // 已被其他路径移除（如 stop_local_llm 并发调用）
            };
            if exited {
                // 进程已退出：从 map 移除并返回崩溃错误
                if let Some(mut p) = st.running.remove(&params.model_id) {
                    let _ = p.child.wait();
                }
                drop(st);
                return Err(format!(
                    "模型 {mid} 启动后立即退出（可能模型损坏、显存不足或参数不兼容）。{logs}",
                    mid = params.model_id,
                    logs = format_recent(&logs_for_diag)
                ));
            }
        }
        match health_check(port) {
            Ok(true) => {
                return Ok(StartResult {
                    port,
                    pid,
                    base_url: format!("http://127.0.0.1:{port}"),
                });
            }
            Ok(false) => {
                // 还没就绪，继续等
                std::thread::sleep(Duration::from_millis(HEALTH_POLL_MS));
            }
            Err(e) => {
                last_err = e;
                std::thread::sleep(Duration::from_millis(HEALTH_POLL_MS));
            }
        }
    }

    // 超时：先取日志（cleanup_failed 会移走 logs 所有权），再 kill + 清理
    let logs_str = format_recent(&logs_for_diag);
    cleanup_failed(&params.model_id, "模型加载超时");
    Err(format!(
        "模型加载超时（{sec}秒内 /health 未就绪）。{err}\n{logs}",
        sec = LOAD_TIMEOUT_SECS,
        err = if last_err.is_empty() {
            String::new()
        } else {
            format!("最后错误：{last_err}。")
        },
        logs = logs_str
    ))
}

/// 停止 MOMO 启动的某个模型进程（只按 modelId 查 map，不影响外部进程）
#[tauri::command]
pub fn stop_local_llm(model_id: String) -> Result<(), String> {
    let mut st = STATE.lock().map_err(|e| format!("状态锁失败：{e}"))?;
    if let Some(mut p) = st.running.remove(&model_id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    Ok(())
}

/// 查询所有 MOMO 管理的本地模型进程状态
#[tauri::command]
pub fn get_local_llm_status() -> Result<Vec<RunningInfo>, String> {
    let mut st = STATE.lock().map_err(|e| format!("状态锁失败：{e}"))?;
    let mut out: Vec<RunningInfo> = Vec::new();
    // 顺便回收已退出的子进程
    st.running.retain(|_id, p| {
        match p.child.try_wait() {
            Ok(None) => true, // 仍活着
            _ => false,       // 已退出，从 map 移除
        }
    });
    for p in st.running.values() {
        out.push(RunningInfo {
            model_id: p.model_id.clone(),
            model_name: p.model_name.clone(),
            running: true,
            port: Some(p.port),
            pid: Some(p.pid),
            started_at: Some(p.started_at),
        });
    }
    Ok(out)
}

/// 取某模型的日志缓冲
#[tauri::command]
pub fn get_local_llm_logs(model_id: String) -> Result<LogsResult, String> {
    let st = STATE.lock().map_err(|e| format!("状态锁失败：{e}"))?;
    if let Some(p) = st.running.get(&model_id) {
        let lines = p
            .logs
            .lock()
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default();
        return Ok(LogsResult { lines });
    }
    Ok(LogsResult { lines: vec![] })
}

/// 停掉所有 MOMO 启动的进程（应用退出时调）
pub fn stop_all() {
    if let Ok(mut st) = STATE.lock() {
        for (_, mut p) in st.running.drain() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

// ============================ 辅助 ============================

fn llama_server_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &["llama-server.exe", "llama_server.exe"]
    }
    #[cfg(not(windows))]
    {
        &["llama-server", "llama_server"]
    }
}

fn try_executable(path: &str) -> Option<String> {
    // 尝试 --version，新版 llama-server 支持
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Ok(out) = cmd.output() {
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        // 退出码 0，或输出含 llama-server / version 关键字
        if out.status.success() || combined.to_lowercase().contains("llama-server") {
            // 提取第一行版本
            return Some(combined.lines().next().unwrap_or("").trim().to_string());
        }
        // 有些旧版本 --version 不识别会返回错误码 + help 文本
        if combined.to_lowercase().contains("llama-server") || combined.contains("usage:") {
            return Some(combined.lines().next().unwrap_or("").trim().to_string());
        }
    }
    None
}

fn is_in_path(name: &str) -> bool {
    // 简单判定：不含路径分隔符说明是 PATH 查找
    !name.contains('/') && !name.contains('\\')
}

fn appdata_tools_dir() -> Option<std::path::PathBuf> {
    // 优先 MOMO 自己的 AppData，回退通用 LocalAppData
    if let Ok(env) = std::env::var("LOCALAPPDATA") {
        let p = std::path::PathBuf::from(env);
        // MOMO 的 AppData 在 site.jinpengi.momo
        let momo = p.join("site.jinpengi.momo").join("tools");
        if momo.exists() {
            return Some(momo);
        }
        // 也看通用的 tools 目录
        let generic = p.join("momo-tools");
        if generic.exists() {
            return Some(generic);
        }
        // 都不存在时返回 LocalAppData，让上游创建
        return Some(p);
    }
    None
}

fn pick_port(prefer: u16) -> Result<u16, String> {
    let mut p = prefer;
    loop {
        // 用 bind 探测空闲（bind 后立即释放，给 llama-server 用）
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", p)) {
            drop(listener);
            // 给系统一点时间真正释放 socket
            std::thread::sleep(Duration::from_millis(20));
            return Ok(p);
        }
        p += 1;
        if p > PORT_MAX {
            return Err(format!(
                "没有可用端口（{start}-{end} 全被占用）",
                start = prefer,
                end = PORT_MAX
            ));
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 把子进程输出逐行抽进日志环形缓冲。
/// carry 有 64KB 上限：极端情况（无换行的超长输出，如二进制垃圾）强制 flush 避免内存无限增长。
fn pump_logs<R: Read>(mut r: R, buf: std::sync::Arc<Mutex<LogBuf>>, model_id: &str, tag: &str) {
    const CARRY_MAX: usize = 64 * 1024;
    let mut chunk = [0u8; 4096];
    let mut carry = String::new();
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => {
                carry.push_str(&String::from_utf8_lossy(&chunk[..n]));
                while let Some(idx) = carry.find('\n') {
                    let line: String = carry.drain(..=idx).collect();
                    let trimmed = line.trim_end_matches(['\n', '\r']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(mut b) = buf.lock() {
                        if b.len() >= LOG_MAX {
                            b.pop_front();
                        }
                        b.push_back(format!("[{tag}] {trimmed}"));
                    }
                }
                // #9 修复：carry 超上限时强制截断 flush（避免无换行的超长输出导致内存增长）
                if carry.len() > CARRY_MAX {
                    let flushed: String = carry.drain(..).collect();
                    if let Ok(mut b) = buf.lock() {
                        if b.len() >= LOG_MAX {
                            b.pop_front();
                        }
                        b.push_back(format!("[{tag}] {}…（超长行已截断）", flushed.chars().take(CARRY_MAX).collect::<String>()));
                    }
                }
            }
            Err(_) => break,
        }
    }
    // 收尾：把残留的不完整行也记上
    if !carry.trim().is_empty() {
        if let Ok(mut b) = buf.lock() {
            if b.len() >= LOG_MAX {
                b.pop_front();
            }
            b.push_back(format!("[{tag}] {}", carry.trim()));
        }
    }
    let _ = model_id; // 仅用于诊断，暂不输出
}

fn format_recent(buf: &std::sync::Arc<Mutex<LogBuf>>) -> String {
    // 取最后 20 条日志（倒序遍历再翻转，保持原始时间顺序）
    let lines: Vec<String> = buf
        .lock()
        .map(|b| {
            let tail: Vec<String> = b.iter().rev().take(20).cloned().collect();
            tail.into_iter().rev().collect()
        })
        .unwrap_or_default();
    if lines.is_empty() {
        String::from("（暂无日志输出）")
    } else {
        format!("最近日志：\n{}", lines.join("\n"))
    }
}

/// 清理 starting 标记（start_local_llm 的失败路径用）
fn clear_starting(model_id: &str) {
    if let Ok(mut st) = STATE.lock() {
        st.starting.remove(model_id);
    }
}

/// 失败清理：kill + 从 map 移除 + 清理 starting 标记
fn cleanup_failed(model_id: &str, reason: &str) {
    if let Ok(mut st) = STATE.lock() {
        st.starting.remove(model_id);
        if let Some(mut p) = st.running.remove(model_id) {
            let _ = p.child.kill();
            let _ = p.child.wait();
            // 把失败原因也写进日志缓冲
            if let Ok(mut b) = p.logs.lock() {
                if b.len() >= LOG_MAX {
                    b.pop_front();
                }
                b.push_back(format!("[momo] 启动失败：{reason}"));
            }
        }
    }
}

/// 用原生 TCP 做一次 `GET /health`，返回 true 表示 200。
fn health_check(port: u16) -> Result<bool, String> {
    let addr = format!("127.0.0.1:{port}");
    // 建连（带超时）
    let stream = TcpStream::connect_timeout(
        &addr
            .parse()
            .map_err(|e| format!("地址解析失败 {addr}: {e}"))?,
        Duration::from_millis(HEALTH_CONN_TIMEOUT_MS),
    )
    .map_err(|e| format!("连接 {addr} 失败：{e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(HEALTH_CONN_TIMEOUT_MS)))
        .ok();
    let mut stream = stream;
    // 发最简请求
    let req = b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    stream
        .write_all(req)
        .map_err(|e| format!("写入请求失败：{e}"))?;
    let mut resp = Vec::with_capacity(256);
    stream
        .read_to_end(&mut resp)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    let text = String::from_utf8_lossy(&resp);
    // 取第一行：HTTP/1.0 200 OK
    let first = text.lines().next().unwrap_or("");
    if first.contains(" 200 ") || first.ends_with(" 200") {
        Ok(true)
    } else if first.starts_with("HTTP/") {
        // 非 200：拼上状态行让上层判断
        Err(format!("health 返回：{first}"))
    } else {
        Err("health 响应非 HTTP".into())
    }
}
