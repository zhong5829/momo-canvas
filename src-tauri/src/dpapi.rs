//! DPAPI 本地加密 —— API Key 落盘保护。
//!
//! 用 Windows 用户级 DPAPI（CryptProtectData / CryptUnprotectData）加密敏感字符串，
//! 密文绑定当前 Windows 用户：换用户 / 换机器解不开，前端解密失败时回退并提示用户重填，
//! 不影响程序运行。密文以 hex 编码返回（不引入 base64 依赖）。
use windows::core::PCWSTR;
use windows::Win32::Foundation::LocalFree;
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("密文长度非法".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// 加密：明文 → hex 密文（USER 范围，仅本机本用户可解）
#[tauri::command]
pub fn dpapi_encrypt(s: String) -> Result<String, String> {
    let data = s.into_bytes();
    let mut in_blob = blob(&data);
    let mut out_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &mut in_blob,
            PCWSTR::null(),
            None,
            None,
            None,
            0,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI 加密失败：{e}"))?;
    }
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(Some(windows::Win32::Foundation::HLOCAL(out_blob.pbData as *mut core::ffi::c_void)));
    }
    Ok(hex_encode(&out))
}

/// 解密：hex 密文 → 明文
#[tauri::command]
pub fn dpapi_decrypt(s: String) -> Result<String, String> {
    let raw = hex_decode(&s)?;
    let mut in_blob = blob(&raw);
    let mut out_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &mut in_blob,
            None,
            None,
            None,
            None,
            0,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI 解密失败：{e}"))?;
    }
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(Some(windows::Win32::Foundation::HLOCAL(out_blob.pbData as *mut core::ffi::c_void)));
    }
    String::from_utf8(out).map_err(|e| format!("解密结果不是合法文本：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DPAPI 加解密往返：真实调 Windows CryptProtectData / CryptUnprotectData
    #[test]
    fn dpapi_roundtrip() {
        let plain = "sk-test-密钥-12345";
        let enc = dpapi_encrypt(plain.into()).expect("加密失败");
        assert_ne!(enc, plain, "密文不应等于明文");
        assert!(!enc.starts_with("dpapi:"), "返回的应是纯 hex");
        let dec = dpapi_decrypt(enc).expect("解密失败");
        assert_eq!(dec, plain, "解密结果应还原原文");
    }
}
