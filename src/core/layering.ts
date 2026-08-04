/**
 * 图片语义分层：视觉模型负责“是什么/大致在哪”，本地像素管线负责边缘细化、透明图层与背景补全。
 * 无视觉模型时使用海报布局启发式降级；所有输出都会报告方法与置信度，不伪装成像素级 AI 分割。
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, remove } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { resolveModelCard } from "./stores/settingsStore";
import { chatCaps, imageFamily, nearestAspect } from "./modelMeta";
import { chatStream } from "./services/llm";
import { assetsDir } from "./services/assetFiles";
import { loadImg } from "./maskCanvas";
import { annotateMaskOnImage, maskToOpenAiMask } from "./maskCanvas";
import { generateImage } from "./services/imageGen";
import { dataUrlToBytes, isTauri, uid } from "./utils";

export type LayerRole = "background" | "title" | "subtitle" | "subject" | "element";

export type LayerRegion = {
  id: string;
  name: string;
  role: Exclude<LayerRole, "background">;
  /** 归一化 x/y/w/h */
  box: [number, number, number, number];
  confidence: number;
};

export type SemanticLayer = {
  id: string;
  name: string;
  role: LayerRole;
  src: string;
  mask?: string;
  confidence: number;
  visible: boolean;
  completed?: boolean;
};

export type LayerDocument = {
  width: number;
  height: number;
  source: string;
  layers: SemanticLayer[];
  method: "vision-local" | "local-fallback";
  report: string[];
};

type PixelSource = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData; scale: number };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建分层画布");
  return { canvas, ctx };
}

function stripCodeFence(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function parseRegions(text: string): LayerRegion[] {
  const clean = stripCodeFence(text);
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("视觉模型没有返回分层 JSON");
  const raw = JSON.parse(clean.slice(start, end + 1)) as { regions?: unknown[] };
  const allowed = new Set(["title", "subtitle", "subject", "element"]);
  return (raw.regions ?? []).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const role = String(rec.role ?? "element") as LayerRegion["role"];
    const b = Array.isArray(rec.box) ? rec.box.map(Number) : [];
    if (!allowed.has(role) || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return [];
    const x = clamp01(b[0]);
    const y = clamp01(b[1]);
    const w = Math.max(0.015, Math.min(1 - x, b[2]));
    const h = Math.max(0.015, Math.min(1 - y, b[3]));
    return [{
      id: `region_${index}_${uid(4)}`,
      name: String(rec.name ?? ({ title: "标题", subtitle: "副标题", subject: "主体", element: "装饰元素" }[role])),
      role,
      box: [x, y, w, h] as [number, number, number, number],
      confidence: Math.max(0.05, Math.min(1, Number(rec.confidence ?? 0.65))),
    }];
  }).slice(0, 16);
}

async function visionRegions(src: string): Promise<LayerRegion[]> {
  const card = resolveModelCard("chat", undefined);
  if (!chatCaps(card).vision) throw new Error(`当前对话模型「${card.model}」不支持视觉输入`);
  const system = `你是平面设计稿分层分析器。只返回严格 JSON，不要 Markdown。坐标全部归一化到 0..1。
格式：{"regions":[{"name":"图层名","role":"title|subtitle|subject|element","box":[x,y,w,h],"confidence":0.0}]}
规则：识别海报标题、副标题、人物/商品主体、Logo/徽章/装饰元素；同类独立对象分开；背景不要放 regions；框要完整包住元素但尽量紧；最多16项。`;
  const prompt = "分析这张图片的可编辑视觉层。优先保证标题、主体和关键装饰元素完整，不要把阴影或背景纹理单独误判为元素。";
  const result = await chatStream(card, [{ role: "user", text: prompt, images: [src] }], { system });
  const regions = parseRegions(result.text);
  if (!regions.length) throw new Error("视觉模型没有识别到可用元素");
  return regions;
}

