//! 桌面快捷方式创建（便携版首次启动时由前端调用）。
//!
//! 实现方式：Windows COM IShellLink + IPersistFile 直接生成 .lnk 文件，
//! 不经过 PowerShell / cmd（符合本项目「不通过 shell 字符串执行命令」的安全约定）。
//! 桌面路径用 SHGetKnownFolderPath(FOLDERID_Desktop) 获取，
//! 可正确处理 OneDrive 桌面重定向等非默认桌面位置。
//!
//! 目标固定为当前运行的 exe（便携版主程序），工作目录 = exe 所在目录
//! （便携版必须保证 models/ 相对路径可用）。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutResult {
    /// 本次是否真的创建了（false = 已存在同名快捷方式，跳过）
    pub created: bool,
    /// 快捷方式完整路径
    pub path: String,
}

/// 创建指向当前 exe 的桌面快捷方式。仅 Windows；其他平台返回中文错误。
#[tauri::command]
pub fn create_desktop_shortcut(name: String) -> Result<ShortcutResult, String> {
    #[cfg(windows)]
    {
        create_shortcut_win(&name)
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        Err("桌面快捷方式仅支持 Windows 平台".into())
    }
}

#[cfg(windows)]
fn create_shortcut_win(name: &str) -> Result<ShortcutResult, String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, IShellLinkW, ShellLink, SHGetKnownFolderPath,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // 名称去非法字符（文件名不允许的字符替换掉），防止用户可见名写出非法 .lnk 文件名
    let safe_name: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();
    let safe_name = if safe_name.trim().is_empty() {
        "MOMO".to_string()
    } else {
        safe_name
    };

    let exe = std::env::current_exe().map_err(|e| format!("获取程序路径失败：{e}"))?;
    let work_dir = exe
        .parent()
        .ok_or("无法确定程序所在目录")?
        .to_string_lossy()
        .into_owned();

    unsafe {
        // COM 初始化（本命令线程独立初始化；已初始化时 S_FALSE 也算成功，不视为错误）
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() {
            return Err(format!("COM 初始化失败：{hr}"));
        }

        // 拿真实桌面目录（含 OneDrive 重定向）
        let desktop_pw = SHGetKnownFolderPath(&FOLDERID_Desktop, Default::default(), None)
            .map_err(|e| format!("获取桌面路径失败：{e}"))?;
        let desktop = PCWSTR(desktop_pw.0)
            .to_string()
            .map_err(|e| format!("桌面路径转换失败：{e}"))?;
        CoTaskMemFree(Some(desktop_pw.0 as _));

        let lnk_path = format!("{desktop}\\{safe_name}.lnk");
        // 已存在就不重复创建（用户删了快捷方式但 localStorage 标记还在的场景之外，
        // 每次启动都会先走到这里检查文件，存在即跳过，不会反复打扰）
        if std::path::Path::new(&lnk_path).exists() {
            CoUninitialize();
            return Ok(ShortcutResult {
                created: false,
                path: lnk_path,
            });
        }

        let exe_w = to_wide(exe.to_string_lossy().as_ref());
        let dir_w = to_wide(&work_dir);
        let desc_w = to_wide("MOMO 智能画布（便携版）");
        let lnk_w = to_wide(&lnk_path);

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建 COM 对象失败：{e}"))?;
        link.SetPath(PCWSTR(exe_w.as_ptr()))
            .map_err(|e| format!("设置目标失败：{e}"))?;
        link.SetWorkingDirectory(PCWSTR(dir_w.as_ptr()))
            .map_err(|e| format!("设置工作目录失败：{e}"))?;
        link.SetDescription(PCWSTR(desc_w.as_ptr()))
            .map_err(|e| format!("设置描述失败：{e}"))?;
        let _ = link.SetShowCmd(SW_SHOWNORMAL);

        // IShellLinkW → IPersistFile 接口转换后落盘为 .lnk
        let persist = link
            .cast::<windows::Win32::System::Com::IPersistFile>()
            .map_err(|e| format!("转换持久化接口失败：{e}"))?;
        persist
            .Save(PCWSTR(lnk_w.as_ptr()), true)
            .map_err(|e| format!("写入快捷方式失败：{e}（桌面可能被安全软件拦截）"))?;

        CoUninitialize();
        Ok(ShortcutResult {
            created: true,
            path: lnk_path,
        })
    }
}

/// &str → 以 NUL 结尾的 UTF-16（COM PCWSTR 需要）
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
