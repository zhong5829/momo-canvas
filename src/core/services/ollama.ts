/**
 * Ollama 本地模型服务 — 原生 API 适配（不走 OpenAI 兼容层）
 *  - 模型发现  GET  /api/tags          → { models: [{ name, details: { family, parameter_size, quantization_level } }] }
 *  - 对话流式  POST /api/chat           → NDJSON 流（每行 { message: { role, content }, done, thinking? }）
 *  - 显存释放  POST /api/chat keep_alive:0 → 请求完成后立即卸载模型
 *
 * 与 OpenAI 兼容层 /v1/chat/completions 的差异：
 *  - 原生协议能拿到 thinking 字段（Qwen3/DeepSeek-R1 等推理模型的思考链）
 *  - 能传 keep_alive 控制显存驻留（导演台跑 H3 前可释放 LLM 显存）
 *  - 模型列表 /api/tags 返回 details（大小、量化、架构），比 /v1/models 信息更全
 *  - 无需 API Key（Ollama 默认不鉴权）
 */
import type { ChatMsg, ModelCard } from "../types";
import { xfetch, trimBase } from "./http";

/** Ollama /api/tags 返回的单个模型条目（只取我们关心的字段） */
export type OllamaModelInfo = {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
};

/** Ollama 原生 base：去掉 /v1 后缀（Ollama 原生 API 不带 /v1） */
function ollamaBase(baseUrl: string): string {
  let b = trimBase(baseUrl);
  // 用户可能填了 http://127.0.0.1:11434/v1（从 OpenAI 兼容预设迁来），原生 API 要去掉 /v1
  b = b.replace(/\/v1\/?$/, "");
  return b;
}

/** 拉取 Ollama 本地已安装的模型列表 */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModelInfo[]> {
  const base = ollamaBase(baseUrl);
  const resp = await xfetch(`${base}/api/tags`, {});
  if (!resp.ok) throw new Error(`Ollama 模型列表拉取失败 ${resp.status}：请确认 Ollama 正在运行（${base}）`);
  const j = await resp.json();
  const arr: any[] = Array.isArray(j.models) ? j.models : [];
  return arr.map((m) => ({
    name: m.name ?? m.model ?? "",
    family: m.details?.family,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    sizeBytes: m.size,
  })).filter((m) => m.name);
}

/** 仅取模型名列表（供 modelList.ts 统一接口调用） */
export async function fetchOllamaModelNames(baseUrl: string): Promise<string[]> {
  const list = await listOllamaModels(baseUrl);
  const names = list.map((m) => m.name).filter(Boolean).sort();
  if (!names.length) throw new Error("Ollama 没有已安装的模型，请先用 `ollama pull <模型名>` 拉取");
  return names;
}

/** 释放 Ollama 显存：keep_alive:0 让模型在请求结束后立即卸载 */
export async function unloadOllamaModel(baseUrl: string, model: string): Promise<void> {
  const base = ollamaBase(baseUrl);
  try {
    await xfetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
    });
  } catch {
    /* 释放失败不阻塞主流程 */
  }
}

type OllamaStreamCallbacks = {
  onText?: (full: string, delta: string) => void;
  onReasoning?: (full: string, delta: string) => void;
  signal?: AbortSignal;
};

/** 把图片 dataURL 转成 Ollama 要的纯 base64（不带 data: 前缀） */
function dataUrlToB64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/**
 * Ollama 原生 /api/chat 流式对话。
 * NDJSON 流：每行一个 JSON，字段 { message: { role, content }, done, thinking? }。
 * Ollama 3.x+ 支持 images（base64 数组，不带 data: 前缀）和 thinking 字段。
 */
