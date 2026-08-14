/**
 * ComfyUI 工作流示意图 — 布局与中文词典
 *  - 分层自动布局（最长路径分层 + 一趟重心排序减少交叉）
 *  - 常见节点类型 / 输入名的中文词典
 *  （能力识别 analyzeCaps / 忽略节点 canDisable 在 services/comfy.ts）
 */
import type { ComfyWfNode } from "../../core/types";

/* ---------------- 中文词典 ---------------- */

const CLASS_ZH: Record<string, string> = {
  KSampler: "K采样器",
  KSamplerAdvanced: "K采样器（高级）",
  CheckpointLoaderSimple: "加载大模型",
  CLIPTextEncode: "提示词编码",
  CLIPTextEncodeSDXL: "提示词编码（SDXL）",
  CLIPTextEncodeFlux: "提示词编码（Flux）",
  CLIPSetLastLayer: "CLIP 跳层",
  VAEDecode: "VAE 解码",
  VAEEncode: "VAE 编码",
  VAEEncodeForInpaint: "VAE 编码（重绘）",
  VAELoader: "加载 VAE",
  EmptyLatentImage: "空白画布（潜空间）",
  EmptySD3LatentImage: "空白画布（SD3）",
  LoadImage: "加载图片",
  LoadImageMask: "加载蒙版",
  SaveImage: "保存图片",
  PreviewImage: "预览图像",
  SaveImageWebsocket: "保存图片（WebSocket）",
  ImageScale: "图像缩放",
  ImageScaleBy: "图像倍数缩放",
  ImageResize: "图像调整尺寸",
  GetImageSizeAndCount: "读取图像尺寸",
  ImageBlend: "图像混合",
  ImageBlur: "图像模糊",
  ImageSharpen: "图像锐化",
  ImageContrast: "图像对比度",
  ImageColorTransfer: "图像色彩迁移",
  ImageFlip: "图像翻转",
  ImageRotate: "图像旋转",
  ImageCombine: "图像合成",
  ImageToImage: "图生图（基础）",
  UpscaleModelLoader: "加载放大模型",
  ImageUpscaleWithModel: "模型放大图像",
  UltimateSDUpscale: "终极放大（分块）",
  IterativeImageUpscale: "迭代放大",
  NNLatentUpscale: "NN 潜空间放大",
  LatentUpscale: "潜空间放大",
  LatentUpscaleBy: "潜空间倍数放大",
  LatentFromBatch: "潜空间拆批",
  LatentComposite: "潜空间合成",
  LatentFlip: "潜空间翻转",
  LatentRotate: "潜空间旋转",
  LoraLoader: "加载 LoRA",
  LoraLoaderModelOnly: "加载 LoRA（仅模型）",
  ControlNetLoader: "加载 ControlNet",
  ControlNetApply: "应用 ControlNet",
  ControlNetApplyAdvanced: "应用 ControlNet（高级）",
  ControlNetInpaintingAliMamaApply: "应用 ControlNet 重绘",
  InpaintModelConditioning: "重绘条件",
  DualCLIPLoader: "加载双 CLIP",
  TripleCLIPLoader: "加载三 CLIP",
  CLIPLoader: "加载 CLIP",
  UNETLoader: "加载 UNet",
  ModelMergeSimple: "模型合并（简单）",
  ModelMergeBlocks: "模型合并（分块）",
  SamplerCustom: "自定义采样器",
  SamplerCustomAdvanced: "自定义采样器（高级）",
  BasicScheduler: "基础调度器",
  KSamplerSelect: "选择采样器",
  RandomNoise: "随机噪声",
  ImageInvert: "图像反相",
  ImageBatch: "图像组批",
  ImageFromBatch: "图像取批",
  ImageCrop: "图像裁剪",
  ImagePadForOutpaint: "扩图补边",
  ConditioningCombine: "条件合并",
  ConditioningConcat: "条件拼接",
  ConditioningSetArea: "条件区域",
  ConditioningZeroOut: "条件清零",
  ConditioningAverage: "条件平均",
  FluxGuidance: "Flux 引导强度",
  ModelSamplingSD3: "SD3 模型采样",
  FreeU: "FreeU 增强",
  FreeU_V2: "FreeU 增强（V2）",
  CLIPVisionLoader: "加载视觉 CLIP",
  CLIPVisionEncode: "视觉编码",
  StyleModelLoader: "加载风格模型",
  StyleModelApply: "应用风格模型",
  GrowMask: "蒙版扩张",
  MaskToImage: "蒙版转图像",
  ImageToMask: "图像转蒙版",
  InvertMask: "蒙版反相",
  SetLatentNoiseMask: "设置潜空间蒙版",
  RepeatLatentBatch: "潜空间重复组批",
  ImageCompositeMasked: "蒙版合成图像",
  DifferentialDiffusion: "差分扩散",
  "PlaySound|pysssss": "播放提示音",
  /* ---- 预处理（ControlNet 参考图提取：深度/线条/姿势/分割） ---- */
  Canny: "Canny 边缘（精确线条）",
  HEDPreprocessor: "HED 边缘（模糊线条）",
  LineartPreprocessor: "线稿提取",
  LineartStandardPreprocessor: "线稿提取（标准）",
  AnimeLineArtPreprocessor: "动漫线稿提取",
  Manga2Anime_LineArt_Preprocessor: "漫画转动漫线稿",
  "MiDaS-DepthMapPreprocessor": "MiDaS 深度图",
  "Zoe-DepthMapPreprocessor": "Zoe 深度图",
  DepthAnythingPreprocessor: "DepthAnything 深度图",
  DepthAnythingV2Preprocessor: "DepthAnythingV2 深度图",
  "LeReS-DepthMapPreprocessor": "LeReS 深度图",
  OpenposePreprocessor: "OpenPose 姿势骨架",
  DWPreprocessor: "DWPose 姿势骨架",
  DensePosePreprocessor: "DensePose 稠密姿势",
  "BAE-NormalMapPreprocessor": "BAE 法线图",
  "MeshGraphormer-DepthMapPreprocessor": "手部深度图",
  SemSegPreprocessor: "语义分割",
  SAMPreprocessor: "SAM 分割",
  "OneFormer-COCO-SemSegPreprocessor": "OneFormer 语义分割",
  ScribblePreprocessor: "涂鸦提取",
  TilePreprocessor: "Tile 分块参考",
  BlurPreprocessor: "模糊参考",
  ColorPreprocessor: "色彩参考",
  ReferencePreprocessor: "参考图预处理",
  InpaintPreprocessor: "重绘预处理",
  BinaryPreprocessor: "二值化参考",
  RecraftV3Preprocessor: "Recraft 参考",
  "InstantX-Flux-IPAdapter-ControllerPreprocessor": "InstantX 控制器参考",
  Scribble_XDoG_Preprocessor: "XDoG 涂鸦",
  PiDiNetPreprocessor: "PiDiNet 边缘",
  TEEDPreprocessor: "TEED 边缘",
  "Metric3D-DepthMapPreprocessor": "Metric3D 深度图",
  "Metric3D-NormalMapPreprocessor": "Metric3D 法线图",
  AIDenseposePreprocessor: "AI 稠密姿势",
  AnimalPosePreprocessor: "动物姿势骨架",
  HandRefinerPreprocessor: "手部精修",
  /* ---- IPAdapter / 面部修复 ---- */
  IPAdapter: "IPAdapter 风格参考",
  IPAdapterAdvanced: "IPAdapter（高级）",
  IPAdapterUnifiedLoader: "加载 IPAdapter",
  IPAdapterModelLoader: "加载 IPAdapter 模型",
  IPAdapterApply: "应用 IPAdapter",
  IPAdapterApplyFaceID: "应用 IPAdapter FaceID",
  IPAdapterApplyEncoder: "应用 IPAdapter 编码器",
  IPAdapterBatch: "IPAdapter 组批",
  UltralyticsDetectorProvider: "检测器（Ultralytics）",
  FaceDetailer: "面部修复",
  FaceDetailerPipe: "面部修复（管道）",
  BboxDetectorSEGS: "包围盒检测",
  SAMDetector: "SAM 检测",
  SAMDetectorCombined: "SAM 检测（组合）",
  /* ---- 视频（VHS 与 AnimateDiff） ---- */
  "VHS_LoadVideo": "加载视频",
  "VHS_LoadVideoPath": "加载视频（路径）",
  "VHS_VideoCombine": "合成视频",
  "VHS_VideoInfo": "视频信息",
  "VHS_VideoInfoLoaded": "读取视频信息",
  "VHS_LoadAudio": "加载音频",
  "VHS_LoadAudioUpload": "加载音频（上传）",
  LoadVideoUpload: "加载视频（上传）",
  VideoLinearCFGGuidance: "视频线性 CFG",
  ADE_AnimateDiffUniformContextOptions: "AnimateDiff 上下文",
  ADE_LoadAnimateDiffModel: "加载 AnimateDiff 模型",
  ADE_ApplyAnimateDiffModelSimple: "应用 AnimateDiff",
  ADE_UseEvolvedSampling: "AnimateDiff 进化采样",
  /* ---- 抠图 / 背景移除 ---- */
  RemBG: "移除背景（RemBG）",
  "BiRefNet|ZHO": "移除背景（BiRefNet）",
  "RMBG|Inspire": "移除背景（RMBG）",
  "BriaRMBG|briaai": "移除背景（Bria）",
  "Image Rembg (RGBA)": "移除背景（RGBA）",
  /* ---- 提示词风格 ---- */
  SDXLPromptStyler: "提示词风格（SDXL）",
  SDXLPromptStylerAdvanced: "提示词风格（高级）",
  TextConcat: "文本拼接",
  TextMultiline: "多行文本",
  StringFunction: "字符串处理",
  BNK_CLIPTextEncodeAdvanced: "提示词编码（高级）",
  ConditioningSetTimestepRange: "条件步数范围",
  "CR Prompt Text": "CR 提示词文本",
  /* ---- 高效节点包 ---- */
  "Efficient Loader": "高效加载器",
  "KSampler (Efficient)": "K采样器（高效）",
  "CR Apply LoRA Stack": "CR 应用 LoRA 组",
  "CR LoRA Stack": "CR LoRA 组",
  "CR Image Output": "CR 图像输出",
  "Anything Everywhere": "透传（Anywhere）",
  "Seed (rgthree)": "种子（rgthree）",
  "Power Lora Loader (rgthree)": "LoRA 加载（rgthree）",
  "Reroute (rgthree)": "中转（rgthree）",
  Reroute: "中转节点",
  "PrimitiveNode|Primitive": "常量输入",
  "Note|pysssss": "备注",
  "ShowText|pysssss": "显示文本",
  ShowText: "显示文本",
  PreviewAny: "预览任意",
  ImageSender: "图像发送",
  ImageReceiver: "图像接收",
};