/** 无视觉模型时：根据水平边缘密度找文字带，再提供中央主体候选。 */
function localPosterRegions(source: PixelSource): LayerRegion[] {
  const { width: w, height: h, data } = source.data;
  const row = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let hits = 0;
    for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * 4;
      const j = (y * w + x - 1) * 4;
      const d = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
      if (d > 95) hits++;
    }
    row[y] = hits / Math.max(1, w / 2);
  }
  const sorted = Array.from(row).sort((a, b) => a - b);
  const threshold = Math.max(0.025, sorted[Math.floor(sorted.length * 0.78)] * 1.15);
  const bands: Array<[number, number]> = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    if (y < h && row[y] >= threshold) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      if (y - start >= Math.max(4, h * 0.012)) bands.push([Math.max(0, start - 3), Math.min(h, y + 3)]);
      start = -1;
    }
  }
  const candidates = bands
    .map(([a, b]) => ({ a, b, score: (b - a) * row.slice(a, b).reduce((s, n) => s + n, 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .sort((a, b) => a.a - b.a);
  const regions: LayerRegion[] = candidates.map((band, i) => ({
    id: `local_text_${i}_${uid(4)}`,
    name: i === 0 ? "标题候选" : "副标题候选",
    role: i === 0 ? "title" : "subtitle",
    box: [0.04, clamp01(band.a / h - 0.015), 0.92, Math.min(0.32, (band.b - band.a) / h + 0.03)],
    confidence: 0.46,
  }));
  regions.push({ id: `local_subject_${uid(4)}`, name: "主体候选", role: "subject", box: [0.12, 0.13, 0.76, 0.76], confidence: 0.35 });
  return regions;
}

async function workingSource(src: string, cap = 1400): Promise<{ image: HTMLImageElement; work: PixelSource }> {
  const image = await loadImg(src);
  const scale = Math.min(1, cap / Math.max(image.naturalWidth, image.naturalHeight));
  const { canvas, ctx } = makeCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { image, work: { canvas, ctx, data: ctx.getImageData(0, 0, canvas.width, canvas.height), scale } };
}

function borderSamples(data: Uint8ClampedArray, width: number, height: number, box: [number, number, number, number]) {
  const [x0, y0, x1, y1] = box;
  const out: Array<[number, number, number]> = [];
  const count = 8;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = Math.min(width - 1, Math.max(0, Math.round(x0 + (x1 - x0 - 1) * t)));
    const y = Math.min(height - 1, Math.max(0, Math.round(y0 + (y1 - y0 - 1) * t)));
    for (const [px, py] of [[x, y0], [x, y1 - 1], [x0, y], [x1 - 1, y]] as const) {
      const idx = (Math.max(0, Math.min(height - 1, py)) * width + Math.max(0, Math.min(width - 1, px))) * 4;
      if (data[idx + 3] > 16) out.push([data[idx], data[idx + 1], data[idx + 2]]);
    }
  }
  return out;
}

function smoothStep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / Math.max(1e-6, b - a));
  return t * t * (3 - 2 * t);
}

