import type { Node } from "@xyflow/react";

/* ---------------- 节点 ---------------- */
export type NodeKind =
  | "image"
  | "video"
  | "audio"
  | "audioGen"
  | "videoDub"
  | "prompt"
  | "chat"
  | "imageGen"
  | "videoGen"
  | "comfy"
  | "llmText"
  | "combine"
  | "stylePreset"
  | "note"
  | "group"
  | "relight"
  | "multiAngle"
  | "charCard"
  | "storyboard"
  | "enhanceLocal"
  | "vectorize";

export type RunStatus = "idle" | "running" | "done" | "error";

export type SearchHit = { title: string; url: string; snippet: string };

export type ChatMsg = {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  reasoning?: string;
  sources?: SearchHit[];
};

/* ---------------- Agent 模式（侧边创作助手：聊天 / 搜索 → 抉择 → 生图/生视频） ---------------- */
export type AgentStepKind = "search" | "ask" | "image" | "video";

/** 一次工具调用的过程轨迹（展示在助手消息里） */
export type AgentStep = {
  id: string;
  kind: AgentStepKind;
  /** 展示文案，如「搜索：赛博朋克 参考」 */
  text: string;
  status: "running" | "done" | "error";
};

export type AgentResult = { kind: "image" | "video"; src: string; prompt?: string };

/** Agent 向用户发起的抉择（点选项或自由输入回答） */
export type AgentQuestion = { text: string; options: string[]; answer?: string };

export type AgentMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 用户附带的参考图（dataURL） */
  images?: string[];
  /** 助手消息的思考过程（聊天模式，可折叠展示） */
  reasoning?: string;
  /** 过程轨迹：搜索 / 提问 / 生成 */
  steps?: AgentStep[];
  question?: AgentQuestion;
  /** 生成结果（内联展示，同时已收录资产库） */
  results?: AgentResult[];
  /** 这条助手消息由哪种模式产生：决定用哪种气泡渲染，切换面板模式后历史不会变形/消失 */
  kind?: "chat" | "agent";
  time: number;
};

export type ImageData = {
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
};

/** 视频源节点：承载本地/生成的视频（对标图片节点）。src 在 Tauri 下为资产文件的 asset: URL（跨重启有效），浏览器预览为 blob URL（会话内有效） */
export type VideoData = {
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
  /** 时长（秒，导入时测得，供角标显示） */
  dur?: number;
};

/** 音频源节点：本地音频文件（配乐/配音/参考音频）。src 在 Tauri 下为资产文件的 asset: URL */
export type AudioData = {
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
  /** 时长（秒） */
  dur?: number;
};

/** 生成音频：TTS 朗读 / 音乐生成（音频模型角色；OpenAI /audio/speech 或自定义协议） */
export type AudioGenData = {
  status: RunStatus;
  error?: string;
  /** 朗读文本 / 音乐描述（留空自动取上游文本，含分镜台词） */
  text: string;
  /** 音色（openai 协议的 voice 字段，如 alloy；自定义协议用 {{voice}} 占位） */
  voice?: string;
  resultUrl?: string;
  progress?: string;
  modelId?: string;
  /** 由备用模型生成时记录其名（徽标展示） */
  fallbackModel?: string;
};

/** 视频配音：上游视频 + 音频 → 本地重编码，把音频混入/替换原声 */
export type VideoDubData = {
  status: RunStatus;
  error?: string;
  /** replace = 替换原声（默认）；mix = 与原声混合 */
  mode: "replace" | "mix";
  resultUrl?: string;
  progress?: string;
};

export type PromptData = {
  status: RunStatus;
  error?: string;
  text: string;
  optimizing?: boolean;
};

export type ChatData = {
  status: RunStatus;
  error?: string;
  messages: ChatMsg[];
  draft: string;
  webSearch: boolean;
  showThinking: boolean;
  modelId?: string;
};

export type ImageGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  /** 通用家族预设尺寸（"default" = 跟随服务商配置） */
  size: string;
  count: number;
  results: string[];
  picked: number;
  modelId?: string;
  /** 创意度 0-100（仅图生图生效）：低 = 忠于参考图微调；高 = 大胆重新演绎。50 = 不干预 */
  creativity?: number;
  /** Nano Banana：宽高比（auto/1:1/16:9…） */
  aspect?: string;
  /** Nano Banana：分辨率档（1K/2K/4K） */
  resolution?: string;
  /** GPT Image：质量（auto/high/medium/low） */
  quality?: string;
  /** GPT Image / 通用：自定义宽高（同时填写才生效） */
  width?: number;
  height?: number;
  /** 提示词语言：zh 原文直发（默认）/ en 生成前先译成英文 */
  lang?: "zh" | "en";
  /** 并行请求数 1-3：同参数同时发多条，结果合并到 results（中转站普遍支持并发） */
  parallel?: number;
  /** 随机种子：锁定后同提示词+同参数可复现；不填 = 每次随机（仅支持的家族生效，如 seedream/flux/qwen/万相） */
  seed?: number;
  /** 负向提示词：描述不想出现的内容（如"多余手指、文字、低质量"），支持的家族生效 */
  negative?: string;
  /** 由备用模型生成时记录其名（徽标展示）；undefined = 主模型生成 */
  fallbackModel?: string;
  /** 历次出图记录（最近 10 次） */
  history?: GenHistoryEntry[];
};