const INPUT_ZH: Record<string, string> = {
  seed: "种子",
  noise_seed: "噪声种子",
  steps: "步数",
  cfg: "提示词强度 CFG",
  denoise: "重绘幅度",
  sampler_name: "采样器",
  scheduler: "调度器",
  text: "文本",
  prompt: "提示词",
  width: "宽",
  height: "高",
  batch_size: "出图张数",
  image: "图片",
  image_1: "图片 1",
  image_2: "图片 2",
  images: "图像",
  mask: "蒙版",
  filename_prefix: "文件名前缀",
  ckpt_name: "模型文件",
  vae_name: "VAE 文件",
  lora_name: "LoRA 文件",
  unet_name: "UNet 文件",
  clip_name: "CLIP 文件",
  control_net_name: "ControlNet 文件",
  strength: "强度",
  strength_model: "模型强度",
  strength_clip: "CLIP 强度",
  upscale_method: "放大算法",
  upscale_model: "放大模型",
  scale_by: "放大倍数",
  resolution: "分辨率",
  max_resolution: "最大分辨率",
  color_correction: "色彩校正",
  positive: "正面条件",
  negative: "负面条件",
  model: "模型",
  clip: "CLIP",
  vae: "VAE",
  latent_image: "潜空间图像",
  samples: "采样结果",
  pixels: "像素图",
  conditioning: "条件",
  guidance: "引导强度",
  megapixels: "百万像素",
  crop: "裁剪方式",
  upload: "上传",
  grow_mask_by: "蒙版扩张量",
  batch: "批量",
  amount: "数量",
  start_step: "起始步",
  end_step: "结束步",
  add_noise: "添加噪声",
  return_with_leftover_noise: "保留剩余噪声",
  stop_at_clip_layer: "CLIP 停止层",
  /* ---- 扩充：预处理 / 视频 / 高级参数 ---- */
  low_threshold: "低阈值",
  high_threshold: "高阈值",
  detect_resolution: "检测分辨率",
  distance_threshold: "距离阈值",
  pose_resolution: "姿势分辨率",
  hand_threshold: "手部阈值",
  body_threshold: "身体阈值",
  face_threshold: "面部阈值",
  xyx: "坐标",
  weight: "权重",
  weight_type: "权重方式",
  start_at: "起始",
  end_at: "结束",
  interpolation: "插值方式",
  resize_mode: "尺寸模式",
  mode: "模式",
  method: "方法",
  kernel_size: "卷积核",
  sigma: "模糊半径",
  blur_radius: "模糊半径",
  sharpen_radius: "锐化半径",
  alpha: "透明度",
  beta: "亮度",
  gamma: "对比度",
  hue: "色相",
  saturation: "饱和度",
  brightness: "亮度",
  contrast: "对比度",
  tiling: "分块",
  tile_width: "分块宽",
  tile_height: "分块高",
  padding: "边距",
  feathering: "羽化",
  mask_blur: "蒙版模糊",
  detail_boost: "细节增强",
  enhance: "增强",
  face_detection: "人脸检测",
  face_restore: "面部修复",
  safety: "安全等级",
  magnification: "放大倍率",
  skip_steps: "跳步",
  overlap: "重叠",
  sections: "分段",
  "length": "长度",
  fps: "帧率",
  frame_rate: "帧率",
  frame_load_cap: "最大帧数",
  loop_count: "循环次数",
  video_path: "视频路径",
  audio: "音频",
  filename: "文件名",
  path: "路径",
  url: "网址",
  format: "格式",
  extra_pnginfo: "PNG 附加信息",
  workflow: "工作流",
  api_key: "API Key",
  model_name: "模型名",
  ipadapter_file: "IPAdapter 文件",
  clip_vision: "视觉 CLIP",
  weight_type_input: "权重类型（输入）",
  embeds_scaling: "嵌入缩放",
  image_weight: "图像权重",
  attn_mask: "注意力蒙版",
  noise: "噪声",
  context_options: "上下文选项",
  motion_scale: "运动幅度",
  ad_model: "动画模型",
  ad_settings: "动画设置",
  prompts: "提示词组",
  tags: "标签",
  categories: "分类",
  detection_class: "检测类别",
  bbox: "包围盒",
  pose: "姿势",
  subject: "主体",
  threshold: "阈值",
  dilation: "膨胀",
  offset: "偏移",
  scale: "缩放",
  rotation: "旋转",
  mirror: "镜像",
  flip: "翻转",
  direction: "方向",
  index: "序号",
  seed_mode: "种子模式",
  control_after_generate: "生成后种子",
  compression: "压缩",
  quality: "质量",
  file_size: "文件大小",
  save_output: "保存输出",
  preview: "预览",
  latent: "潜空间",
  depth_map: "深度图",
  normal_map: "法线图",
  segmentation: "分割图",
  scribble: "涂鸦图",
  lineart: "线稿图",
};

