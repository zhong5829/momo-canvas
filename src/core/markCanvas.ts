/** 图片标记合成工具：标记层保持透明 RGBA，确认时与原图在自然尺寸上合成。 */
import { loadImg } from "./maskCanvas";

/** 原图 + 彩色标记透明层 → 无损 PNG。标记层尺寸不一致时按原图尺寸缩放。 */
export async function composeMarkedImage(src: string, markPng: string): Promise<string> {
  const [image, mark] = await Promise.all([loadImg(src), loadImg(markPng)]);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建标记合成画布");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(mark, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