/** 超清放大（本地 DirectML 超分）节点数据 — 非破坏：输出是新资产，原图不动 */
export type EnhanceLocalData = {
  status: RunStatus;
  error?: string;
  /** 质量预设：极速(SPAN 单模型) / 海报·文化墙(Nomos+Lite 融合) / 专业印刷(保真融合+大重叠+无损容器) / 人像(RealPLKSR+人脸分支) */
  preset: "fast" | "balanced" | "professional" | "portrait";
  /** 目标长边：4k=3840 / 8k=7680 / 16k=15360；或自定义像素；或印刷物理尺寸(mm+DPI) */
  target: "4k" | "8k" | "16k" | { longEdge: number } | { mode: "print"; wMm: number; hMm: number; dpi: number };
  /** 本地模型注册表 id（留空 = 默认主模型） */
  modelId?: string;
  /** 输入 tile 边长（0 = 自动，按预设） */
  tileSize: number;
  /** 细节强度 0-100：0=自动（按内容模式查表），>0 手动覆盖双模型融合权重 detailWeight */
  detailStrength: number;
  /** 内容模式：决定细节模型融合权重查表行（面板「高级」里可调） */
  contentMode: "auto" | "photo" | "illustration" | "poster" | "portrait";
  /** 去压缩（1x-DeJPG 预处理）：auto=jpegScore>0.3 时自动跑；off=关闭；on=强制 */
  dejpeg?: "auto" | "on" | "off";
  /** 人脸处理：identity=原貌保护（默认，不生成五官）；faceup=FaceUpDAT ROI；gfpgan/codeformer=生成式修复 */
  faceRestore?: "identity" | "faceup" | "gfpgan" | "codeformer";
  /** 输出容器位深：8=普通；16=便于后续编辑的 16 位容器（模型源采样仍为 8 位，仅 PNG/TIFF 生效） */
  bitDepth?: 8 | 16;
  outputFormat: "png" | "jpeg" | "tiff";
  // 运行态（result:true 写回，不增 rev）
  progress?: string;
  progressPct?: number;
  /** 输出图（assetUrl，跨重启有效） */
  result?: string;
  resultW?: number;
  resultH?: number;
  elapsedMs?: number;
  tiles?: number;
  /** 实际推理 Tile（自动档可能因模型/显存回退而小于建议值） */
  tileSizeUsed?: number;
  /** 运行前保守显存估算，仅用于排期与风险提示 */
  estimatedVramMb?: number;
  /** 保真守卫评分：高清结果缩回源尺寸的一致性，0..100；不代表主观锐度 */
  fidelityScore?: number;
  /** 保真守卫后的源尺寸平均绝对误差，0..1 */
  sourceConsistencyMae?: number;
  /** 发生低频残差回投的源像素块比例，0..1 */
  correctedBlockRatio?: number;
  /** 候选细节因色偏/反相边缘/异常高频被明显削弱的比例，0..1 */
  rejectedCandidateRatio?: number;
  /** 生产质量门禁：通过可自动入库；警告/失败只保留节点结果，需人工确认后保存 */
  qualityGate?: "passed" | "warning" | "failed";
  /** 是否达到自动进入生产资产库的标准（当前要求保真分 >= 80 且缩回误差未增加） */
  productionReady?: boolean;
  /** 面向用户的质量门禁解释 */
  qualityMessage?: string;
  /** 是否由运行看门狗自动停止，而非用户主动取消 */
  timedOut?: boolean;
  report?: string;
  /** analysisMap JSON 资产路径（内容分析契约，供矢量化节点复用） */
  analysisMapPath?: string;
  /** vectorGuide PNG 资产路径（保结构引导图契约） */
  vectorGuidePath?: string;
};

/** 本地超清放大引擎设置（Settings 新增项；normalize 浅合并给老数据补默认） */
export type EnhanceCfg = {
  defaultTarget: "4k" | "8k" | "16k";
  tileSize: number;
  tileOverlap: number;
};

/** 智能矢量（本地 VTracer 位图→SVG）节点数据 — 非破坏：输出是新 SVG 资产 */
export type VectorizeData = {
  status: RunStatus;
  error?: string;
  /** VTracer 预设：自动 / 海报色块 / 插画漫画(锐角) / 黑白 / 照片 / 线稿 */
  preset: "auto" | "poster" | "comic" | "bw" | "photo" | "line-art";
  colorMode: "auto" | "color" | "binary";
  hierarchical: "stacked" | "cutout";
  /** 颜色精度 0=默认(随预设) / 1..10 */
  colorPrecision: number;
  /** 小碎片过滤 0=默认 */
  filterSpeckle: number;
  /** 路径坐标小数位 */
  pathPrecision: number;
  /** 几何图元识别：把圆/矩形/椭圆/圆角矩形拟合为图元，叠在 VTracer 结果上（打卡框/文化墙更干净） */
  geometry: boolean;
  /** 质量档：fast=单候选 / balanced=3 候选评分(默认) / high-fidelity=5 候选 / few-nodes=3 候选偏简化 */
  quality?: "fast" | "balanced" | "high-fidelity" | "few-nodes";
  // 运行态（result:true 写回，不增 rev）
  progress?: string;
  /** SVG 资产 assetUrl（预览/下游/拖出） */
  result?: string;
  /** SVG 文本（导出 AI/CDR/PDF 用，避免回读） */
  svg?: string;
  resultW?: number;
  resultH?: number;
  pathCount?: number;
  /** 重渲染质量门禁：true=可直接进入生产后期；false=建议人工复核/改用高保真档 */
  productionReady?: boolean;
  qualityScore?: number;
  report?: string;
};