/** 节点显示名：用户自定义标题 > 中文词典 > 原类名 */
export function zhNode(node: ComfyWfNode): string {
  const t = node._meta?.title?.trim();
  if (t && t !== node.class_type) return t;
  return CLASS_ZH[node.class_type] ?? node.class_type;
}

/** 输入名中文（词典没有的保留原名） */
export function zhInput(name: string): string {
  return INPUT_ZH[name] ?? name;
}

/* ---------------- 自动布局 ---------------- */

const isConn = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

/**
 * 找工作流的弱连通分量（忽略边的方向，互相可达的节点归为一组）。
 * 用于多分支工作流自动识别：完全断开的两条处理链会被识别成两个分量。
 * 返回数组的数组，每个子数组是一个连通分量的节点 id 列表（按 id 数字序稳定排序）。
 */
export function connectedComponents(wf: Record<string, ComfyWfNode>): string[][] {
  const ids = Object.keys(wf);
  const adj = new Map<string, Set<string>>();
  for (const id of ids) adj.set(id, new Set());
  for (const id of ids) {
    for (const v of Object.values(wf[id].inputs ?? {})) {
      if (isConn(v) && wf[v[0]]) {
        adj.get(id)!.add(v[0]);
        adj.get(v[0])!.add(id);
      }
    }
  }
  const visited = new Set<string>();
  const comps: string[][] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    const comp: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    comp.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    comps.push(comp);
  }
  comps.sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]));
  return comps;
}

