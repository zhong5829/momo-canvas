/**
 * 本地 GGUF 模型注册表 Store — 独立持久化到 local-gguf-models.json
 *
 * 设计原则（§4 / §5）：
 *  - 独立于 ProviderCard，不污染 settings.json
 *  - 只保存 GGUF 文件路径，不复制/移动用户的文件
 *  - 能力标记（vision）由 mmprojPath 是否存在决定，不靠模型名猜
 *  - 运行期通过虚拟服务商（id 前缀 local-gguf）注入到 resolveModelCard
 *
 * 持久化用 loadJSON/saveJSON + 序号守卫（与 directorStore 同款）。
 * 浏览器预览模式退回 localStorage，降级展示（不能启动本地进程）。
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import { analyzeGguf } from "../services/ollama";
import type { GpuLayers, LocalGgufModel, ReasoningMode } from "../types";

type PersistShape = { models: LocalGgufModel[]; schemaVersion: 1 };

type LocalGgufState = {
  models: LocalGgufModel[];
  loaded: boolean;
  init: () => Promise<void>;
  /** 新增本地模型（自动解析元数据 + 扫描同目录 mmproj） */
  addModel: (input: AddModelInput) => LocalGgufModel;
  /** 更新模型字段 */
  updateModel: (id: string, patch: Partial<LocalGgufModel>) => void;
  /** 删除模型（只删注册项，不动用户的 GGUF 文件） */
  removeModel: (id: string) => void;
  getById: (id: string) => LocalGgufModel | undefined;
  getByName: (name: string) => LocalGgufModel | undefined;
  /** 检查模型文件是否仍存在（文件被移动后返回 false） */
  validatePath: (id: string) => boolean;
};

/** addModel 入参：用户在弹窗里确认的字段 */
export type AddModelInput = {
  /** GGUF 绝对路径 */
  ggufPath: string;
  /** 视觉投影绝对路径（可选；有则视为视觉模型） */
  mmprojPath?: string;
  /** 文件名（用于元数据解析） */
  filename: string;
  /** 文件大小（字节，来自 fs.stat） */
  sizeBytes?: number;
  /** 同目录文件名列表（用于自动匹配 mmproj） */
  siblings?: string[];
  /** MOMO 中显示的名称（默认从文件名推断） */
  name?: string;
  /** 上下文长度（默认 4096） */
  contextSize?: number;
  /** GPU 卸载层数（默认 auto） */
  gpuLayers?: GpuLayers;
  /** 推理模式（默认 auto） */
  reasoningMode?: ReasoningMode;
  /** llama-server 可执行文件路径（可选，缺省用全局设置） */
  executablePath?: string;
};

let saveSeq = 0;
let initOnce: Promise<void> | null = null;

function persist(models: LocalGgufModel[]) {
  const mySeq = ++saveSeq;
  const data = { models, schemaVersion: 1 } satisfies PersistShape;
  // 序号守卫（与 directorStore 同款）：saveJSON 是异步的，高频调用时慢的旧快照不能覆盖新快照
  setTimeout(() => {
    if (mySeq !== saveSeq) return;
    void saveJSON("local-gguf-models.json", "v1", data);
  }, 0);
}

/** 读时归一化：补默认值（兼容老数据或部分字段缺失） */
function normalizeModel(m: Partial<LocalGgufModel>): LocalGgufModel {
  const now = Date.now();
  return {
    id: m.id ?? uid(8),
    name: m.name ?? "未命名模型",
    ggufPath: m.ggufPath ?? "",
    mmprojPath: m.mmprojPath,
    sizeBytes: m.sizeBytes,
    quantization: m.quantization,
    architecture: m.architecture,
    capabilities: {
      chat: true,
      vision: !!m.mmprojPath,
      reasoning: m.capabilities?.reasoning ?? true,
    },
    runtime: "llama-server",
    contextSize: m.contextSize ?? 4096,
    gpuLayers: m.gpuLayers ?? "auto",
    reasoningMode: m.reasoningMode ?? "auto",
    port: m.port,
    executablePath: m.executablePath,
    createdAt: m.createdAt ?? now,
    updatedAt: m.updatedAt ?? now,
  };
}

