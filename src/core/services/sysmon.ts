/**
 * 系统资源监控（画布仪表盘）：invoke Rust 的 system_stats。
 * 浏览器预览模式 / invoke 失败一律返回 null —— 监控组件绝不影响画布。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../utils";

export type SystemStats = {
  /** CPU 总占用率 0-100 */
  cpu: number;
  /** 已用内存（字节） */
  memUsed: number;
  /** 总内存（字节） */
  memTotal: number;
  /** 显卡型号（非 N 卡为 null） */
  gpuName: string | null;
  /** 显卡核心占用率 0-100 */
  gpuUtil: number | null;
  /** 已用显存（字节） */
  vramUsed: number | null;
  /** 总显存（字节） */
  vramTotal: number | null;
};

export async function getSystemStats(): Promise<SystemStats | null> {
  if (!isTauri) return null;
  try {
    return await invoke<SystemStats>("system_stats");
  } catch {
    return null;
  }
}
