/**
 * 尺寸调整（节点直接编辑）的目标尺寸推导与真实重采样 — core/nodeEdit.ts 与编辑弹卡共用
 */
import type { ResizeParams } from "./types";

/** 按目标模式推导输出宽高（保持比例，钳制在 16 ~ 8192） */
export function targetSize(d: ResizeParams, srcW: number, srcH: number): { w: number; h: number } {
  const ratio = srcW / srcH;
  let w = srcW;
  let h = srcH;
  if (d.mode === "mp") {
    const area = Math.max(0.01, d.mp || 1) * 1_000_000;
    const s = Math.sqrt(area / (srcW * srcH));
    w = srcW * s;
    h = srcH * s;
  } else if (d.mode === "side") {
    const len = Math.max(16, d.sideLen || 1024);
    const refIsW =
      d.sideRef === "width" || (d.sideRef === "long" ? srcW >= srcH : d.sideRef === "short" ? srcW < srcH : false);
    if (refIsW) {
      w = len;
      h = len / ratio;
    } else {
      h = len;
      w = len * ratio;
    }
  } else {
    const s = Math.max(1, d.scalePct || 100) / 100;
    w = srcW * s;
    h = srcH * s;
  }
  const clamp = (v: number) => Math.max(16, Math.min(8192, Math.round(v)));
  return { w: clamp(w), h: clamp(h) };
}

/** 真实重采样：createImageBitmap 解码缩放（主线程外），输出 dataURL（png 保留透明，其余转 jpeg） */
export async function resampleImage(src: string, w: number, h: number): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) {
    bmp.close();
    throw new Error("创建画布上下文失败");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return src.startsWith("data:image/png") ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.92);
}