/** 生成节点的「历次结果」条目：每次成功出图/出片时快照一份，可回溯「第 N 次那版最好」 */
export type GenHistoryEntry = {
  ts: number;
  prompt: string;
  modelId?: string;
  /** 当时参数快照（aspect/resolution/quality/seed/size/count/duration 等，按节点类型存） */
  params: Record<string, unknown>;
  /** 当时结果（图片 dataURL 列表 / 视频 URL 列表）；大图由 blobStore 自动外置，不内联 boards.json */
  results: string[];
};

export type VideoGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  resultUrl?: string;
  /** 并行生成的全部结果（resultUrl = resultUrls[picked]） */
  resultUrls?: string[];
  /** 当前选中的结果下标 */
  picked?: number;
  progress?: string;
  modelId?: string;
  /** 提示词语言：zh 原文直发（默认）/ en 生成前先译成英文 */
  lang?: "zh" | "en";
  /** 时长档（按模型家族枚举，如 "5" / "10"，videoMeta 定义） */
  duration?: string;
  /** 分辨率档（如 "720p" / "1080p"，按家族） */
  resolution?: string;
  /** 宽高比（如 "16:9"，按家族） */
  aspect?: string;
  /** 生成音频（支持的家族才显示） */
  audio?: boolean;
  /** 第二路上游图片作为尾帧（家族支持首尾帧时可开） */
  useTail?: boolean;
  /** 参考模式：frame = 首帧/尾帧（默认）；reference = 全部上游图作为角色/主体参考（家族支持时） */
  refMode?: "frame" | "reference";
  /** 并行请求数 1-3：同参数同时发多条，结果进 resultUrls 可切换 */
  parallel?: number;
  /** 由备用模型生成时记录其名（徽标展示） */
  fallbackModel?: string;
  /** 历次出片记录（最近 10 次） */
  history?: GenHistoryEntry[];
};

/** 分镜：故事/剧本 → 完善 → 按风格与定调拆分镜（带时间轴），每镜独立输出口接生成节点 */
export type StoryShot = {
  /** 时间段标注，如 "0-5秒" */
  time: string;
  /** 该镜的生图/生视频提示词（已织入风格与定调） */
  prompt: string;
  /** 台词/对白（可选，如 "橘猫：欢迎光临！"；输出时附在提示词后，支持音频的视频模型会说出来） */
  line?: string;
};
export type StoryboardData = {
  status: RunStatus;
  error?: string;
  /** 故事/剧本原文（留空自动取上游文本；长剧本会先分小节整理再拆分镜） */
  story: string;
  /** 完善后的故事（可手改；拆分镜时优先用它） */
  refined?: string;
  /** 分镜数量 */
  count: number;
  /** 每镜时长（秒），用于时间轴标注与视频节点对齐 */
  shotSec: number;
  /** 风格提示词（全片统一，织入每一镜） */
  style: string;
  /** 定调：色调/画风基调（油画、胶片…） */
  tone: string;
  shots: StoryShot[];
  progress?: string;
  chatModelId?: string;
};

export type ComfyData = {
  status: RunStatus;
  error?: string;
  templateId?: string;
  params: Record<string, string | number>;
  results: string[];
  picked: number;
  /** 工作流的文本输出（ShowText 等节点），多段用空行分隔 */
  textOut?: string;
  /** 工作流的视频输出（VHS 合成等，blob URL） */
  videoResults?: string[];
  /** 历次工作流运行记录（最近 10 次） */
  history?: GenHistoryEntry[];
  progress?: string;
  /** 实时进度百分比 0-100（WebSocket 可用时才有） */
  progressPct?: number;
};

/** 文本处理（融合原「反推描述」）：上游文本/图片 → LLM 加工 → 文本 */
/** cap* 三个操作消费上游图片，其余操作消费上游文本 */
export type LlmTextOp =
  | "optimize"
  | "zh2en"
  | "expand"
  | "shorten"
  | "custom"
  | "capPrompt"
  | "capDetail"
  | "capTags";
export type LlmTextData = {
  status: RunStatus;
  error?: string;
  op: LlmTextOp;
  custom: string;
  result: string;
  modelId?: string;
};

/** 拼接文本：多路上游文本合并输出 */
export type CombineData = {
  status: RunStatus;
  error?: string;
  separator: "comma" | "newline" | "space";
  extra: string;
};

/** 风格预设：内置提示词片段库，多选输出 */
export type StylePresetData = {
  status: RunStatus;
  error?: string;
  category: string;
  selected: string[];
};

/** 备注：画布便签，无端口 */
export type NoteData = {
  status: RunStatus;
  error?: string;
  text: string;
  color: "yellow" | "blue" | "pink" | "green";
  /** 锁定后不可拖动（默认关闭） */
  locked?: boolean;
};

/** 组（主节点）：把区域内节点打包，按位置顺序聚合成员的文本/图片输出 */
export type GroupData = {
  status: RunStatus;
  error?: string;
  title?: string;
};

