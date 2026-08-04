/**
 * 本地超分模型注册表 —— 模型文件与应用代码解耦（文档 §9）
 *
 * - 解析顺序：AppData/models（用户下载/重下的副本）> 安装包内嵌（resourceDir/models，
 *   便携版即 exe 同级 models/）> 缺失时从镜像自动下载到 AppData + 校验大小 + SHA-256。
 * - 生产基础模型（许可允许再分发、约 125MB）随安装包内嵌；非商业/许可待复核权重一律按需，
 *   不进入公开发行包，避免“本机能跑”被误当成“可以商业分发”。
 * - 节点只存稳定 modelId，不存绝对路径；模型不可用时给中文提示。
 * - 多模型矩阵（实施文档阶段三/四）：SPAN 极速 / NomosWebPhoto 主 / UltraSharpV2 细节 /
 *   1x-DeJPG 去压缩 / FaceUpDAT 人脸 ROI / SCRFD 检测 / GFPGAN·CodeFormer 生成式修复(可选)。
 *
 * 与云端 providerId::model 复合键无关：本地 ONNX 没有 baseUrl/apiKey，模型是文件+算法标签，
 * 因此单列 LocalModel 概念，不污染 ProviderCard（勘察 §settings 结论）。
 */
import { isTauri } from "./utils";

export type LocalModelTask = "super-resolution" | "repair" | "face-upscale" | "face-restore" | "face-detect";

export type LocalModel = {
  id: string;
  displayName: string;
  task: LocalModelTask;
  scale: number;
  architecture: string;
  format: "onnx";
  fileName: string;
  /** 期望字节数（下载后校验） */
  size: number;
  /** 期望 SHA-256（下载后校验，防损坏/篡改） */
  sha256: string;
  /** 下载源（hf-mirror 国内镜像，已验证可达） */
  url: string;
  recommendedTile: number;
  tags: string[];
  license: string;
  licenseUrl: string;
  commercialUse: "allowed" | "non-commercial" | "review";
  /** 公开发行包默认携带；必须同时满足可再分发与体积预算 */
  bundleByDefault?: boolean;
  /** 可选模型：仅用户显式开启对应功能时才下载（如生成式人脸修复 ~350MB） */
  optional?: boolean;
};