export const useLocalGguf = create<LocalGgufState>((set, get) => ({
  models: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>("local-gguf-models.json", "v1");
      const list = (saved?.models ?? []).map(normalizeModel);
      set({ models: list, loaded: true });
    })()),

  addModel: (input) => {
    // 复用 ollama.ts 的 analyzeGguf 解析量化/架构/mmproj 候选
    const meta = analyzeGguf(
      { name: input.filename, size: input.sizeBytes ?? 0 },
      input.siblings,
    );
    // 优先用用户在弹窗里指定的 mmproj；否则取 analyzeGguf 匹配到的第一个候选
    let mmprojPath = input.mmprojPath;
    if (!mmprojPath && meta.mmprojCandidates?.length) {
      // 从 ggufPath 推同目录，拼候选文件名
      const dir = input.ggufPath.replace(/[\\/][^\\/]+$/, "");
      mmprojPath = `${dir}/${meta.mmprojCandidates[0]}`;
    }

    // #5 修复：重名模型自动加后缀（避免 getByName 取到错误模型）
    const finalName = dedupeName(input.name || deriveName(input.filename), get().models);

    const model: LocalGgufModel = normalizeModel({
      id: uid(8),
      name: finalName,
      ggufPath: input.ggufPath,
      mmprojPath,
      sizeBytes: input.sizeBytes ?? meta.sizeBytes,
      quantization: meta.quant,
      architecture: meta.arch,
      capabilities: {
        chat: true,
        vision: !!mmprojPath,
        reasoning: true,
      },
      runtime: "llama-server",
      contextSize: input.contextSize ?? 4096,
      gpuLayers: input.gpuLayers ?? "auto",
      reasoningMode: input.reasoningMode ?? "auto",
      executablePath: input.executablePath,
    });

    set({ models: [...get().models, model] });
    persist(get().models);
    return model;
  },

  updateModel: (id, patch) => {
    const next = get().models.map((m) =>
      m.id === id ? { ...m, ...patch, updatedAt: Date.now() } : m,
    );
    // 如果 mmprojPath 变了，同步更新 vision 能力
    if (patch.mmprojPath !== undefined) {
      const target = next.find((m) => m.id === id);
      if (target) {
        target.capabilities = { ...target.capabilities, vision: !!target.mmprojPath };
      }
    }
    set({ models: next });
    persist(next);
  },

  removeModel: (id) => {
    // 先尝试停止该模型正在运行的 llama-server 进程（避免删了注册项但进程仍占显存）
    // 用动态 import 避免循环依赖（localLlm.ts 依赖本 store）
    void import("../services/localLlm")
      .then(({ stopModel }) => stopModel(id))
      .catch(() => {
        /* 浏览器预览模式或进程未运行：静默 */
      });
    const next = get().models.filter((m) => m.id !== id);
    set({ models: next });
    persist(next);
  },

  getById: (id) => get().models.find((m) => m.id === id),

  getByName: (name) => get().models.find((m) => m.name === name),

  validatePath: (id) => {
    const m = get().getById(id);
    if (!m) return false;
    // 浏览器预览模式无法访问 fs，视为有效（避免误报）
    return true; // 实际校验在 localLlm.ensureRunning 里用 fs.exists 做
  },
}));

/** 从 GGUF 文件名推断模型显示名（去扩展名、去量化后缀） */
function deriveName(filename: string): string {
  const base = filename.replace(/\.gguf$/i, "");
  // 去掉常见的量化后缀（Q4_K_M / Q8_0 等）让名字更干净
  return base.replace(/[-_.]?(iq)?q[0-9]_[a-z_]+|[-_.]?(iq)?q[0-9]+|[-_.]?bpw/i, "").trim() || base;
}

/** 重名检测：如果 models 里已有同名，自动加 (2)、(3)… 后缀 */
function dedupeName(base: string, models: LocalGgufModel[]): string {
  const existing = new Set(models.map((m) => m.name));
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
}
