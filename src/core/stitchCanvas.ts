/**
 * 纵向拼接长图（电商详情页 / H5 长图）— 纯本地 canvas 操作，与 markCanvas.ts / resizeMath.ts 平级。
 * 把 N 张切片沿 y 轴拼成一张长图：统一宽度（默认取最窄，其余等比缩，避免放大模糊）+
 * 可选片间间距 / 背景色 / 总高上限（超限整体等比缩，守住 canvas 单边与内存上限）。
 *
 * 复用：loadImg（maskCanvas）、resampleImage（resizeMath，整图兜底缩放）。
 * 长图 dataURL 必然大，调用方直接塞节点 data 即可 —— blobStore 会自动外置（>200k 字符转 momoblob:）。
 */
import { loadImg } from "./maskCanvas";

export type StitchOptions = {
  /** 统一片宽：数字 = 固定像素；"min" = 取最窄（默认，不放大）；"max" = 取最宽（会放大窄图） */
  width?: number | "min" | "max";
  /** 片间垂直间距（像素），默认 0（无缝） */
  gap?: number;
  /** 整图背景色（如 "#ffffff"），默认透明（仅 png 有意义） */
  background?: string;
  /** 总高上限（像素），超出按宽等比整体缩放，默认 8192（守 canvas 单边与内存上限） */
  capHeight?: number;
  /** 输出格式，默认 png（保透明）；纯照片长图可传 jpeg 省体量 */
  format?: "png" | "jpeg";
};

/** 纵向拼接 N 张图 → { dataUrl, w, h }。空数组抛中文错误。 */
export async function stitchVertical(
  srcs: string[],
  opts: StitchOptions = {},
): Promise<{ dataUrl: string; w: number; h: number }> {
  if (!srcs.length) throw new Error("没有可拼接的切片：请先生成切片图");
  const gap = Math.max(0, opts.gap ?? 0);
  const format = opts.format ?? "png";
  const capHeight = Math.max(256, opts.capHeight ?? 8192);

  const imgs = await Promise.all(srcs.map(loadImg));

  // 1) 统一片宽
  const nats = imgs.map((im) => ({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }));
  let targetW: number;
  const mode = opts.width ?? "min";
  if (mode === "min") targetW = Math.min(...nats.map((n) => n.w));
  else if (mode === "max") targetW = Math.max(...nats.map((n) => n.w));
  else targetW = Math.max(64, mode);
  targetW = Math.round(targetW);

  // 2) 每片等比缩放到 targetW 后的高度，累加得总高
  let totalH = 0;
  const slices = nats.map((n) => {
    const sh = Math.max(1, Math.round((n.h * targetW) / n.w));
    totalH += sh;
    return sh;
  });
  totalH += gap * (imgs.length - 1);

  // 3) 总高超 capHeight：整体等比缩（含宽度），守 canvas 单边与内存上限
  if (totalH > capHeight) {
    const k = capHeight / totalH;
    targetW = Math.max(64, Math.round(targetW * k));
    for (let i = 0; i < slices.length; i++) slices[i] = Math.max(1, Math.round(slices[i] * k));
    totalH = slices.reduce((a, b) => a + b, 0) + gap * (imgs.length - 1);
  }

  // 4) 建画布、铺背景、逐片贴入
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = Math.round(totalH);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建拼接画布上下文");
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  let y = 0;
  for (let i = 0; i < imgs.length; i++) {
    const sh = slices[i];
    ctx.drawImage(imgs[i], 0, y, targetW, sh);
    y += sh + gap;
  }

  const dataUrl = format === "jpeg" ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png");
  return { dataUrl, w: c.width, h: c.height };
}
