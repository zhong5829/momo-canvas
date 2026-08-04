/**
 * 节点图片直接编辑引擎 — 悬浮工具条「编辑」的执行层：
 *  聚焦裁剪：节点图上框选 → 裁出局部，输出一个新图片节点（保持连线语境）；
 *  局部重绘：节点图上涂抹蒙版 → 只重绘选区，结果就地写回本节点；
 *  扩图 / 尺寸调整 / 高清增强：弹卡参数 → 结果就地写回本节点。
 * 「就地写回」规则：图片节点换 src；生成/打光/多角度等节点替换当前选中的结果图（commit 入撤销历史，Ctrl+Z 可回退）。
 */
import { useBoard } from "./stores/boardStore";
import { resolveModelCard, useSettings } from "./stores/settingsStore";
import { pushError, toast, useUi } from "./stores/uiStore";
import { useAssets } from "./stores/assetStore";
import { generateImage } from "./services/imageGen";
import { autoSaveImage } from "./services/imageSaver";
import { imageDims } from "./imageInfo";
import { imageFamily, nearestAspect } from "./modelMeta";
import { annotateMaskOnImage, buildOutpaintCanvas, cropByRect, maskCoverage, maskToOpenAiMask } from "./maskCanvas";
import { resampleImage, targetSize } from "./resizeMath";
import { enhanceInstruct, inpaintInstruct, inpaintMaskPrompt, outpaintInstruct, outpaintMaskPrompt } from "./editPrompts";
import { errMsg } from "./utils";
import { notifyDone } from "./sound";
import { composeMarkedImage } from "./markCanvas";
import type { AppNode, EditChannel, EnhanceParams, OutpaintPads, ResizeParams } from "./types";

/** 节点当前主图：图片节点 = src；生成/打光/多角度/ComfyUI 等 = results[picked] */
export function nodeMainImage(node: AppNode | undefined): string | undefined {
  if (!node) return undefined;
  const d = node.data as Record<string, unknown>;
  if (node.type === "image") return d.src as string | undefined;
  const results = d.results as string[] | undefined;
  return results?.length ? results[(d.picked as number | undefined) ?? 0] : undefined;
}

/** 就地写回主图（commit：可 Ctrl+Z 撤销到编辑前） */
function writeMainImage(id: string, url: string) {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  if (!node) return;
  const d = node.data as Record<string, unknown>;
  if (node.type === "image") {
    s.updateData(id, { src: url, status: "done", error: undefined }, { commit: true });
    return;
  }
  const results = [...((d.results as string[] | undefined) ?? [])];
  const picked = (d.picked as number | undefined) ?? 0;
  if (!results.length) results.push(url);
  else results[picked] = url;
  s.updateData(id, { results, status: "done", error: undefined }, { commit: true });
}

async function maybeAutoSave(images: string[], meta: { prompt?: string; model?: string }) {
  const { save } = useSettings.getState().settings;
  if (!save.autoSave) return;
  try {
    let last = "";
    for (const img of images) last = await autoSaveImage(img, save, meta);
    if (last) toast(`已自动保存 ${images.length} 张 → ${last}`, "ok");
  } catch (e) {
    toast(`自动保存失败：${errMsg(e)}`, "err");
  }
}

/** 模型类编辑通用收尾：生成记录 + 资产库 + 自动保存 + 完成提示 */
function finishNodeEdit(id: string, source: string, results: string[], prompt: string, cardName: string, cardModel: string) {
  for (const src of results) {
    useUi.getState().addGallery({ kind: "image", src, prompt, model: cardModel, nodeId: id });
    void useAssets.getState().collect({ src, kind: "image", prompt: `${source}：${prompt}`, model: cardName });
  }
  void maybeAutoSave(results, { prompt, model: cardModel });
  notifyDone(source);
}

const setStatus = (id: string, patch: Record<string, unknown>) => useBoard.getState().updateData(id, patch);

