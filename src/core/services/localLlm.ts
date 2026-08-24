/**
 * 本地 LLM 服务封装 — 前端 invoke + /health 轮询 + 对话前的「确保运行」
 *
 * 职责（§5 / §7）：
 *  - 封装 Rust 命令：detect / setPath / start / stop / status / logs
 *  - ensureRunning(card)：对话前确保 llama-server 已就绪，返回 baseUrl
 *  - ensureRunningById(modelId)：按本地模型 ID 启动（虚拟服务商注入的复合键）
 *  - 浏览器预览模式：所有 invoke 都抛「仅桌面版支持」，不白屏
 *
 * 安全约定（§12）：
 *  - 所有路径校验走 Rust 的 start_local_llm（结构化参数，绝不字符串拼接）
 *  - 端口只绑 127.0.0.1（Rust 层硬编码）
 *  - 只停 MOMO 自己启动的进程（按 modelId 查 Rust running map）
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../utils";
import { useLocalGguf } from "../stores/localGgufStore";
import { useSettings } from "../stores/settingsStore";
import { xfetch } from "./http";
import type { LocalGgufModel, LocalLlmStatus } from "../types";

// ============================ Rust 命令类型 ============================

/** start_local_llm 的参数（前端 camelCase，Rust 自动转 snake_case） */
type StartParams = {
  modelId: string;
  modelName: string;
  executablePath: string;
  ggufPath: string;
  mmprojPath?: string;
  contextSize: number;
  gpuLayers: "auto" | number;
  reasoningMode: "auto" | "on" | "off";
  port?: number;
};

type StartResult = { port: number; pid: number; baseUrl: string };
type ExecInfo = { path: string | null; version: string | null };
type LogsResult = { lines: string[] };

// ============================ 对外 API ============================

/** 虚拟服务商 id 前缀（与 settingsStore 的注入逻辑约定） */
export const LOCAL_GGUF_PROVIDER_ID = "local-gguf";

/**
 * 探测 llama-server 可执行文件。
 * @param customPath 用户在设置里手动指定的路径（优先级最高）
 * @returns 探测到的路径 + 版本；找不到返回 { path: null }
 */
export async function detectLlamaServer(customPath?: string): Promise<ExecInfo> {
  if (!isTauri) return { path: null, version: null };
  const searchPaths: string[] = [];
  if (customPath) searchPaths.push(customPath);
  // 也带上 store 里记录的全局路径
  const stored = useSettings.getState().settings.localLlm?.executablePath;
  if (stored && stored !== customPath) searchPaths.push(stored);
  return invoke<ExecInfo>("detect_llama_server", { searchPaths });
}

/** 用户手动选定 llama-server 路径时验证 + 记录 */
export async function setLlamaServerPath(path: string): Promise<ExecInfo> {
  if (!isTauri) throw new Error("仅桌面版支持配置本地模型引擎");
  return invoke<ExecInfo>("set_llama_server_path", { path });
}

/** 启动某个本地模型 */
export async function startModel(model: LocalGgufModel): Promise<StartResult> {
  if (!isTauri) throw new Error("仅桌面版支持启动本地模型");
  const executablePath = resolveExecutablePath(model);
  if (!executablePath) {
    throw new Error("未配置 llama-server。请在「设置 → 本地模型引擎」选择 llama-server.exe");
  }
  const params: StartParams = {
    modelId: model.id,
    modelName: model.name,
    executablePath,
    ggufPath: model.ggufPath,
    mmprojPath: model.mmprojPath,
    contextSize: model.contextSize,
    gpuLayers: model.gpuLayers,
    reasoningMode: model.reasoningMode,
    port: model.port,
  };
  const result = await invoke<StartResult>("start_local_llm", { params });
  // 记录上次端口 + 可执行文件路径，下次优先复用
  useLocalGguf.getState().updateModel(model.id, {
    port: result.port,
    executablePath,
  });
  return result;
}

/** 停止某个本地模型（只停 MOMO 启动的） */
export async function stopModel(modelId: string): Promise<void> {
  if (!isTauri) return;
  await invoke<void>("stop_local_llm", { modelId });
}

/** 查询所有 MOMO 管理的本地模型进程状态 */
export async function getStatus(): Promise<LocalLlmStatus[]> {
  if (!isTauri) return [];
  return invoke<LocalLlmStatus[]>("get_local_llm_status");
}

/** 取某模型的启动日志 */
export async function getLogs(modelId: string): Promise<string[]> {
  if (!isTauri) return [];
  const r = await invoke<LogsResult>("get_local_llm_logs", { modelId });
  return r.lines;
}

/**
 * 对话前的「确保运行」：按本地模型 ID 启动 llama-server 并等待就绪。
 * 返回 OpenAI 兼容的 baseUrl（如 http://127.0.0.1:18001）。
 *
 * 幂等：同一模型已运行则直接返回（Rust 层处理）。
 */
export async function ensureRunningById(modelId: string): Promise<string> {
  if (!isTauri) throw new Error("仅桌面版支持运行本地 GGUF 模型");
  const model = useLocalGguf.getState().getById(modelId);
  if (!model) throw new Error(`本地模型不存在：${modelId}`);
  // 文件存在性校验（fs.exists）
  const exists = await ggufExists(model.ggufPath);
  if (!exists) {
    throw new Error(`模型文件已移动或删除：${model.ggufPath}`);
  }
  const result = await startModel(model);
  return result.baseUrl;
}

/**
 * 对话前的「确保运行」：从 ModelCard 解析出本地模型 ID 后启动。
 *
 * 虚拟服务商注入的 card：id = "local-gguf"（固定，无 model 后缀），model = 本地模型名。
 * 所以这里总是用 card.model 按 name 查 localGgufStore（getByName）。
 * 找不到时说明模型被重命名/删除，抛清晰错误（不要用 card.id 兜底，它不是 modelId）。
 */
export async function ensureRunningFromCard(card: { id: string; model: string }): Promise<string> {
  const byName = useLocalGguf.getState().getByName(card.model);
  if (byName) return ensureRunningById(byName.id);
  throw new Error(
    `本地模型「${card.model}」已不存在（可能被重命名或删除）。请到「设置 → 添加本地 GGUF」重新添加，或在节点上重新选择模型。`,
  );
}

/**
 * 直接用 xfetch 测一次 /health（前端诊断用，启动逻辑已在 Rust 层完成）
 */
export async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await xfetch(`${baseUrl}/health`, { method: "GET" });
    return resp.ok;
  } catch {
    return false;
  }
}

/** 是否是本地 GGUF 模型卡（虚拟服务商注入的标志） */
export function isLocalGgufCard(card: { id: string; protocol?: string }): boolean {
  return card.id.startsWith(LOCAL_GGUF_PROVIDER_ID) || card.protocol === "llamacpp";
}

// ============================ 内部辅助 ============================

/** 解析某模型用的 llama-server 路径：模型自带 > 全局设置 */
function resolveExecutablePath(model: LocalGgufModel): string | undefined {
  return model.executablePath || useSettings.getState().settings.localLlm?.executablePath;
}

/** 检查 GGUF 文件是否还存在（浏览器预览模式总是返回 true，避免误报） */
async function ggufExists(path: string): Promise<boolean> {
  if (!isTauri) return true;
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch {
    return true; // 权限失败时放行，让 Rust 层做最终校验
  }
}
