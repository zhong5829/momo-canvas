import { isAudioLoaderClass, isImageLoaderClass, isVideoLoaderClass } from "./services/comfy";
import type { ComfyWfNode, DirectorRecipe } from "./types";

/** 当前生成配方真正开放的五类参考入口。 */
export type DirectorReferenceSupport = {
  firstFrame: boolean;
  lastFrame: boolean;
  referenceImage: boolean;
  video: boolean;
  audio: boolean;
};

/**
 * 用同一套规则驱动分镜界面和执行队列，避免“界面灰了但后台仍投喂”或反过来。
 * FL2VA 的 LoadImage 只表示首/尾帧，不应被误当成普通 Picture 参考入口。
 */
export function directorReferenceSupport(
  recipe: DirectorRecipe | undefined,
  template?: { workflow: unknown },
): DirectorReferenceSupport {
  // 未建立配方时仍保留旧的远程图像入口行为；远程默认协议目前不接参考视/音。
  if (!recipe) {
    return { firstFrame: true, lastFrame: true, referenceImage: true, video: false, audio: false };
  }

  const mode = recipe.mode;
  if (template) {
    const nodes = Object.values(template.workflow as Record<string, ComfyWfNode>);
    const imageNodes = nodes.filter((n) => isImageLoaderClass(n.class_type));
    const firstNamed = imageNodes.some((n) => /首帧|first/i.test(n._meta?.title ?? ""));
    const lastNamed = imageNodes.some((n) => /尾帧|末帧|last|end/i.test(n._meta?.title ?? ""));

    return {
      firstFrame: firstNamed || (mode === "i2v" && imageNodes.length > 0) || (mode === "fl2v" && imageNodes.length > 0),
      lastFrame: lastNamed || (mode === "fl2v" && imageNodes.length > 1),
      referenceImage: (mode === "r2v" || mode === "i2i") && imageNodes.length > 0,
      video: nodes.some((n) => isVideoLoaderClass(n.class_type)),
      audio: nodes.some((n) => isAudioLoaderClass(n.class_type)),
    };
  }

  const cap = recipe.capabilitySnapshot;
  return {
    firstFrame: cap?.firstFrame ?? (mode === "i2v" || mode === "fl2v"),
    lastFrame: cap?.lastFrame ?? (mode === "fl2v"),
    referenceImage: (mode === "r2v" || mode === "i2i") && (cap ? cap.referenceImages > 0 : true),
    video: (cap?.referenceVideos ?? 0) > 0,
    audio: (cap?.referenceAudio ?? 0) > 0,
  };
}