/** 生成类编辑节点的输出模式：image = 生成并输出图片；prompt = 不出图，向下游输出构造好的提示词 */
export type OutMode = "image" | "prompt";

/** 打光：上游图片 → 按光源参数重新打光（图生图，内容不变只改光影） */
export type RelightData = {
  status: RunStatus;
  error?: string;
  /** 输出模式（默认 image） */
  outMode?: OutMode;
  /** 水平方位角：0 = 正前方（相机方向），负值偏左、正值偏右，±180 = 背后 */
  azimuth: number;
  /** 垂直仰角：正值从上方照射、负值从下方照射 */
  elevation: number;
  /** 亮度 0-100（50 = 正常曝光） */
  brightness: number;
  /** 光源颜色 hex；空 = 自然光不指定 */
  color: string;
  /** 轮廓光（rim light） */
  rim: boolean;
  /** 智能模式：让模型自行设计最佳打光方案（忽略方向/亮度/颜色） */
  smart: boolean;
  results: string[];
  picked: number;
  modelId?: string;
};

/** 多角度：上游图片 → 换机位重新取景（图生图，主体一致只改视角） */
export type AnglePreset = "custom" | "fisheye" | "dutch" | "topdown" | "lowangle" | "aerial" | "back";
export type MultiAngleData = {
  status: RunStatus;
  error?: string;
  /** 输出模式（默认 image） */
  outMode?: OutMode;
  preset: AnglePreset;
  /** 水平环绕角 -180..180（0 = 原机位，正值向右环绕） */
  yaw: number;
  /** 垂直俯仰 -60..60（正值俯拍、负值仰拍） */
  pitch: number;
  /** 景别 0-4：特写/近景/中景/全景/远景 */
  shot: number;
  results: string[];
  picked: number;
  modelId?: string;
};

/* ---------------- 角色卡 / 角色库 ---------------- */
/** 角色档案：视觉模型分析上传图片得出，或来自角色库预设 */
export type CharProfile = {
  name: string;
  nameEn?: string;
  age?: string;
  occupation?: string;
  intro: string;
  appearance: string[];
  outfit: string[];
  accessories?: string[];
  /** 配色（hex） */
  palette: string[];
  /** 气质关键词 */
  keywords: string[];
  /** 画风/氛围概述（各素材生成时保持统一） */
  artStyle?: string;
};

/** 设定卡整版的排版风格；auto = 模型按角色画风/气质自动匹配版面 */
export type CharCardStyle = "auto" | "clean" | "magazine" | "letter" | "dossier";
/** 角色卡可产出的素材种类（每张内容不堆砌：格子少、区域大，同主题可用「补一张」自动换组追加） */
export type CharDeliverable = "turnaround" | "closeup" | "expressions" | "poses" | "outfits" | "portrait" | "sheet";

export type CharCardData = {
  status: RunStatus;
  error?: string;
  progress?: string;
  /** 输出模式（默认 image）；prompt = 只分析出提示词，不调绘画模型 */
  outMode?: OutMode;
  /** 生图提示词语言 */
  lang: "zh" | "en";
  /** 设定卡整版排版风格 */
  style: CharCardStyle;
  /** 勾选要产出的素材 */
  deliverables: CharDeliverable[];
  /** 旧字段（已由 outMode 取代，读档兼容用） */
  genImages?: boolean;
  profile?: CharProfile;
  /** 每种素材的生图提示词（分析后可手动编辑） */
  prompts: Partial<Record<CharDeliverable, string>>;
  /** 每种素材的生成结果 */
  results: Partial<Record<CharDeliverable, string[]>>;
  /** 来自角色库预设时的预设名 */
  presetName?: string;
  chatModelId?: string;
  imageModelId?: string;
};

/* ---------------- 图片直接编辑（局部重绘 / 扩图 / 增强 / 尺寸 / 裁剪 → 作用于节点自身，见 core/nodeEdit.ts） ---------------- */

/** 重绘/扩图的模型通道：
 *  auto = GPT 家族走真蒙版、其余走指令式；mask = 强制真蒙版（images/edits 的 mask 参数，需中转站如实转发）；
 *  instruct = 强制指令式（发原图 + 红色标注图，走普通图生图通道，兼容性最好） */
export type EditChannel = "auto" | "mask" | "instruct";

/** 扩图方向幅度：每边扩展比例（0 = 不扩） */
export type OutpaintPads = { left: number; right: number; up: number; down: number };

/** 尺寸调整（直接编辑）参数：mp = 目标总像素（百万）· side = 单边定长 · scale = 倍率 */
export type ResizeParams = {
  mode: "mp" | "side" | "scale";
  /** mp 模式：目标总像素（单位百万，如 1 = 约 100 万像素） */
  mp: number;
  /** side 模式：参照边 + 目标边长（另一边按比例自动算） */
  sideRef: "long" | "short" | "width" | "height";
  sideLen: number;
  /** scale 模式：缩放百分比（100 = 原尺寸；>100 放大） */
  scalePct: number;
};

/** 高清增强（直接编辑）参数 */
export type EnhanceParams = {
  /** 放大倍率（2 / 4） */
  factor: number;
  /** 增强侧重：detail = 细节纹理；face = 人物面部；none = 纯放大不加戏 */
  focus: "detail" | "face" | "none";
};

