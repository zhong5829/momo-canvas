//! 模型 Session 缓存（文档 §21.5 显存生命周期）：GPU 模型串行加载、常驻 ≤2、可选模型用后即放。
//!
//! - `get_or_load(path)` 按路径复用 `Arc<Mutex<Session>>`：同一模型同一时刻只有一个 tile 流在跑
//!   （Mutex 粒度 = 整个 tiled 推理段，并发任务在锁上排队，避免双份显存）。
//! - LRU 淘汰只移除缓存句柄；正在使用中的 Arc 由任务侧继续持有，不影响在途推理。
//! - 可选模型（GFPGAN/CodeFormer 等 ~350MB）用完必须 `release(path)`。
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use ort::{ep, session::Session};

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

static ENV_DONE: OnceLock<()> = OnceLock::new();
/// ort 环境初始化（只一次）：DirectML device 0（5090 sm_120 无 CUDA kernel，DX12 是唯一稳路）。
pub fn ensure_env() {
    ENV_DONE.get_or_init(|| {
        let _ = ort::init()
            .with_execution_providers([ep::DirectML::default().with_device_id(0).build()])
            .commit();
    });
}

/// 常驻上限（文档 §21.5：同时常驻不超过两个模型；优先保留当前主模型）
const MAX_RESIDENT: usize = 2;

pub struct SessionCache {
    cap: usize,
    map: HashMap<String, Arc<Mutex<Session>>>,
    /// 访问顺序（尾 = 最近用）
    lru: Vec<String>,
}

impl SessionCache {
    fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            map: HashMap::new(),
            lru: Vec::new(),
        }
    }

    pub fn get_or_load(&mut self, path: &str) -> Result<Arc<Mutex<Session>>, String> {
        if let Some(s) = self.map.get(path) {
            let hit = s.clone();
            self.touch(path);
            return Ok(hit);
        }
        ensure_env();
        let session = Session::builder()
            .map_err(es)?
            .with_intra_threads(1)
            .map_err(es)?
            .commit_from_file(path)
            .map_err(|e| format!("加载模型失败 {}：{}", path, e))?;
        // 先淘汰到 cap-1 再插入（淘汰只丢缓存句柄，在途任务持有的 Arc 不受影响）
        while self.lru.len() >= self.cap {
            let oldest = self.lru.remove(0);
            self.map.remove(&oldest);
        }
        let arc = Arc::new(Mutex::new(session));
        self.map.insert(path.to_string(), arc.clone());
        self.lru.push(path.to_string());
        Ok(arc)
    }

    /// 可选模型用后即放（文档：可选模型空闲后释放）
    pub fn release(&mut self, path: &str) {
        self.map.remove(path);
        self.lru.retain(|p| p != path);
    }

    fn touch(&mut self, path: &str) {
        self.lru.retain(|p| p != path);
        self.lru.push(path.to_string());
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

static CACHE: OnceLock<Mutex<SessionCache>> = OnceLock::new();
fn global() -> &'static Mutex<SessionCache> {
    CACHE.get_or_init(|| Mutex::new(SessionCache::new(MAX_RESIDENT)))
}

pub fn get_or_load(path: &str) -> Result<Arc<Mutex<Session>>, String> {
    global().lock().unwrap().get_or_load(path)
}

pub fn release(path: &str) {
    global().lock().unwrap().release(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(p: &str) -> String {
        format!("{}/../models/sr/{}", env!("CARGO_MANIFEST_DIR"), p)
    }

    #[test]
    fn cache_hit_returns_same_arc() {
        let mut c = SessionCache::new(2);
        let p = model("4x-UltraSharpV2_Lite_fp32_op17.onnx");
        assert!(std::path::Path::new(&p).exists(), "测试模型缺失");
        let a = c.get_or_load(&p).unwrap();
        let b = c.get_or_load(&p).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "同路径应命中同一 Session");
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn lru_evicts_oldest_beyond_cap() {
        let mut c = SessionCache::new(1); // cap=1 强制淘汰
        let p1 = model("4x-UltraSharpV2_Lite_fp32_op17.onnx");
        let p2 = model("4xNomosWebPhoto_esrgan_fp32_opset17.onnx");
        let a = c.get_or_load(&p1).unwrap();
        let _b = c.get_or_load(&p2).unwrap(); // p1 被淘汰
        assert_eq!(c.len(), 1);
        let a2 = c.get_or_load(&p1).unwrap(); // 重新加载 → 新 Arc
        assert!(!Arc::ptr_eq(&a, &a2), "被淘汰后应是新 Session");
        drop(a);
    }

    #[test]
    fn release_removes_entry() {
        let mut c = SessionCache::new(2);
        let p = model("4x-UltraSharpV2_Lite_fp32_op17.onnx");
        let a = c.get_or_load(&p).unwrap();
        c.release(&p);
        assert_eq!(c.len(), 0);
        let b = c.get_or_load(&p).unwrap();
        assert!(!Arc::ptr_eq(&a, &b));
    }
}