export const WFG_W = 172;
export const WFG_H = 60;
const GAP_X = 64;
const GAP_Y = 18;

export type WfLayout = {
  pos: Record<string, { x: number; y: number }>;
  edges: { from: string; to: string; toInput: string }[];
  width: number;
  height: number;
};

/** 最长路径分层 + 一趟重心排序的左→右布局 */
export function layoutWorkflow(wf: Record<string, ComfyWfNode>): WfLayout {
  const ids = Object.keys(wf);
  const edges: WfLayout["edges"] = [];
  const deps = new Map<string, string[]>(); // node ← 其上游
  for (const id of ids) deps.set(id, []);
  for (const id of ids) {
    for (const [input, v] of Object.entries(wf[id].inputs ?? {})) {
      if (isConn(v) && wf[v[0]]) {
        edges.push({ from: v[0], to: id, toInput: input });
        deps.get(id)!.push(v[0]);
      }
    }
  }

  // 最长路径分层（环兜底：访问中再遇到按 0 处理）
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const got = layer.get(id);
    if (got !== undefined) return got;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ds = deps.get(id) ?? [];
    const l = ds.length ? Math.max(...ds.map(layerOf)) + 1 : 0;
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  ids.forEach(layerOf);

  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    (cols.get(l) ?? cols.set(l, []).get(l)!).push(id);
  }
  const byNum = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
  const rowIdx = new Map<string, number>();
  const maxLayer = Math.max(0, ...cols.keys());
  for (let l = 0; l <= maxLayer; l++) {
    const col = (cols.get(l) ?? []).sort(byNum);
    if (l > 0) {
      // 重心排序：按上游平均行号排，减少连线交叉
      col.sort((a, b) => {
        const bary = (id: string) => {
          const ups = (deps.get(id) ?? []).map((u) => rowIdx.get(u) ?? 0);
          return ups.length ? ups.reduce((s, x) => s + x, 0) / ups.length : 999;
        };
        return bary(a) - bary(b) || byNum(a, b);
      });
    }
    col.forEach((id, i) => rowIdx.set(id, i));
    cols.set(l, col);
  }

  const pos: WfLayout["pos"] = {};
  let width = 0;
  let height = 0;
  for (let l = 0; l <= maxLayer; l++) {
    for (const [i, id] of (cols.get(l) ?? []).entries()) {
      const x = l * (WFG_W + GAP_X);
      const y = i * (WFG_H + GAP_Y);
      pos[id] = { x, y };
      width = Math.max(width, x + WFG_W);
      height = Math.max(height, y + WFG_H);
    }
  }
  return { pos, edges, width: width + 8, height: height + 8 };
}