export const LOCAL_MODELS: LocalModel[] = [
  {
    // 主放大（海报·文化墙档）：照片/网页图取向，保色与结构；ESRGAN 架构，fp32 opset17。
    id: "nomoswebphoto-esrgan-fp32",
    displayName: "NomosWebPhoto · 4x (fp32, 主)",
    task: "super-resolution",
    scale: 4,
    architecture: "ESRGAN",
    format: "onnx",
    fileName: "4xNomosWebPhoto_esrgan_fp32_opset17.onnx",
    size: 67003044,
    sha256: "e29f473727ee0e32416d3a2d2642568e0159e2608d67236193772fced8696121",
    url: "https://hf-mirror.com/nesaorg/4xNomosWebPhoto_esrgan_fp32_opset17/resolve/main/4xNomosWebPhoto_esrgan_fp32_opset17.onnx",
    recommendedTile: 512,
    tags: ["照片", "海报", "主放大"],
    license: "CC-BY-4.0",
    licenseUrl: "https://openmodeldb.info/models/4x-NomosWebPhoto-esrgan",
    commercialUse: "allowed",
    bundleByDefault: true,
  },
  {
    // 细节放大（海报·文化墙档细节模型）：锐化取向，补高频纹理；RealPLKSR 架构（文档 §20 要求如实标注）。
    id: "ultrasharpv2-lite-fp32",
    displayName: "UltraSharp V2 Lite · 4x (fp32, 细节)",
    task: "super-resolution",
    scale: 4,
    architecture: "RealPLKSR",
    format: "onnx",
    fileName: "4x-UltraSharpV2_Lite_fp32_op17.onnx",
    size: 29911078,
    sha256: "ba692ad6c7b59bdebbaa9951c9ef5295a6d69e7444f1c46824c3cafdaab067a8",
    url: "https://hf-mirror.com/Kim2091/UltraSharpV2/resolve/main/4x-UltraSharpV2_Lite_fp32_op17.onnx",
    recommendedTile: 512,
    tags: ["通用", "插画", "细节"],
    license: "CC-BY-NC-SA-4.0",
    licenseUrl: "https://huggingface.co/Kim2091/UltraSharpV2",
    commercialUse: "non-commercial",
    optional: true,
  },
  {
    // 可选插画细节模型：UltraSharpV2 完整版（DAT2 架构）；仅在专业档显式选择插画并手动调强度时启用。
    id: "ultrasharpv2-dat2-fp32",
    displayName: "UltraSharp V2 · 4x (fp32, DAT2 细节)",
    task: "super-resolution",
    scale: 4,
    architecture: "DAT2",
    format: "onnx",
    fileName: "4x-UltraSharpV2_fp32_op17.onnx",
    size: 51800517,
    sha256: "6c0201e3403745f39a9aa5273c50ed084cf6c4af5a71a4654c30252cf19bf0a5",
    url: "https://hf-mirror.com/Kim2091/UltraSharpV2/resolve/main/4x-UltraSharpV2_fp32_op17.onnx",
    recommendedTile: 512,
    tags: ["专业", "细节", "插画"],
    license: "CC-BY-NC-SA-4.0",
    licenseUrl: "https://huggingface.co/Kim2091/UltraSharpV2",
    commercialUse: "non-commercial",
    optional: true,
  },
  {
    // 人像档保真主模型：NomosWebPhoto 的 RealPLKSR 转换版（默认单模型，避免锐化分支污染皮肤）。
    id: "nomoswebphoto-realplksr-fp32",
    displayName: "NomosWebPhoto · 4x (fp32, RealPLKSR 主)",
    task: "super-resolution",
    scale: 4,
    architecture: "RealPLKSR",
    format: "onnx",
    fileName: "4xNomosWebPhoto_RealPLKSR_fp32_opset17.onnx",
    size: 29805849,
    sha256: "146669e66cd3b22a4b97b0cf83f9bb2bcf20cd4ffd51fe76f91b95a4a8002df6",
    url: "https://hf-mirror.com/nesaorg/4xNomosWebPhoto_RealPLKSR_fp32_opset17/resolve/main/4xNomosWebPhoto_RealPLKSR_fp32_opset17.onnx",
    recommendedTile: 512,
    tags: ["人像", "专业", "主放大"],
    license: "CC-BY-4.0",
    licenseUrl: "https://huggingface.co/Phips/4xNomosWebPhoto_RealPLKSR",
    commercialUse: "allowed",
    bundleByDefault: true,
  },
  {
    // 极速档主模型：SPAN 轻量架构，1.7MB 秒级下载秒级推理；multijpg 训练对压缩图鲁棒。
    id: "nomosuni-span-multijpg-fp32",
    displayName: "NomosUni SPAN · 4x (fp32, 极速)",
    task: "super-resolution",
    scale: 4,
    architecture: "SPAN",
    format: "onnx",
    fileName: "4xNomosUni_span_multijpg_fp32_opset17.onnx",
    size: 1717409,
    sha256: "a435b009109e72c50ce95927dab0a6dde63e594cf57ba5a18ba63da67355698a",
    url: "https://hf-mirror.com/nesaorg/4xNomosUni_span_multijpg_fp32_opset17/resolve/main/4xNomosUni_span_multijpg_fp32_opset17.onnx",
    recommendedTile: 512,
    tags: ["极速", "JPEG鲁棒"],
    license: "CC-BY-4.0",
    licenseUrl: "https://openmodeldb.info/models/4x-NomosUni-span-multijpg",
    commercialUse: "allowed",
    bundleByDefault: true,
  },
  {
    // 条件去压缩预处理（1x，不变尺寸）：jpegScore>0.3 时在主超分前跑一遍去 JPEG 块效应。
    id: "dejpg-realplksr-1x",
    displayName: "DeJPG · 1x (fp32, 去压缩)",
    task: "repair",
    scale: 1,
    architecture: "RealPLKSR",
    format: "onnx",
    fileName: "1xDeJPG_realplksr_otf_60_fp32_opset17.onnx",
    size: 29613083,
    sha256: "6e445abdd309346fa930d26205ff5d61af1ddbe6cb43609301c5d5bb60368dc1",
    url: "https://hf-mirror.com/nesaorg/1xDeJPG_realplksr_otf_60_fp32_opset17/resolve/main/1xDeJPG_realplksr_otf_60_fp32_opset17.onnx",
    recommendedTile: 512,
    tags: ["去JPEG", "去块", "预处理"],
    license: "CC-BY-4.0",
    licenseUrl: "https://openmodeldb.info/models/1x-DeJPG-realplksr-otf",
    commercialUse: "allowed",
    bundleByDefault: true,
  },
  {
    // 人脸 ROI 可选增强（人像档显式开启）：128–256px 人脸裁剪 4x 增强后羽化贴回。
    id: "faceupdat-4x-fp32",
    displayName: "FaceUpDAT · 4x (fp32, 人脸增强)",
    task: "face-upscale",
    scale: 4,
    architecture: "DAT",
    format: "onnx",
    fileName: "4xFaceUpDAT_fp32_opset17.onnx",
    size: 64531231,
    sha256: "e02a5ac062cc5bee619a3b01bd294064063e090fbdab7dede98cf32cd353a05f",
    url: "https://hf-mirror.com/nesaorg/4xFaceUpDAT_fp32_opset17/resolve/main/4xFaceUpDAT_fp32_opset17.onnx",
    recommendedTile: 256,
    tags: ["人脸", "保真", "ROI"],
    license: "CC-BY-4.0",
    licenseUrl: "https://huggingface.co/Phips/4xFaceUpDAT",
    commercialUse: "allowed",
    optional: true,
  },
  {
    // 人脸检测：SCRFD 2.5G 轻量检测器（640 输入，3 stride 输出 + 关键点），人像档路由依据。
    id: "scrfd-2.5g",
    displayName: "SCRFD 2.5G (人脸检测)",
    task: "face-detect",
    scale: 1,
    architecture: "SCRFD",
    format: "onnx",
    fileName: "scrfd_2.5g_bnkps.onnx",
    size: 3290207,
    sha256: "bc24bb349491481c3ca793cf89306723162c280cb284c5a5e49df3760bf5c2ce",
    url: "https://hf-mirror.com/hsuyabc/scrfd_2.5g_bnkps.onnx/resolve/main/scrfd_2.5g_bnkps.onnx",
    recommendedTile: 640,
    tags: ["人脸检测"],
    license: "InsightFace 模型条款",
    licenseUrl: "https://github.com/deepinsight/insightface/tree/master/model_zoo",
    commercialUse: "review",
    optional: true,
  },
  {
    // 生成式人脸修复（可选，默认关闭）：GFPGAN 1.4，512² 固定输入。
    id: "gfpgan-v1.4",
    displayName: "GFPGAN 1.4 (生成式人脸修复)",
    task: "face-restore",
    scale: 1,
    architecture: "GFPGAN",
    format: "onnx",
    fileName: "GFPGANv1.4.onnx",
    size: 340256686,
    sha256: "cd7311b8d9e13cdb1e208b12363182da58c7bf45e26d1aa67bbeac4751aae92e",
    url: "https://hf-mirror.com/Meeperomi/GFPGANv1.4-onnx/resolve/main/GFPGANv1.4.onnx",
    recommendedTile: 512,
    tags: ["人脸修复", "生成式"],
    license: "模型来源待复核",
    licenseUrl: "https://github.com/TencentARC/GFPGAN",
    commercialUse: "review",
    optional: true,
  },
  {
    // 生成式人脸修复（可选，默认关闭）：CodeFormer，512² 固定输入，部分转换版带 fidelity w 输入（运行时探测）。
    id: "codeformer",
    displayName: "CodeFormer (生成式人脸修复)",
    task: "face-restore",
    scale: 1,
    architecture: "CodeFormer",
    format: "onnx",
    fileName: "codeformer.onnx",
    size: 376821950,
    sha256: "91e7e881c5001fea4a535e8f96eaeaa672d30c963a678a3e27f0429a6620f57a",
    url: "https://hf-mirror.com/bluefoxcreation/Codeformer-ONNX/resolve/main/codeformer.onnx",
    recommendedTile: 512,
    tags: ["人脸修复", "生成式", "fidelity"],
    license: "模型来源待复核",
    licenseUrl: "https://github.com/sczhou/CodeFormer",
    commercialUse: "review",
    optional: true,
  },
];

