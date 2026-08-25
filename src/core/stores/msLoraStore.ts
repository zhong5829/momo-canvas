/**
 * ModelScope LoRA 注册表 Store — 独立持久化到 ms-loras.json
 *
 * 设计：
 *  - 独立于 Settings（不污染 settings.json 迁移链），参照 localGgufStore 同款模式
 *  - 空列表起步：用户自行添加（名称 / LoRA id / 绑定模型 / 默认强度）
 *  - 画布「ModelScope 生图」节点按 targetModel 自动筛选可用 LoRA
 *  - 持久化用 loadJSON/saveJSON + 序号守卫（与 localGgufStore / directorStore 同款）
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import type { MsLora } from "../types";

type PersistShape = { msLoras: MsLora[]; schemaVersion: 1 };

/** 新增/编辑 LoRA 的入参（UI 表单填写） */
export type MsLoraInput = {
  id: string;
  name: string;
  targetModel: string;
  strength?: number;
  note?: string;
};

type MsLoraState = {
  msLoras: MsLora[];
  loaded: boolean;
  init: () => Promise<void>;
  addLora: (input: MsLoraInput) => void;
  updateLora: (id: string, patch: Partial<MsLora>) => void;
  removeLora: (id: string) => void;
  getById: (id: string) => MsLora | undefined;
};

let saveSeq = 0;
let initOnce: Promise<void> | null = null;

function persist(list: MsLora[]) {
  const mySeq = ++saveSeq;
  const data = { msLoras: list, schemaVersion: 1 } satisfies PersistShape;
  // 序号守卫：saveJSON 是异步的，高频调用时慢的旧快照不能覆盖新快照
  setTimeout(() => {
    if (mySeq !== saveSeq) return;
    void saveJSON("ms-loras.json", "v1", data);
  }, 0);
}

/** 读时归一化：补默认值（兼容老数据或部分字段缺失） */
function normalizeLora(m: Partial<MsLora>): MsLora {
  const now = Date.now();
  return {
    id: (m.id ?? "").trim(),
    name: m.name?.trim() || "未命名 LoRA",
    targetModel: (m.targetModel ?? "").trim(),
    strength: typeof m.strength === "number" ? Math.min(1, Math.max(0, m.strength)) : 0.8,
    enabled: m.enabled !== false,
    note: m.note,
    createdAt: m.createdAt ?? now,
    updatedAt: m.updatedAt ?? now,
  };
}

export const useMsLora = create<MsLoraState>((set, get) => ({
  msLoras: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>("ms-loras.json", "v1");
      const list = (saved?.msLoras ?? []).map(normalizeLora);
      set({ msLoras: list, loaded: true });
    })()),

  addLora: (input) => {
    const list = [...get().msLoras, normalizeLora({ ...input, enabled: true })];
    set({ msLoras: list });
    persist(list);
  },

  updateLora: (id, patch) => {
    const list = get().msLoras.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: Date.now() } : m));
    set({ msLoras: list });
    persist(list);
  },

  removeLora: (id) => {
    const list = get().msLoras.filter((m) => m.id !== id);
    set({ msLoras: list });
    persist(list);
  },

  getById: (id) => get().msLoras.find((m) => m.id === id),
}));
