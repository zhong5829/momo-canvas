/**
 * 系统资源监控（画布右上角仪表盘）：CPU / 内存 / NVIDIA 显卡核心 / 显存占用。
 *
 * - CPU、内存走 sysinfo；CPU 占用率需要两次采样间隔，new() 里先预热一次，
 *   之后靠前端 2s 轮询天然拉开间隔。
 * - GPU 走 NVML（运行时加载 nvml.dll）：非 N 卡 / 驱动异常时全部字段降级 None，
 *   前端显示「--」，绝不影响画布。
 */
use std::sync::Mutex;

use nvml_wrapper::Nvml;
use serde::Serialize;
use sysinfo::System;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// CPU 总占用率，0-100
    cpu: f32,
    /// 已用内存（字节）
    mem_used: u64,
    /// 总内存（字节）
    mem_total: u64,
    /// 显卡型号（NVML 可用时）
    gpu_name: Option<String>,
    /// 显卡核心占用率，0-100
    gpu_util: Option<f32>,
    /// 已用显存（字节）
    vram_used: Option<u64>,
    /// 总显存（字节）
    vram_total: Option<u64>,
}

pub struct SysmonState {
    sys: Mutex<System>,
    nvml: Option<Nvml>,
}

impl SysmonState {
    pub fn new() -> Self {
        let mut sys = System::new();
        // CPU 占用率是两次采样的差值：先预热一轮，避免启动后第一次读数恒 0
        sys.refresh_cpu_usage();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            sys: Mutex::new(sys),
            nvml: Nvml::init().ok(),
        }
    }
}

#[tauri::command]
pub fn system_stats(state: tauri::State<SysmonState>) -> SystemStats {
    let (cpu, mem_used, mem_total) = {
        let mut sys = match state.sys.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (sys.global_cpu_usage(), sys.used_memory(), sys.total_memory())
    };

    let mut gpu_name = None;
    let mut gpu_util = None;
    let mut vram_used = None;
    let mut vram_total = None;
    if let Some(nvml) = &state.nvml {
        if let Ok(dev) = nvml.device_by_index(0) {
            gpu_name = dev.name().ok();
            if let Ok(u) = dev.utilization_rates() {
                gpu_util = Some(u.gpu as f32);
            }
            if let Ok(m) = dev.memory_info() {
                vram_used = Some(m.used);
                vram_total = Some(m.total);
            }
        }
    }

    SystemStats {
        cpu,
        mem_used,
        mem_total,
        gpu_name,
        gpu_util,
        vram_used,
        vram_total,
    }
}
