/**
 * 轻量持久化适配层：
 * - Tauri 环境 → tauri-plugin-store（JSON 文件存 AppData）
 * - 纯浏览器预览 → localStorage 兜底
 */
import { isTauri } from "./utils";

type LazyStoreT = import("@tauri-apps/plugin-store").LazyStore;

const stores = new Map<string, LazyStoreT>();

async function getStore(file: string): Promise<LazyStoreT> {
  let s = stores.get(file);
  if (!s) {
    const { LazyStore } = await import("@tauri-apps/plugin-store");
    s = new LazyStore(file, { autoSave: false, defaults: {} });
    stores.set(file, s);
  }
  return s;
}

/** 读取结果：区分「文件不存在/没存过」（ok + null）与「读取失败」（!ok）——
 *  后者绝不能当成首次启动处理，否则随后的一次保存会把可能还能抢救的数据整份覆盖 */
export type LoadResult<T> = { ok: true; value: T | null } | { ok: false; reason: string };

export async function loadJSONChecked<T>(file: string, key: string): Promise<LoadResult<T>> {
  try {
    if (isTauri) {
      const s = await getStore(file);
      const v = await s.get<T>(key);
      return { ok: true, value: (v as T) ?? null };
    }
    const raw = localStorage.getItem(`momo:${file}:${key}`);
    return { ok: true, value: raw ? (JSON.parse(raw) as T) : null };
  } catch (e) {
    console.warn("[persist] load failed", file, key, e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadJSON<T>(file: string, key: string): Promise<T | null> {
  const r = await loadJSONChecked<T>(file, key);
  return r.ok ? r.value : null;
}

export async function saveJSON(file: string, key: string, value: unknown): Promise<void> {
  try {
    if (isTauri) {
      const s = await getStore(file);
      await s.set(key, value);
      await s.save();
      return;
    }
    localStorage.setItem(`momo:${file}:${key}`, JSON.stringify(value));
  } catch (e) {
    console.warn("[persist] save failed", file, key, e);
  }
}