export async function streamOllamaChat(
  card: ModelCard,
  msgs: ChatMsg[],
  opts: OllamaStreamCallbacks & { system?: string; keepAlive?: number; think?: boolean },
): Promise<{ text: string; reasoning: string }> {
  const base = ollamaBase(card.baseUrl);
  // 构造 messages：system 可选 + 历史（含图片 base64）
  const apiMsgs: { role: string; content: string; images?: string[] }[] = [];
  if (opts.system) apiMsgs.push({ role: "system", content: opts.system });
  for (const m of msgs) {
    if (m.images?.length) {
      apiMsgs.push({ role: m.role, content: m.text, images: m.images.map(dataUrlToB64) });
    } else {
      apiMsgs.push({ role: m.role, content: m.text });
    }
  }

  const body: Record<string, unknown> = {
    model: card.model,
    messages: apiMsgs,
    stream: true,
  };
  // keep_alive 控制 GPU 驻留；默认不传（用 Ollama 默认 5 分钟），传 0 则用完即释放
  if (opts.keepAlive !== undefined) body.keep_alive = opts.keepAlive;
  // 思考开关：think:false 关闭推理模型的思考链（Qwen3 等支持；不支持的模型自动忽略该字段）
  if (opts.think === false) body.think = false;

  const resp = await xfetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Ollama 对话失败 ${resp.status}：${txt || "请确认模型已 pull（ollama run/pull）"}`);
  }
  if (!resp.body) throw new Error("Ollama 未返回流式响应");

  // NDJSON：逐行解析 JSON
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";

  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s) return;
    let j: any;
    try {
      j = JSON.parse(s);
    } catch {
      return; /* 忽略无法解析的行 */
    }
    // Ollama 3.x thinking 字段（推理模型的思考链）
    const thinkDelta: string = j.thinking ?? j.message?.thinking ?? "";
    const contentDelta: string = j.message?.content ?? "";
    if (thinkDelta) {
      reasoning += thinkDelta;
      opts.onReasoning?.(reasoning, thinkDelta);
    }
    if (contentDelta) {
      text += contentDelta;
      opts.onText?.(text, contentDelta);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf);

  return { text, reasoning };
}

/* ---------------- GGUF 导入辅助（方案 §21.4） ---------------- */

/** GGUF 文件头元数据（从文件名 + 大小推断，不解析二进制） */
export type GgufMeta = {
  filename: string;
  sizeBytes: number;
  sizeLabel: string; // 人类可读大小
  /** 从文件名推断的量化级别（Q4_K_M / Q8_0 等） */
  quant?: string;
  /** 从文件名推断的架构（qwen / llama / mistral 等） */
  arch?: string;
  /** 同目录可能配对的 mmproj 文件名 */
  mmprojCandidates?: string[];
};

/** 格式化文件大小 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

/** 从 GGUF 文件名推断量化级别和架构 */
function parseGgufFilename(filename: string): { quant?: string; arch?: string } {
  const base = filename.replace(/\.gguf$/i, "").toLowerCase();
  const quantMatch = base.match(/q[0-9]_[a-z_]+|q[0-9]+|iq[0-9_]+|f[0-9]+\.?[0-9]*|bpw/i);
  const archMatch = base.match(/qwen|llama|mistral|gemma|phi|deepseek|yi|command-?r|stablelm|orca|vicuna|dolphin/i);
  return { quant: quantMatch?.[0]?.toUpperCase(), arch: archMatch?.[0] };
}

/**
 * 分析一个 GGUF 文件：元数据 + 同目录 mmproj 候选。
 * 本函数不读文件二进制，只基于文件名和大小推断（精确架构需 ollama create 后测试）。
 */
export function analyzeGguf(file: { name: string; size: number }, siblingFiles?: string[]): GgufMeta {
  const { quant, arch } = parseGgufFilename(file.name);
  const mmprojCandidates = (siblingFiles ?? [])
    .filter((f) => /mmproj/i.test(f) && f !== file.name)
    .sort((a, b) => a.length - b.length); // 最短文件名优先（最可能配对）
  return {
    filename: file.name,
    sizeBytes: file.size,
    sizeLabel: formatBytes(file.size),
    quant,
    arch,
    mmprojCandidates,
  };
}

/** Modelfile 生成参数 */
export type ModelfileParams = {
  /** GGUF 文件路径（FROM 指令） */
  ggufPath: string;
  /** MOMO 显示名（ollama 模型名） */
  modelName: string;
  /** 可选 mmproj 文件路径（视觉模型） */
  mmprojPath?: string;
  /** 上下文窗口大小 */
  numCtx?: number;
  /** GPU 层数（-1 = 全部） */
  numGpu?: number;
  /** 是否启用 thinking（Qwen3/DeepSeek-R1 等） */
  think?: boolean;
  /** 系统提示词 */
  systemPrompt?: string;
};

/**
 * 生成 Ollama Modelfile 文本（方案 §21.4）。
 * 用户保存为 Modelfile 文件，然后执行 `ollama create <name> -f ./Modelfile`。
 *
 * 只使用合法的 Modelfile 指令（FROM / PARAMETER / SYSTEM / TEMPLATE / ADAPTER），
 * 不使用 /thinks 等非标准指令——thinking 控制由对话时的 prompt 或模型自身能力决定。
 */
export function generateModelfile(p: ModelfileParams): string {
  const lines: string[] = [`FROM ${p.ggufPath}`];
  // mmproj：Ollama 官方 Modelfile 无 PROJECTOR 指令，标记为实验性注释
  if (p.mmprojPath) {
    lines.push(`# 视觉投影文件（需手动用 llama-server 加载 --mmproj，Ollama 原生 Modelfile 不支持 PROJECTOR 指令）：`);
    lines.push(`# ${p.mmprojPath}`);
  }
  // PARAMETER num_ctx 是官方支持的合法指令
  if (p.numCtx) lines.push(`PARAMETER num_ctx ${p.numCtx}`);
  // num_gpu 不是官方 Modelfile 参数，去掉（GPU 层由 Ollama 自动分配）
  // SYSTEM 指令
  if (p.systemPrompt) {
    lines.push(`SYSTEM """${p.systemPrompt}"""`);
  }
  // think 关闭：通过 system prompt 提示，不用非法指令
  if (p.think === false) {
    lines.push(`# 已关闭 thinking：对支持 /no_think 的模型，Ollama 对话时会自动跳过思考`);
  }
  return lines.join("\n");
}

/**
 * 生成跨平台可用的导入步骤说明（Windows cmd/PowerShell + macOS/Linux bash 都能用）。
 * 不用 bash 进程替换 <(...)，改为建议用户先保存 Modelfile 文件再执行 ollama create。
 */
export function generateOllamaImportSteps(p: ModelfileParams): { modelfile: string; steps: string } {
  const modelfile = generateModelfile(p);
  const steps = [
    `1. 把上方 Modelfile 内容保存为文件 Modelfile（无扩展名）`,
    `2. 在 Modelfile 所在目录打开终端，执行：`,
    `   ollama create ${p.modelName} -f ./Modelfile`,
    `3. 用 ollama list 确认模型已注册`,
    `4. 回到 MOMO 设置页，在 Ollama 服务商卡片点「拉取模型」选中它`,
  ].join("\n");
  return { modelfile, steps };
}