function refinedMask(work: PixelSource, region: LayerRegion): HTMLCanvasElement {
  const { width, height, data } = work.data;
  const [nx, ny, nw, nh] = region.box;
  const pad = region.role === "subject" ? 0.012 : 0.006;
  const x0 = Math.max(0, Math.floor((nx - pad) * width));
  const y0 = Math.max(0, Math.floor((ny - pad) * height));
  const x1 = Math.min(width, Math.ceil((nx + nw + pad) * width));
  const y1 = Math.min(height, Math.ceil((ny + nh + pad) * height));
  const samples = borderSamples(data, width, height, [x0, y0, x1, y1]);
  const { canvas, ctx } = makeCanvas(width, height);
  const mask = ctx.createImageData(width, height);
  const low = region.role === "title" || region.role === "subtitle" ? 20 : 28;
  const high = region.role === "title" || region.role === "subtitle" ? 62 : 82;
  let hits = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      let min = Infinity;
      for (const s of samples) {
        const dr = r - s[0];
        const dg = g - s[1];
        const db = b - s[2];
        min = Math.min(min, Math.sqrt(dr * dr + dg * dg + db * db));
      }
      const edgeFade = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y);
      const alpha = Math.round(255 * smoothStep(low, high, min) * smoothStep(0, 3, edgeFade));
      mask.data[idx] = mask.data[idx + 1] = mask.data[idx + 2] = 255;
      mask.data[idx + 3] = alpha;
      if (alpha > 40) hits++;
    }
  }
  const coverage = hits / Math.max(1, (x1 - x0) * (y1 - y0));
  // 低对比主体可能无法从边缘颜色中分离：保守退化为带羽化的区域，不能静默输出空层。
  if (coverage < 0.008) {
    ctx.clearRect(0, 0, width, height);
    const feather = Math.max(3, Math.round(Math.min(x1 - x0, y1 - y0) * 0.025));
    const gradient = ctx.createRadialGradient((x0 + x1) / 2, (y0 + y1) / 2, 0, (x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 1.3);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(Math.max(0, 1 - feather / Math.max(1, x1 - x0)), "rgba(255,255,255,0.96)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    return canvas;
  }
  ctx.putImageData(mask, 0, 0);
  return canvas;
}

function upscaleMask(mask: HTMLCanvasElement, width: number, height: number) {
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(mask, 0, 0, width, height);
  return canvas;
}

function extractLayer(image: HTMLImageElement, mask: HTMLCanvasElement) {
  const { canvas, ctx } = makeCanvas(image.naturalWidth, image.naturalHeight);
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

/** 多源边界扩散补全遮挡区；已知区域保持原像素，补全只作用于语义层覆盖处。 */
function completeBackground(work: PixelSource, masks: HTMLCanvasElement[]): HTMLCanvasElement {
  const { width, height } = work.canvas;
  const union = new Uint8Array(width * height);
  for (const mask of masks) {
    const data = mask.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
    for (let i = 0; i < union.length; i++) if (data[i * 4 + 3] > 52) union[i] = 1;
  }
  const pixels = new Uint8ClampedArray(work.data.data);
  const queue = new Int32Array(union.reduce((n, v) => n + (v ? 1 : 0), 0));
  const queued = new Uint8Array(union.length);
  let head = 0;
  let tail = 0;
  const offsets = [-1, 1, -width, width];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!union[i]) continue;
      let source = -1;
      for (const d of offsets) if (!union[i + d]) { source = i + d; break; }
      if (source >= 0) {
        const a = i * 4;
        const b = source * 4;
        pixels[a] = pixels[b]; pixels[a + 1] = pixels[b + 1]; pixels[a + 2] = pixels[b + 2]; pixels[a + 3] = 255;
        queued[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = Math.floor(i / width);
    for (const d of offsets) {
      const j = i + d;
      if (j < 0 || j >= union.length || queued[j] || !union[j]) continue;
      const jx = j % width;
      const jy = Math.floor(j / width);
      if (Math.abs(jx - x) + Math.abs(jy - y) !== 1) continue;
      const a = j * 4;
      const b = i * 4;
      pixels[a] = pixels[b]; pixels[a + 1] = pixels[b + 1]; pixels[a + 2] = pixels[b + 2]; pixels[a + 3] = 255;
      queued[j] = 1;
      queue[tail++] = j;
    }
  }
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}

export async function analyzeLayers(src: string, onProgress?: (message: string, pct: number) => void): Promise<LayerDocument> {
  onProgress?.("读取图片与建立分析金字塔…", 8);
  const { image, work } = await workingSource(src);
  let regions: LayerRegion[];
  let method: LayerDocument["method"] = "vision-local";
  try {
    onProgress?.("视觉模型识别标题、主体与版式元素…", 20);
    regions = await visionRegions(src);
  } catch {
    method = "local-fallback";
    onProgress?.("视觉模型不可用，使用本地海报结构分析…", 25);
    regions = localPosterRegions(work);
  }
  onProgress?.(`细化 ${regions.length} 个语义区域的像素边缘…`, 42);
  const workMasks = regions.map((region) => refinedMask(work, region));
  const fullMasks = workMasks.map((mask) => upscaleMask(mask, image.naturalWidth, image.naturalHeight));
  const semantic: SemanticLayer[] = regions.map((region, index) => ({
    id: region.id,
    name: region.name,
    role: region.role,
    src: extractLayer(image, fullMasks[index]),
    mask: fullMasks[index].toDataURL("image/png"),
    confidence: region.confidence,
    visible: true,
  }));
  onProgress?.("补全被标题与主体遮挡的背景区域…", 72);
  const bgWork = completeBackground(work, workMasks);
  const { canvas: bg, ctx: bgCtx } = makeCanvas(image.naturalWidth, image.naturalHeight);
  bgCtx.imageSmoothingEnabled = true;
  bgCtx.imageSmoothingQuality = "high";
  bgCtx.drawImage(bgWork, 0, 0, bg.width, bg.height);
  // 未被遮挡的背景保持原始像素，避免工作分辨率缩放损失。
  const { canvas: originalKeep, ctx: keepCtx } = makeCanvas(bg.width, bg.height);
  keepCtx.drawImage(image, 0, 0);
  for (const mask of fullMasks) {
    keepCtx.globalCompositeOperation = "destination-out";
    keepCtx.drawImage(mask, 0, 0);
  }
  bgCtx.drawImage(originalKeep, 0, 0);
  const background: SemanticLayer = {
    id: `background_${uid(5)}`,
    name: "补全背景",
    role: "background",
    src: bg.toDataURL("image/png"),
    confidence: method === "vision-local" ? 0.72 : 0.48,
    visible: true,
    completed: true,
  };
  onProgress?.("生成可编辑图层与质量报告…", 92);
  const report = [
    method === "vision-local" ? "视觉语义识别 + 本地边缘细化" : "本地海报启发式降级（建议配置视觉对话模型后重试）",
    `${regions.length + 1} 个图层 · ${image.naturalWidth}×${image.naturalHeight}`,
    "背景遮挡区已用边界扩散补全；复杂纹理建议在导出前人工检查",
    "PSD 为 8 位 RGB 像素图层；多页 TIFF 每页对应一个透明图层",
  ];
  onProgress?.("分层完成", 100);
  return { width: image.naturalWidth, height: image.naturalHeight, source: src, layers: [background, ...semantic], method, report };
}

async function canvasFrom(src: string) {
  const image = await loadImg(src);
  const { canvas, ctx } = makeCanvas(image.naturalWidth, image.naturalHeight);
  ctx.drawImage(image, 0, 0);
  return canvas;
}

function triggerDownload(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportLayeredPsd(doc: LayerDocument, dpi = 300): Promise<string> {
  const visible = doc.layers.filter((layer) => layer.visible);
  if (!visible.length) throw new Error("至少保留一个可见图层");
  const [{ writePsd }, composite, ...canvases] = await Promise.all([
    import("ag-psd"),
    canvasFrom(doc.source),
    ...visible.map((layer) => canvasFrom(layer.src)),
  ]);
  // ag-psd 的 children 顺序是图层面板从上到下；本项目内部为背景→前景，因此反转。
  const children = visible.map((layer, index) => ({ name: layer.name, canvas: canvases[index], hidden: false })).reverse();
  const bytes = new Uint8Array(writePsd({
    width: doc.width,
    height: doc.height,
    canvas: composite,
    children,
    imageResources: { resolutionInfo: { horizontalResolution: dpi, horizontalResolutionUnit: "PPI", widthUnit: "Inches", verticalResolution: dpi, verticalResolutionUnit: "PPI", heightUnit: "Inches" } },
  }, { generateThumbnail: true }));
  const fileName = `MOMO分层_${Date.now()}.psd`;
  if (!isTauri) {
    triggerDownload(bytes, fileName, "image/vnd.adobe.photoshop");
    return fileName;
  }
  const path = await save({ defaultPath: fileName, filters: [{ name: "Photoshop 分层文件", extensions: ["psd"] }] });
  if (!path) throw new Error("已取消导出");
  await writeFile(path, bytes);
  return path;
}

export async function exportLayeredTiff(doc: LayerDocument, dpi = 300): Promise<string> {
  if (!isTauri) throw new Error("多页分层 TIFF 仅桌面版支持；浏览器预览可导出 PSD");
  const visible = doc.layers.filter((layer) => layer.visible);
  if (!visible.length) throw new Error("至少保留一个可见图层");
  const outPath = await save({ defaultPath: `MOMO分层_${Date.now()}.tif`, filters: [{ name: "多页分层 TIFF", extensions: ["tif", "tiff"] }] });
  if (!outPath) throw new Error("已取消导出");
  const dir = await assetsDir();
  const token = uid(8);
  const temp: string[] = [];
  try {
    for (let i = 0; i < visible.length; i++) {
      const path = await join(dir, `.momo_layer_${token}_${i}.png`);
      await writeFile(path, dataUrlToBytes(visible[i].src));
      temp.push(path);
    }
    await invoke("layer_export_tiff", {
      layers: visible.map((layer, index) => ({ name: layer.name, path: temp[index] })),
      outPath,
      dpi,
    });
    return outPath;
  } finally {
    for (const path of temp) await remove(path).catch(() => undefined);
  }
}

export async function exportLayerPng(layer: SemanticLayer): Promise<string> {
  const bytes = dataUrlToBytes(layer.src);
  const safe = layer.name.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 48) || "图层";
  const fileName = `${safe}_${Date.now()}.png`;
  if (!isTauri) {
    triggerDownload(bytes, fileName, "image/png");
    return fileName;
  }
  const path = await save({ defaultPath: fileName, filters: [{ name: "透明 PNG 图层", extensions: ["png"] }] });
  if (!path) throw new Error("已取消导出");
  await writeFile(path, bytes);
  return path;
}

function unionMaskFromDocument(doc: LayerDocument): Promise<HTMLCanvasElement> {
  return (async () => {
    const { canvas, ctx } = makeCanvas(doc.width, doc.height);
    for (const layer of doc.layers) {
      if (layer.role === "background" || !layer.mask) continue;
      const image = await loadImg(layer.mask);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  })();
}

/** 用已配置绘画模型重建遮挡背景，但只把生成像素写入遮挡区，未遮挡区域保持原图不动。 */
export async function completeBackgroundWithModel(doc: LayerDocument): Promise<LayerDocument> {
  const card = resolveModelCard("image", undefined);
  const family = imageFamily(card);
  const union = await unionMaskFromDocument(doc);
  const maskData = union.toDataURL("image/png");
  const prompt = "移除所有标题、文字、人物、商品、Logo和前景装饰，只重建被它们遮挡的背景。保持原有背景的颜色、光线、纹理、透视和构图，不添加任何新主体或文字。";
  let generated: string;
  if (family === "gpt" && card.protocol !== "gemini") {
    const openAiMask = await maskToOpenAiMask(maskData, doc.width, doc.height);
    generated = (await generateImage(card, { prompt, refImages: [doc.source], mask: openAiMask, n: 1, size: "auto" }))[0];
  } else {
    const annotated = await annotateMaskOnImage(doc.source, maskData);
    generated = (await generateImage(card, {
      prompt: `${prompt} 第二张参考图中的红色区域就是需要补全的遮挡区。`,
      refImages: [doc.source, annotated], n: 1, size: "auto",
      aspect: family === "banana" ? nearestAspect(doc.width / doc.height) : undefined,
    }))[0];
  }
  const [original, fill] = await Promise.all([loadImg(doc.source), loadImg(generated)]);
  const { canvas, ctx } = makeCanvas(doc.width, doc.height);
  ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
  const { canvas: patch, ctx: patchCtx } = makeCanvas(doc.width, doc.height);
  patchCtx.drawImage(fill, 0, 0, patch.width, patch.height);
  patchCtx.globalCompositeOperation = "destination-in";
  patchCtx.drawImage(union, 0, 0, patch.width, patch.height);
  ctx.drawImage(patch, 0, 0);
  return {
    ...doc,
    layers: doc.layers.map((layer) => layer.role === "background" ? { ...layer, src: canvas.toDataURL("image/png"), confidence: 0.82, completed: true, name: "模型补全背景" } : layer),
    report: [...doc.report.filter((line) => !line.startsWith("背景遮挡区")), `背景遮挡区已由 ${card.name}/${card.model} 补全，未遮挡像素保持原图`],
  };
}