export type AppNode = Node<Record<string, unknown>, NodeKind>;

/* 端口数据类型 */
export type PortType = "text" | "image" | "video" | "audio";

/* ---------------- 模型配置（服务商卡片） ---------------- */
/** asr = 语音识别（语音输入/通话模式用）；纯新增角色，旧配置里没有该键，加载时按未配置处理 */
export type ModelRole = "chat" | "image" | "video" | "audio" | "asr";

export type ChatProtocol = "openai" | "anthropic" | "gemini";
export type ImageProtocol = "openai" | "gemini";
export type VideoProtocol = "zhipu" | "siliconflow" | "openai";
export type AudioProtocol = "openai";
export type AsrProtocol = "openai";
export type AnyProtocol = ChatProtocol | ImageProtocol | VideoProtocol | AudioProtocol | AsrProtocol;
/** 协议标识：内置协议，或自定义协议 "custom:<id>"（协议执行器） */
export type ProtocolId = AnyProtocol | (string & {});

/** 服务商卡片里某一角色的模型槽位（models 为空 = 该角色未启用），同一用途可配置多个模型 */
export type RoleSlot = {
  protocol: ProtocolId;
  models: string[];
};

/** v3 单模型槽位旧结构，用于迁移 */
export type LegacyRoleSlotV3 = {
  protocol: AnyProtocol;
  model?: string;
  models?: string[];
  size?: string;
};

/** 一张服务商（中转站）卡片：共用 Base URL / API Key，可同时配置 对话 / 绘画 / 视频 3 套模型 */
export type ProviderCard = {
  id: string;
  /** 显示名，例如「中转A」「智谱官方」 */
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Partial<Record<ModelRole, RoleSlot>>;
};

/** 运行期扁平化的模型配置（由服务商卡片 + 角色解析而来，服务层直接消费） */
export type ModelCard = {
  id: string;
  role: ModelRole;
  name: string;
  protocol: ProtocolId;
  baseUrl: string;
  apiKey: string;
  model: string;
  size?: string;
};

export type ModelsCfg = {
  providers: ProviderCard[];
  /** 各角色默认模型，复合键「providerId::model」（旧数据可能只有 providerId，加载时会规整） */
  defaults: Partial<Record<ModelRole, string>>;
};

/** v2（按角色平铺多卡片）旧结构，用于迁移 */
export type LegacyModelsV2 = {
  cards: ModelCard[];
  defaults: Partial<Record<ModelRole, string>>;
};

export const ROLE_LABEL: Record<ModelRole, string> = {
  chat: "对话模型",
  image: "绘画模型",
  video: "视频模型",
  audio: "音频模型",
  asr: "语音识别",
};

export const PROTOCOLS: Record<ModelRole, { value: string; label: string }[]> = {
  chat: [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "anthropic", label: "Anthropic Claude" },
    { value: "gemini", label: "Google Gemini" },
  ],
  image: [
    { value: "openai", label: "OpenAI 兼容 (images API)" },
    { value: "gemini", label: "Gemini 生图 (nano banana)" },
  ],
  video: [
    { value: "zhipu", label: "智谱 CogVideoX" },
    { value: "siliconflow", label: "硅基流动" },
    { value: "openai", label: "OpenAI 兼容 (任务轮询)" },
  ],
  audio: [{ value: "openai", label: "OpenAI 兼容 (audio/speech 朗读)" }],
  asr: [{ value: "openai", label: "OpenAI 兼容 (audio/transcriptions 转写)" }],
};

/* ---------------- 其他设置 ---------------- */
export type SearchProvider = "tavily" | "bocha" | "searxng" | "zhipu" | "langsearch" | "serper" | "jina";
export type SearchCfg = { provider: SearchProvider; apiKey: string; baseUrl: string; maxResults: number };
export type ImgFormat = "png" | "jpeg" | "webp";
export type SaveCfg = { dir: string; format: ImgFormat; pattern: string; autoSave: boolean };
export type ComfyCfg = { host: string };
export type ThemeName = "light" | "dark" | "black";

/* ---------------- 音效提醒 ---------------- */
export type SoundCfg = {
  /** 总开关 */
  enabled: boolean;
  /** 语音播报：系统 TTS 念出节点名与结果（"生成图像完成" / "生成视频出错"） */
  speak: boolean;
  /** 音量 0-1 */
  volume: number;
  /** 自定义完成提示音（dataURL；留空用内置合成音） */
  doneAudio?: string;
  /** 自定义报错提示音（dataURL；留空用内置合成音） */
  errAudio?: string;
};

/* ---------------- 快捷键 ---------------- */
export type HotkeyAction =
  | "moveTool"
  | "group"
  | "ignore"
  | "popLock"
  | "fitView"
  | "zen"
  | "undo"
  | "redo"
  | "duplicate"
  | "delete"
  | "runAll"
  | "zoomIn"
  | "zoomOut"
  | "assets"
  | "gallery"
  | "search"
  | "spotlight"
  | "align"
  // 标题栏功能：与右上角那排按钮一一对应
  | "agent"
  | "charLib"
  | "settings"
  | "errCenter"
  | "runLog"
  | "theme"
  | "newBoard"
  | "voiceCall"
  // 下方工具坞：添加各类节点到视图中心（与 nodeCatalog 的条目一一对应）
  | "addImage"
  | "addVideo"
  | "addAudio"
  | "addAudioGen"
  | "addVideoDub"
  | "addPrompt"
  | "addStylePreset"
  | "addNote"
  | "addChat"
  | "addLlmText"
  | "addCombine"
  | "addImageGen"
  | "addVideoGen"
  | "addComfy"
  | "addRelight"
  | "addMultiAngle"
  | "addCharCard"
  | "addStoryboard"
  | "addEnhanceLocal"
  | "addVectorize";

