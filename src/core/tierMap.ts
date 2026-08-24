/**
 * 生成参数档位意图映射 — 把「草稿/标准/精修」翻译成各家族能理解的具体参数。
 * 跨家族语义统一在这里：banana=resolution、gpt=quality、通用家族=scalePresetToTier 实算 width/height、
 * 视频=取家族支持档位的下标（草稿=最低、精修=最高）。
 * GenConfigPanel 的档位胶囊与 genPrefStore 的内置档位都从这里取值。
 */
import { familyPresets, nearestAspect, parseRatio, scalePresetToTier, type ImageFamily } from "./modelMeta";
import { videoMeta, type VideoFamily } from "./videoMeta";

export type GenTierIntent = "draft" | "standard" | "refine";

export const TIER_LABEL: Record<GenTierIntent, string> = { draft: "草稿", standard: "标准", refine: "精修" };
export const TIER_DESC: Record<GenTierIntent, string> = {
  draft: "小尺寸、1 张、便宜：快速试稿",
  standard: "中等尺寸、2 张：日常出图",
  refine: "高清大图、3 张：精修成稿",
};

/** 草稿/标准/精修 → 图片家族参数（banana 存 resolution、gpt 存 quality、通用家族存 width/height） */
export function imageTierToParams(
  intent: GenTierIntent,
  family: ImageFamily,
  aspect?: string,
): Record<string, unknown> {
  const resolution = intent === "draft" ? "1K" : intent === "standard" ? "2K" : "4K";
  if (family === "banana") return { resolution };
  if (family === "gpt") return { quality: intent === "draft" ? "low" : intent === "standard" ? "medium" : "high" };
  // seedream/flux/qwen/kolors/generic：按当前比例的预设 × 清晰度档放大
  const r = aspect ? parseRatio(aspect) ?? 1 : 1;
  const presets = familyPresets(family);
  const best = nearestAspect(r, presets.map((p) => p.ratio));
  const p = presets.find((x) => x.ratio === best) ?? presets[0];
  if (!p) return {};
  const sz = scalePresetToTier(p, resolution, family);
  return { width: sz.w, height: sz.h, size: "default", ...(aspect ? { aspect } : {}) };
}

/** 草稿/标准/精修 → 视频家族参数（取家族支持档位的下标；只支持一档则不改） */
export function videoTierToParams(intent: GenTierIntent, family: VideoFamily): Record<string, unknown> {
  const meta = videoMeta(family);
  if (meta.resolutions.length < 2) return {};
  // 草稿=最低档、标准=中档、精修=最高档
  const idx = intent === "draft" ? 0 : intent === "standard" ? Math.floor((meta.resolutions.length - 1) / 2) : meta.resolutions.length - 1;
  return { resolution: meta.resolutions[idx] };
}