export function defaultLocalModelId(): string {
  return LOCAL_MODELS[0].id;
}

/** 某模型的磁盘绝对路径（AppData/models/<fileName>）——语义是「AppData 副本路径/下载目标」，
 *  不代表实际生效路径（生效路径可能在内嵌目录，见 resolveLocalModel） */
export async function modelFilePath(id: string): Promise<string | null> {
  if (!isTauri) return null;
  const m = LOCAL_MODELS.find((x) => x.id === id);
  if (!m) return null;
  const { join } = await import("@tauri-apps/api/path");
  return join(await localModelsDir(), m.fileName);
}

let bundledDirCache: string | null = null;
/** 安装包内嵌模型目录（resourceDir/models）；NSIS 安装版在 exe 同级，便携版同理（打包脚本塞入） */
export async function bundledModelsDir(): Promise<string> {
  if (bundledDirCache) return bundledDirCache;
  const { resourceDir, join } = await import("@tauri-apps/api/path");
  bundledDirCache = await join(await resourceDir(), "models");
  return bundledDirCache;
}

/** 内嵌模型绝对路径；不存在（如 dev 环境未铺 models/）返回 null */
export async function bundledModelPath(id: string): Promise<string | null> {
  if (!isTauri) return null;
  const m = LOCAL_MODELS.find((x) => x.id === id);
  if (!m) return null;
  const { join } = await import("@tauri-apps/api/path");
  const { exists } = await import("@tauri-apps/plugin-fs");
  const p = await join(await bundledModelsDir(), m.fileName);
  return (await exists(p)) ? p : null;
}