export const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  moveTool: "移动工具（激活/取消）",
  group: "建组（框画区域 / 打包所选）",
  ignore: "忽略/恢复所选节点",
  popLock: "弹窗锁定（上游传入预览不自动收起）",
  fitView: "视图适应全部节点",
  zoomIn: "放大画布",
  zoomOut: "缩小画布",
  assets: "打开/关闭资产库",
  gallery: "打开/关闭生成记录",
  search: "画布内搜索节点",
  spotlight: "快速添加（搜索节点/模板）",
  align: "对齐所选节点（多选按主轴对齐，单选吸到网格）",
  zen: "沉浸模式",
  agent: "打开/关闭创作助手",
  charLib: "打开/关闭角色库",
  settings: "打开设置",
  errCenter: "打开/关闭报错中心",
  runLog: "打开/关闭运行日志",
  theme: "切换主题（云白 → 深空蓝 → 深邃黑）",
  newBoard: "新建画布",
  voiceCall: "语音通话（开始/挂断）",
  undo: "撤销",
  redo: "重做",
  duplicate: "创建副本",
  delete: "删除所选（请绑定单键）",
  runAll: "运行全部工作流",
  addImage: "添加节点：图片",
  addVideo: "添加节点：视频",
  addAudio: "添加节点：音频",
  addAudioGen: "添加节点：生成音频",
  addVideoDub: "添加节点：视频配音",
  addPrompt: "添加节点：提示词",
  addStylePreset: "添加节点：风格预设",
  addNote: "添加节点：备注",
  addChat: "添加节点：对话（已并入右侧「创作助手」，此绑定不再生效）",
  addLlmText: "添加节点：文本处理（已并入提示词弹窗「AI 工具」，此绑定不再生效）",
  addCombine: "添加节点：拼接文本",
  addImageGen: "添加节点：生成图像",
  addVideoGen: "添加节点：生成视频",
  addComfy: "添加节点：ComfyUI",
  addRelight: "添加节点：打光",
  addMultiAngle: "添加节点：多角度",
  addCharCard: "添加节点：角色卡",
  addStoryboard: "添加节点：分镜",
  addEnhanceLocal: "添加节点：超清放大",
  addVectorize: "添加节点：智能矢量",
};

/** 组合键格式：修饰键小写用 + 连接，如 "ctrl+z" / "ctrl+shift+s"；单键直接写键名 */
export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  moveTool: "v",
  group: "g",
  ignore: "i",
  popLock: "l",
  fitView: "f",
  zen: "Tab",
  undo: "ctrl+z",
  redo: "ctrl+y",
  duplicate: "ctrl+d",
  delete: "Delete",
  runAll: "ctrl+Enter",
  zoomIn: "=",
  zoomOut: "-",
  assets: "b",
  gallery: "h",
  search: "ctrl+f",
  spotlight: "ctrl+k",
  align: "a",
  // 标题栏功能（默认全走 Ctrl+Shift，避免和画布单键/浏览器快捷键打架）
  agent: "ctrl+shift+a",
  charLib: "ctrl+shift+c",
  settings: "ctrl+,",
  errCenter: "ctrl+shift+e",
  runLog: "ctrl+shift+l",
  theme: "ctrl+shift+t",
  newBoard: "ctrl+shift+n",
  voiceCall: "ctrl+shift+v",
  // 工具坞按排列顺序对应 1~9、0，编辑/角色类用 Alt+数字
  addImage: "1",
  addVideo: "",
  addAudio: "",
  addAudioGen: "",
  addVideoDub: "",
  addPrompt: "2",
  addStylePreset: "3",
  addNote: "4",
  addChat: "5",
  addLlmText: "7",
  addCombine: "",
  addImageGen: "8",
  addVideoGen: "9",
  addComfy: "0",
  addRelight: "alt+2",
  addMultiAngle: "alt+3",
  addCharCard: "alt+4",
  addStoryboard: "",
  addEnhanceLocal: "",
  addVectorize: "",
};

/* ---------------- 快捷方式（资产库侧边栏） ---------------- */
export type ShortcutItem = {
  id: string;
  name: string;
  /** exe / 文件夹的绝对路径 */
  path: string;
  kind: "app" | "folder";
};

/* ---------------- 自定义生成协议（协议执行器） ----------------
   模板占位符：{{baseUrl}} {{apiKey}} {{model}} {{prompt}} {{size}} {{n}} {{taskId}}
   图片类：{{image}} 首图 dataURL · {{image2}} 第二图 · {{images}} 全部参考图 JSON 数组（不加引号）· {{mask}} 蒙版 PNG dataURL
   视频类：{{duration}} {{resolution}} {{aspect}} {{audio}} · {{video}} 参考视频 · {{refAudio}} 参考音频
   音频类：{{voice}} 音色
   条件块：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留（端点切换/可选字段用） */