/* ---------- 标记：透明标记层与原图合成 → 就地写回，不产生新节点 ---------- */
export async function applyMark(id: string) {
  const me = useUi.getState().mediaEdit;
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可标记的图片", "err");
    return;
  }
  if (!me?.mark) {
    toast("请先在图片上添加标记", "err");
    return;
  }
  setStatus(id, { status: "running", error: undefined });
  try {
    const result = await composeMarkedImage(src, me.mark);
    writeMainImage(id, result);
    finishNodeEdit(id, "图片标记", [result], "原图与标记已本地合成", "MOMO 本地工具", "local/markup");
    useUi.getState().closeMediaEdit();
    toast("标记已与原图合成；下游生成模型将直接接收这张标记图", "ok");
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("图片标记", errMsg(e));
  }
}

/* ---------- 聚焦裁剪：框选局部 → 输出新图片节点 ---------- */
export async function applyCropToNewNode(srcId: string, rect: { x: number; y: number; w: number; h: number }) {
  const s = useBoard.getState();
  const srcNode = s.nodes.find((n) => n.id === srcId);
  const src = nodeMainImage(srcNode);
  if (!srcNode || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  try {
    const out = await cropByRect(src, rect);
    const parent = srcNode.parentId ? s.nodes.find((n) => n.id === srcNode.parentId) : undefined;
    const absX = srcNode.position.x + (parent?.position.x ?? 0);
    const absY = srcNode.position.y + (parent?.position.y ?? 0);
    const w = srcNode.measured?.width ?? 300;
    const baseName = (srcNode.data as Record<string, unknown>).name;
    const nid = s.addNode(
      "image",
      { x: absX + w + 140, y: absY },
      { src: out.dataUrl, name: `${typeof baseName === "string" && baseName ? baseName : "图片"} · 裁剪 ${out.w}×${out.h}`, status: "done" },
    );
    s.connectNodes(srcId, nid, "in", "out");
    useUi.getState().closeMediaEdit();
    toast(`已裁出 ${out.w}×${out.h} 的局部，生成新图片节点`, "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/* ---------- 局部重绘：蒙版选区 → 就地写回 ---------- */
export async function applyInpaint(id: string) {
  const me = useUi.getState().mediaEdit;
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  if (!me?.mask) {
    toast("请先在图片上涂抹要重绘的区域", "err");
    return;
  }
  if (node.data.status === "running") return;
  setStatus(id, { status: "running", error: undefined });
  try {
    if ((await maskCoverage(me.mask)) < 0.001) throw new Error("蒙版是空的：请先涂抹或框选要重绘的区域");
    const card = resolveModelCard("image", undefined);
    const family = imageFamily(card);
    const channel: EditChannel = me.channel ?? "auto";
    // 真蒙版通道仅 OpenAI 协议的 images/edits 有 mask 参数；不少中转站转发丢 mask —— 出问题就切指令式
    const useMask = channel === "mask" || (channel === "auto" && family === "gpt");
    if (channel === "mask" && card.protocol === "gemini")
      throw new Error("Gemini 协议没有蒙版参数：请把通道切成「指令式」，或换 OpenAI 协议的绘画模型");
    const userPrompt = (me.prompt ?? "").trim();
    let results: string[];
    if (useMask && card.protocol !== "gemini") {
      const dims = await imageDims(src);
      if (!dims) throw new Error("无法读取原图尺寸");
      const mask = await maskToOpenAiMask(me.mask, dims.w, dims.h);
      results = await generateImage(card, { prompt: inpaintMaskPrompt(userPrompt), refImages: [src], mask, n: 1, size: "auto" });
    } else {
      const annotated = await annotateMaskOnImage(src, me.mask);
      const dims = await imageDims(src);
      results = await generateImage(card, {
        prompt: inpaintInstruct(userPrompt),
        refImages: [src, annotated],
        n: 1,
        size: "auto",
        aspect: family === "banana" && dims ? nearestAspect(dims.w / dims.h) : undefined,
      });
    }
    writeMainImage(id, results[0]);
    finishNodeEdit(id, "局部重绘", results, userPrompt || "自然修复", card.name, card.model);
    useUi.getState().closeMediaEdit();
  } catch (e) {
    // 失败不关闭涂抹会话：蒙版还在，可调整后重试
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("局部重绘", errMsg(e));
  }
}

/* ---------- 扩图：四边外扩 → 就地写回 ---------- */
export async function applyOutpaint(id: string, pads: OutpaintPads, prompt: string, channel: EditChannel) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  if (pads.left + pads.right + pads.up + pads.down <= 0) {
    toast("请先选择扩展方向与幅度（至少一边大于 0）", "err");
    return;
  }
  if (node.data.status === "running") return;
  setStatus(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", undefined);
    const family = imageFamily(card);
    const useMask = (channel === "mask" || (channel === "auto" && family === "gpt")) && card.protocol !== "gemini";
    if (channel === "mask" && card.protocol === "gemini")
      throw new Error("Gemini 协议没有蒙版参数：请把通道切成「指令式」，或换 OpenAI 协议的绘画模型");
    const userPrompt = prompt.trim();
    let results: string[];
    if (useMask) {
      // 真 mask 外扩：原图摆入扩大的透明画布，透明区域由模型补全
      const built = await buildOutpaintCanvas(src, pads);
      results = await generateImage(card, { prompt: outpaintMaskPrompt(userPrompt), refImages: [built.image], mask: built.mask, n: 1, size: "auto" });
    } else {
      const dims = await imageDims(src);
      if (!dims) throw new Error("无法读取原图尺寸");
      const fullW = dims.w * (1 + pads.left + pads.right);
      const fullH = dims.h * (1 + pads.up + pads.down);
      const targetRatio = fullW / fullH;
      // 指令式：Banana 用比例档；GPT 用换算出的目标宽高（16 倍数、长边 ≤3840）；通用交给站点默认
      const capScale = Math.min(1, 3840 / Math.max(fullW, fullH));
      const to16 = (v: number) => Math.max(256, Math.round((v * capScale) / 16) * 16);
      results = await generateImage(card, {
        prompt: outpaintInstruct(pads, userPrompt),
        refImages: [src],
        n: 1,
        size: family === "gpt" ? `${to16(fullW)}x${to16(fullH)}` : "auto",
        aspect: family === "banana" ? nearestAspect(targetRatio) : undefined,
      });
    }
    writeMainImage(id, results[0]);
    finishNodeEdit(id, "扩图", results, userPrompt || "自然延伸画面", card.name, card.model);
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("扩图", errMsg(e));
  }
}

/* ---------- 高清增强：重绘式增强 + 放大（绘画模型引擎） → 就地写回 ---------- */
export async function applyEnhance(id: string, params: EnhanceParams) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  if (node.data.status === "running") return;
  setStatus(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", undefined);
    const family = imageFamily(card);
    const dims = await imageDims(src);
    if (!dims) throw new Error("无法读取原图尺寸");
    const factor = params.factor ?? 2;
    const prompt = enhanceInstruct(params.focus ?? "detail");
    // 目标尺寸：原图 × 倍率，长边不超过 3840，取 16 的倍数
    const capScale = Math.min(factor, 3840 / Math.max(dims.w, dims.h));
    const to16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
    const tw = to16(dims.w * capScale);
    const th = to16(dims.h * capScale);
    const results = await generateImage(card, {
      prompt,
      refImages: [src],
      n: 1,
      size: family === "banana" ? "auto" : `${tw}x${th}`,
      aspect: family === "banana" ? nearestAspect(dims.w / dims.h) : undefined,
      resolution: family === "banana" ? (factor >= 4 || Math.max(tw, th) > 2048 ? "4K" : "2K") : undefined,
      quality: family === "gpt" ? "high" : undefined,
    });
    writeMainImage(id, results[0]);
    finishNodeEdit(id, "高清增强", results, `${factor}× 增强`, card.name, card.model);
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("高清增强", errMsg(e));
  }
}

/* ---------- 尺寸调整：本地真实重采样（不调模型） → 就地写回 ---------- */
export async function applyResize(id: string, params: ResizeParams) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  setStatus(id, { status: "running", error: undefined });
  try {
    const dims = await imageDims(src);
    if (!dims) throw new Error("无法读取原图尺寸");
    const t = targetSize(params, dims.w, dims.h);
    if (t.w === dims.w && t.h === dims.h) {
      setStatus(id, { status: "done" });
      toast(`原图已是 ${t.w}×${t.h}，无需调整`, "info");
      return;
    }
    const result = await resampleImage(src, t.w, t.h);
    writeMainImage(id, result);
    setStatus(id, { status: "done" });
    toast(`已重采样：${dims.w}×${dims.h} → ${t.w}×${t.h}`, "ok");
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("尺寸调整", errMsg(e));
  }
}