/** 模型在位状态 —— 模型管理 UI 用。downloaded=AppData 副本（可删）；bundled=安装包内嵌（只读不可删） */
export async function modelStatus(id: string): Promise<{ downloaded: boolean; bytes: number; bundled: boolean; bundledBytes: number }> {
  const out = { downloaded: false, bytes: 0, bundled: false, bundledBytes: 0 };
  if (!isTauri) return out;
  const { exists, stat } = await import("@tauri-apps/plugin-fs");
  const p = await modelFilePath(id);
  if (p && (await exists(p))) {
    out.downloaded = true;
    out.bytes = await stat(p).then((s) => s.size).catch(() => 0);
  }
  const bp = await bundledModelPath(id);
  if (bp) {
    out.bundled = true;
    out.bundledBytes = await stat(bp).then((s) => s.size).catch(() => 0);
  }
  return out;
}

/** 删除模型文件（只删 AppData 副本；内嵌副本随安装包只读分发，删了会回落到内嵌版） */
export async function deleteModelFile(id: string): Promise<void> {
  const p = await modelFilePath(id);
  if (!p) return;
  const { exists, remove } = await import("@tauri-apps/plugin-fs");
  if (await exists(p)) await remove(p);
}

/** 强制重新下载到 AppData（覆盖内嵌版——不能只调 resolveLocalModel，它会命中内嵌而不下载） */
export async function redownloadModel(id: string): Promise<void> {
  const m = LOCAL_MODELS.find((x) => x.id === id);
  if (!m) return;
  await deleteModelFile(id);
  const { join } = await import("@tauri-apps/api/path");
  await downloadModel(m, await join(await localModelsDir(), m.fileName));
}

let dirCache: string | null = null;
export async function localModelsDir(): Promise<string> {
  if (dirCache) return dirCache;
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
  const dir = await join(await appDataDir(), "models");
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  dirCache = dir;
  return dir;
}

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 解析本地模型：确保文件在位；缺失则自动下载。
 * 解析顺序：AppData 副本 > 安装包内嵌（resourceDir/models）> 下载到 AppData。
 * 已在位的文件跳过重算 hash（启动/导入快）；下载来的强制校验大小 + SHA-256。
 */
export async function resolveLocalModel(id?: string): Promise<{ model: LocalModel; path: string }> {
  if (!isTauri) throw new Error("本地超分仅桌面版支持（浏览器预览无本地推理）");
  const model = LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS[0];
  const { join } = await import("@tauri-apps/api/path");
  const { exists } = await import("@tauri-apps/plugin-fs");
  const dir = await localModelsDir();
  const path = await join(dir, model.fileName);
  if (await exists(path)) return { model, path };
  const bundled = await bundledModelPath(model.id);
  if (bundled) return { model, path: bundled };
  await downloadModel(model, path);
  return { model, path };
}

async function downloadModel(model: LocalModel, path: string): Promise<void> {
  const { xfetch } = await import("./services/http");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const resp = await xfetch(model.url);
  if (!resp.ok) throw new Error(`下载模型失败（HTTP ${resp.status}）：${model.url}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length !== model.size) {
    throw new Error(`模型大小不符：期望 ${model.size} 字节，实际 ${buf.length}（下载可能不完整，请重试）`);
  }
  const hash = await sha256Hex(buf);
  if (hash !== model.sha256) {
    throw new Error(`模型 SHA-256 校验失败，文件可能损坏或被篡改（期望 ${model.sha256.slice(0, 12)}…，实际 ${hash.slice(0, 12)}…）`);
  }
  await writeFile(path, buf);
}