export type CustomProtocol = {
  id: string;
  name: string;
  /** 用途：图片 / 视频 / 音频生成（决定出现在哪个模型槽位、结果按哪种媒体处理） */
  role: "image" | "video" | "audio";
  /** 提交请求：url/headers/body 均为模板字符串，body 是 JSON 文本 */
  submit: { url: string; method?: "POST" | "GET"; headers?: Record<string, string>; body?: string };
  /** 提交响应里任务 id 的 JSON 路径（如 "task_id" / "data.id"）；留空 = 同步接口 */
  taskIdPath?: string;
  /** 异步轮询：查询请求 + 状态判定 */
  poll?: {
    url: string;
    method?: "POST" | "GET";
    headers?: Record<string, string>;
    body?: string;
    intervalMs?: number;
    /** 状态字段 JSON 路径与完成/失败取值 */
    statusPath: string;
    doneValue: string;
    failValue?: string;
  };
  /** 最终响应里图片的 JSON 路径（url 或 base64；支持数组，如 "data[].url"） */
  resultPath: string;
  /** 最近一次真实测试通过的时间戳（校准成功 / 自愈成功时盖章；无 = 从未验证过） */
  verifiedAt?: number;
};

/* ---------------- 重试 / 用量 / 预算（稳定性与成本控制） ---------------- */
/** 重试与备用模型配置：幂等请求自动重试 + 生成类显式重试 + 耗尽换备用模型 */
export type RetryCfg = {
  /** 幂等请求（轮询/列表/搜索/下载）自动重试次数，0=关 */
  idempotentMax: number;
  /** 生成类 POST 瞬时错误重试次数，0=关（默认关：生成重试有重复扣费风险，需用户显式开） */
  submitMax: number;
  /** 退避基数 / 上限（毫秒），指数退避 + ±20% 抖动 */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 备用模型复合键 pid::model；主模型重试耗尽后换卡再试一次。空 = 不兜底 */
  fallbackImage: string;
  fallbackVideo: string;
  fallbackAudio: string;
};

/** 单项单价（CNY），任一维度留空 = 该维度不计费 */
export type UnitPrice = {
  perCall?: number;
  perImage?: number;
  perVideoSec?: number;
  perAudioSec?: number;
  /** 每千输入 / 输出 Token */
  perIn1K?: number;
  perOut1K?: number;
};

/** 预算护栏：日预算 / 单次上限 / 确认阈值，0 = 不限制 */
export type Budget = {
  dailyCap: number;
  perRunCap: number;
  confirmOverCost: number;
};

export type Settings = {
  models: ModelsCfg;
  search: SearchCfg;
  save: SaveCfg;
  comfy: ComfyCfg;
  theme: ThemeName;
  /** 画布 GPU 加速：节点提升为合成层，平移/缩放走 GPU（默认开；遇显卡兼容问题可关） */
  gpuBoost: boolean;
  /** 任务完成/报错音效与语音播报 */
  sound: SoundCfg;
  /** 协议自愈：自定义协议运行失败时，AI 依据执行现场自动修协议并重试一次（默认开） */
  protoSelfHeal: boolean;
  hotkeys: Record<HotkeyAction, string>;
  /** 资产库侧边栏快捷方式 */
  shortcuts: ShortcutItem[];
  /** 自定义协议（协议助手生成或手写） */
  customProtocols: CustomProtocol[];
  /** 重试与备用模型（稳定性：中转站 429/5xx/网络抖动不再让工作流白跑） */
  retry: RetryCfg;
  /** 预算护栏（超阈值确认 / 超日预算阻断） */
  budget: Budget;
  /** 单价覆盖（key=模型名前缀，最长前缀优先匹配；空 = 用内置估算） */
  pricing: { overrides: Record<string, UnitPrice> };
  /** 本地超清放大引擎（DirectML 本地推理，非破坏） */
  enhance: EnhanceCfg;
};

export const DEFAULT_SETTINGS: Settings = {
  models: { providers: [], defaults: {} },
  search: { provider: "tavily", apiKey: "", baseUrl: "", maxResults: 5 },
  save: { dir: "", format: "png", pattern: "{date}_{time}_{model}", autoSave: false },
  comfy: { host: "http://127.0.0.1:8188" },
  theme: "dark",
  gpuBoost: true,
  sound: { enabled: true, speak: false, volume: 0.6 },
  protoSelfHeal: true,
  hotkeys: DEFAULT_HOTKEYS,
  shortcuts: [],
  customProtocols: [],
  // submitMax 默认 0：生成类重试有重复扣费风险，需用户显式开；幂等 GET 默认重试 2 次无此问题
  retry: { idempotentMax: 2, submitMax: 0, backoffBaseMs: 500, backoffMaxMs: 8000, fallbackImage: "", fallbackVideo: "", fallbackAudio: "" },
  budget: { dailyCap: 0, perRunCap: 0, confirmOverCost: 0 },
  pricing: { overrides: {} },
  enhance: { defaultTarget: "4k", tileSize: 0, tileOverlap: 32 },
};

