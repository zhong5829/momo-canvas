import type { EnhanceLocalData } from "./types";

export type EnhanceEstimate = {
  width: number;
  height: number;
  pixels: number;
  tiles: number;
  tileSize: number;
  vramMb: number;
  ramMb: number;
  diskMb: number;
  secondsLow: number;
  secondsHigh: number;
  risk: "ok" | "warn" | "critical";
  note?: string;
};

function tileCount(length: number, tile: number, overlap: number) {
  if (length <= tile) return 1;
  return 1 + Math.ceil((length - tile) / Math.max(1, tile - overlap));
}

/**
 * 自动 Tile：把默认工作集控制在主流 4–8GB 独显也能稳定运行的区间。
 * DirectML 遇到更紧张的显存仍会在 Rust 侧逐级减半重试，因此这里偏向吞吐与稳定的平衡值。
 */
export function recommendedEnhanceTile(data: EnhanceLocalData): number {
  if (data.tileSize > 0) return Math.max(128, Math.round(data.tileSize / 32) * 32);
  if (data.preset === "fast") return 512;
  if (data.preset === "professional" && data.contentMode === "illustration" && data.detailStrength > 0) return 256;
  return data.preset === "professional" ? 320 : 384;
}

/** 运行前保守估算。用于风险提示与生产排期，不替代操作系统实际资源监控。 */
export function estimateEnhanceResources(inputW: number, inputH: number, data: EnhanceLocalData, globalOverlap = 32): EnhanceEstimate {
  const target = data.target;
  const long = typeof target === "string"
    ? ({ "4k": 3840, "8k": 7680, "16k": 15360 } as Record<string, number>)[target] ?? 3840
    : "mode" in target && target.mode === "print"
      ? Math.round((Math.max(target.wMm ?? 0, target.hMm ?? 0) / 25.4) * (target.dpi ?? 300))
      : "longEdge" in target ? target.longEdge ?? 3840 : 3840;
  const ratio = inputW / Math.max(1, inputH);
  const width = inputW >= inputH ? long : Math.max(1, Math.round(long * ratio));
  const height = inputH > inputW ? long : Math.max(1, Math.round(long / ratio));
  const pixels = width * height;
  const tile = recommendedEnhanceTile(data);
  const overlap = data.preset === "professional" ? 48 : globalOverlap;
  const tiles = tileCount(inputW, tile, overlap) * tileCount(inputH, tile, overlap);
  const targetRatio = long / Math.max(1, inputW, inputH);
  const manualDetail = data.detailStrength > 0 && data.detailStrength !== 45;
  // 第二神经模型只在用户手动把细节强度调到 >0 且目标不超过 8× 时启用。
  // 印刷精修默认是单主模型 + 确定性保真链，不能再按双模型高估资源。
  const fusion = manualDetail && targetRatio <= 8;
  // Tile 推理的显存主要由中间特征图决定，近似与 tile² 成正比；双模型不会同时执行，
  // 但 Session 权重会同时驻留。数值是保守排期估算，不冒充驱动层实时读数。
  const archFactor = fusion ? 13.5 : data.preset === "fast" ? 5.2 : 10.5;
  const residentModelsMb = fusion ? 420 : data.preset === "fast" ? 120 : 260;
  const vramMb = Math.ceil(residentModelsMb + (tile * tile * archFactor) / 1024);
  // Rust 管线同时持有模型输出、融合浮点数组、权重与编码缓冲；按实测结构给保守上界。
  const bytesPerPixelPeak = fusion ? 74 : 48;
  const ramMb = Math.ceil((pixels * bytesPerPixelPeak + inputW * inputH * 20) / 1048576);
  const bytesPerPixelDisk = data.outputFormat === "tiff" ? (data.bitDepth === 16 ? 5.4 : 3.1) : data.outputFormat === "jpeg" ? 0.55 : data.bitDepth === 16 ? 4.0 : 2.1;
  const diskMb = Math.ceil((pixels * bytesPerPixelDisk) / 1048576);
  // DirectML 的单次模型 Tile 远重于最终 Lanczos/编码；旧公式只按输出像素估算，会把 50 秒任务报成 2–6 秒。
  const perTile = data.preset === "fast" ? [1.2, 6] : fusion ? [18, 58] : data.preset === "portrait" ? [9, 34] : [7, 28];
  const finalMp = pixels / 1_000_000;
  let secondsLow = Math.ceil(Math.max(2, tiles * perTile[0] + finalMp * 0.12));
  let secondsHigh = Math.ceil(Math.max(secondsLow + 2, tiles * perTile[1] + finalMp * 0.7));
  // 同一节点完成过任务后，以真实耗时校准下次预估；保留模型/尺寸公式作为下界，避免偶然快跑造成再次低估。
  if (data.elapsedMs && data.elapsedMs > 0) {
    const observed = data.elapsedMs / 1000;
    secondsLow = Math.max(secondsLow, Math.floor(observed * 0.65));
    secondsHigh = Math.max(secondsHigh, Math.ceil(observed * 1.45));
  }
  const risk = ramMb > 12_000 || pixels > 180_000_000 ? "critical" : ramMb > 5_000 || pixels > 70_000_000 ? "warn" : "ok";
  const note = targetRatio > 8
    ? "目标超过源图 8×：无法恢复真实细节，已自动关闭细节模型并用 Lanczos 完成尺寸"
    : targetRatio > 4 ? "目标超过神经 4× 输出，后段包含 Lanczos 精确扩展" : undefined;
  return { width, height, pixels, tiles, tileSize: tile, vramMb, ramMb, diskMb, secondsLow, secondsHigh, risk, note };
}