/** v1（单套配置）旧结构，用于迁移 */
export type LegacySettingsV1 = {
  chat?: { baseUrl: string; apiKey: string; model: string };
  image?: { baseUrl: string; apiKey: string; model: string; size?: string };
  video?: { baseUrl: string; apiKey: string; model: string; style?: string };
  search?: SearchCfg;
  save?: SaveCfg;
  comfy?: ComfyCfg;
  theme?: ThemeName;
};

/* ---------------- ComfyUI 模板 ---------------- */
export type ComfyWfNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

export type ComfyParamKind = "text" | "number" | "seed" | "image" | "toggle";

export type ComfyExposedParam = {
  key: string; // `${nodeId}.${input}`
  nodeId: string;
  input: string;
  label: string;
  kind: ComfyParamKind;
  value: string | number | boolean;
};

export type ComfyTemplate = {
  id: string;
  name: string;
  workflow: Record<string, ComfyWfNode>;
  params: ComfyExposedParam[];
  outputNodeId?: string;
  /** 被忽略的节点：运行时剔除，下游自动跨接到其上游 */
  disabledNodes?: string[];
  createdAt: number;
};

/* ---------------- 画布模板（组/所选打包保存，可反复实例化） ---------------- */
/** 模板内节点：位置为相对模板左上角的偏移；data 已清洗（无运行结果/大图） */
export type TemplateNode = {
  /** 模板内的局部 id（实例化时重新生成） */
  tid: string;
  kind: NodeKind;
  x: number;
  y: number;
  data: Record<string, unknown>;
  /** 组成员：父节点的 tid */
  parentTid?: string;
  /** 组框尺寸 */
  w?: number;
  h?: number;
};
export type TemplateEdge = { sourceTid: string; targetTid: string; sourceHandle?: string; targetHandle?: string };
export type BoardTemplate = {
  id: string;
  name: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  /** 内置示例模板（不可删除、不落盘） */
  builtin?: boolean;
  createdAt: number;
};

/* ---------------- .momoflow 分享包（v2：可内嵌素材） ---------------- */
/** 导入时检测对方缺少的服务商配置 */
export type MomoflowRequires = {
  /** 需要的模型名列表（提示对方在「模型配置」补齐） */
  models: string[];
  /** 随包附带的协议（密钥留空，对方按需填） */
  protocols?: CustomProtocol[];
};
/** .momoflow 文件载荷：v1 纯模板；v2 可内嵌素材（大图收进 assets，节点 data 用 momoblob:<hash> 引用） */
export type MomoflowPayload = {
  app: "momo-canvas";
  type: "boardflow";
  version: 2;
  template: BoardTemplate;
  /** hash → dataURL（含素材导出时存在；导入时回填到节点 data） */
  assets?: Record<string, string>;
  /** 对方导入时缺这些配置会被提示 */
  requires?: MomoflowRequires;
};
/** 导入结果：用于在 UI 提示缺失的服务商/协议配置 */
export type ImportResult = {
  name: string;
  missing: { models: string[]; protocols: CustomProtocol[] };
};

/* ---------------- 画板 ---------------- */
export type BoardMeta = {
  id: string;
  name: string;
  updatedAt: number;
  /** 上次的视图位置/缩放（重开软件或切回画布时恢复） */
  viewport?: { x: number; y: number; zoom: number };
};

/* ---------------- 生成记录（会话内时间线） ---------------- */
export type GalleryItem = {
  id: string;
  kind: "image" | "video";
  src: string;
  prompt?: string;
  model?: string;
  nodeId?: string;
  time: number;
};

/* ---------------- 资产库 ---------------- */
/** vector = 矢量文件（SVG）：智能矢量节点产物 / 导入的 .svg，单独分类 */
export type AssetKind = "image" | "video" | "audio" | "pdf" | "vector" | "other";

/** 生成参数快照：画布生成物收录时随资产落盘，「Remix」可据此还原一个配置好的生成节点 */
export type AssetGenMeta = {
  /** 还原成哪种节点 */
  nodeKind: "imageGen" | "videoGen";
  /** 发给模型的最终提示词 */
  prompt?: string;
  /** 复合键 providerId::model */
  modelId?: string;
  size?: string;
  aspect?: string;
  resolution?: string;
  quality?: string;
  width?: number;
  height?: number;
  lang?: "zh" | "en";
  creativity?: number;
  /** 随机种子（Remix/复现用） */
  seed?: number;
  /** 负向提示词 */
  negative?: string;
};

export type AssetItem = {
  id: string;
  kind: AssetKind;
  /** 显示名 */
  name: string;
  /** 磁盘绝对路径（浏览器预览模式下为 blob/data URL） */
  path: string;
  /** 缩略图路径（图片/视频有；浏览器模式为 dataURL） */
  thumb?: string;
  mime: string;
  /** 字节数 */
  size: number;
  width?: number;
  height?: number;
  prompt?: string;
  model?: string;
  folderId?: string | null;
  /** 标签（去重、保序） */
  tags?: string[];
  /** 来源：canvas 生成 / import 导入 */
  source: "canvas" | "import";
  /** 生成参数快照（画布生成物才有）：资产卡「Remix」按此还原生成节点 */
  gen?: AssetGenMeta;
  /** 该资产来自哪个画布生成节点（资产卡「定位到画布节点」用；老资产无此字段） */
  nodeId?: string;
  createdAt: number;
};

export type AssetFolder = { id: string; name: string };
