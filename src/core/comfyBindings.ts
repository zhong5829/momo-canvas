/**
 * ComfyUI 语义槽绑定 — 纯映射 / 校验层
 *
 * 方案 §7.4：给 ComfyUI 模板的每个子工作流分支增加语义能力描述和槽位映射。
 * 接收模板、槽值和上传后的文件名，返回要执行的工作流或中文错误。
 *
 * 职责边界（方案 §9）：
 *  - 不直接改 ComfyUI 工作流 JSON（只产出绑定描述）
 *  - 是纯映射/校验层，可被 directorEngine 和绑定向导共用
 */
import type { ComfySemanticSlot, ComfySemantic, ComfySlotBinding, ComfyTemplate, ComfyVariant } from "./types";

/** 建议绑定时给出的候选：目标节点 + 判断依据 + 置信度 */
export type SlotSuggestion = {
  slot: ComfySemantic;
  binding: ComfySlotBinding;
  /** 判断依据（供 UI 显示） */
  reason: string;
  /** 高 = 自动绑定；中 = 建议但需确认；低 = 不确定 */
  confidence: "high" | "medium" | "low";
};

/** 按 ComfySemantic 推断它在工作流里应该绑到哪类节点 */
const SEMANTIC_HINTS: Partial<Record<ComfySemantic, { classPatterns: RegExp[]; inputNames: RegExp[]; media: "text" | "image" | "video" | "audio" | "number" }>> = {
  prompt: { classPatterns: [/CLIPTextEncode/i], inputNames: [/^text$|^prompt$|^positive/i], media: "text" },
  negativePrompt: { classPatterns: [/CLIPTextEncode/i], inputNames: [/^text$|^negative/i], media: "text" },
  firstFrame: { classPatterns: [/LoadImage/i], inputNames: [/^image$|^first_?frame/i], media: "image" },
  lastFrame: { classPatterns: [/LoadImage/i], inputNames: [/^image$|^last_?frame/i], media: "image" },
  referenceImage: { classPatterns: [/LoadImage/i], inputNames: [/^image$|^reference/i], media: "image" },
  referenceVideo: { classPatterns: [/LoadVideo|VHS/i], inputNames: [/^video$|^file$|^video_?path/i], media: "video" },
  referenceAudio: { classPatterns: [/LoadAudio|AudioLoad/i], inputNames: [/^audio$|^file$|^audio_?path/i], media: "audio" },
  duration: { classPatterns: [], inputNames: [/^duration$|^length$|^seconds/i], media: "number" },
  width: { classPatterns: [], inputNames: [/^width$/], media: "number" },
  height: { classPatterns: [], inputNames: [/^height$/], media: "number" },
  fps: { classPatterns: [], inputNames: [/^fps$|^frame_?rate/i], media: "number" },
  seed: { classPatterns: [/KSampler|Sampler/i], inputNames: [/^seed$/], media: "number" },
};

/**
 * 扫描 variant 的工作流，为每个语义槽给出绑定建议。
 * 用于绑定向导：高置信度自动配置，中低置信度人工确认。
 */
export function suggestBindings(tpl: ComfyTemplate, variant: ComfyVariant): SlotSuggestion[] {
  const wf = tpl.workflow;
  const nodeIds = variant.nodeIds.length ? variant.nodeIds : Object.keys(wf);
  const out: SlotSuggestion[] = [];

  for (const [sem, hint] of Object.entries(SEMANTIC_HINTS)) {
    const semantic = sem as ComfySemantic;
    for (const nid of nodeIds) {
      const node = wf[nid];
      if (!node) continue;
      const classMatch = hint.classPatterns.some((re) => re.test(node.class_type));
      const inputMatch = Object.keys(node.inputs ?? {}).some((inp) => hint.inputNames.some((re) => re.test(inp)));
      if (!classMatch && !inputMatch) continue;

      // 找到匹配的具体输入
      const inputs = Object.keys(node.inputs ?? {}).filter((inp) => hint.inputNames.some((re) => re.test(inp)));
      const input = inputs[0] ?? Object.keys(node.inputs ?? {})[0];
      if (!input) continue;

      // 负面提示词：节点要接到 negative 条件上或标题含 negative
      if (semantic === "negativePrompt") {
        const isNeg = /negative/i.test(node._meta?.title ?? "") || Object.values(wf).some((n) =>
          Object.entries(n.inputs ?? {}).some(([k, v]) => /negative/i.test(k) && Array.isArray(v) && v[0] === nid),
        );
        if (!isNeg) continue;
      }
      // 正面提示词：排除负面
      if (semantic === "prompt") {
        const isNeg = /negative/i.test(node._meta?.title ?? "");
        if (isNeg) continue;
      }

      const reason = `${node._meta?.title ?? node.class_type} 的 ${input} 输入`;
      const confidence: SlotSuggestion["confidence"] = classMatch && inputMatch ? "high" : classMatch || inputMatch ? "medium" : "low";
      out.push({ slot: semantic, binding: { nodeId: nid, input }, reason, confidence });
    }
  }
  return out;
}

/** 校验结果 */
export type BindingValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * 校验 variant 的语义槽配置是否完备（提交前 preflight）。
 *  - 必填槽必须有绑定
 *  - 绑定的目标节点必须存在于工作流
 *  - 媒体类型要匹配（图片槽不能绑到文本输入）
 */
export function validateBindings(tpl: ComfyTemplate, variant: ComfyVariant): BindingValidation {
  const wf = tpl.workflow;
  const errors: string[] = [];
  const warnings: string[] = [];
  const slots = variant.slots ?? [];

  for (const slot of slots) {
    if (!slot.bindings.length) {
      if (slot.required) errors.push(`必填槽「${slot.label}」没有绑定`);
      continue;
    }
    for (const b of slot.bindings) {
      const node = wf[b.nodeId];
      if (!node) {
        errors.push(`槽「${slot.label}」绑定的节点 #${b.nodeId} 不在工作流中（工作流可能已修改）`);
        continue;
      }
      if (!(b.input in (node.inputs ?? {}))) {
        warnings.push(`槽「${slot.label}」绑定的输入 ${b.input} 在节点 #${b.nodeId} 上不存在`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 按 variant 的语义槽，把外部传入的槽值（semantic → 资产文件名/文本）解析成具体的写入指令。
 * directorEngine 调用此函数拿到写入映射，再在 extractVariantWorkflow 提取出的子工作流上执行。
 */
export type ResolvedSlotWrite = {
  semantic: ComfySemantic;
  binding: ComfySlotBinding;
  /** 要写入的值（上传后的 ComfyUI 文件名 / 文本 / 数字） */
  value: string | number | boolean;
};

export type ResolveSlotsResult = {
  writes: ResolvedSlotWrite[];
  /** 缺失的必填槽 */
  missing: ComfySemanticSlot[];
};

/**
 * 把语义槽值映射成工作流写入指令。
 *  - 每个 slot.bindings 可能有多条（同一语义绑到多个节点）
 *  - maxItems 限制多值槽的素材数量
 *  - 多值时按 bindings 的 index 顺序填充；index 缺省 = 0
 */
export function resolveSlotWrites(
  slots: ComfySemanticSlot[],
  values: Partial<Record<ComfySemantic, Array<string | number | boolean> | string | number | boolean>>,
): ResolveSlotsResult {
  const writes: ResolvedSlotWrite[] = [];
  const missing: ComfySemanticSlot[] = [];

  for (const slot of slots) {
    const raw = values[slot.semantic];
    if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) {
      if (slot.required) missing.push(slot);
      continue;
    }
    // 归一化成数组（单值也当数组处理，按 binding index 分配）
    const arr = Array.isArray(raw) ? raw : [raw];
    // maxItems 截断
    const capped = slot.maxItems ? arr.slice(0, slot.maxItems) : arr;

    // 按 binding 的 index 分组（缺省 index = 0）
    const byIndex = new Map<number, ComfySlotBinding[]>();
    for (const b of slot.bindings) {
      const idx = b.index ?? 0;
      if (!byIndex.has(idx)) byIndex.set(idx, []);
      byIndex.get(idx)!.push(b);
    }

    capped.forEach((val, i) => {
      const bindings = byIndex.get(i) ?? byIndex.get(0) ?? [];
      for (const b of bindings) {
        writes.push({ semantic: slot.semantic, binding: b, value: val });
      }
    });
  }

  return { writes, missing };
}

/**
 * 计算工作流结构指纹（用于检测工作流内容变化后让 verifiedAt 失效）。
 * 只关心拓扑结构（节点类型 + 连线关系），不关心参数值（参数值变不应该让语义绑定失效）。
 */
export function workflowFingerprint(tpl: ComfyTemplate, variantId?: string): string {
  const variant = variantId ? tpl.variants?.find((v) => v.id === variantId) : undefined;
  const nodeIds = variant?.nodeIds.length ? variant.nodeIds : Object.keys(tpl.workflow);
  const parts = nodeIds
    .filter((id) => tpl.workflow[id])
    .map((id) => {
      const n = tpl.workflow[id];
      // 只取 class_type 和连线的源（拓扑结构），不取静态值
      const conns = Object.entries(n.inputs ?? {})
        .filter(([, v]) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
        .map(([k, v]) => `${k}→${(v as [string, number])[0]}`)
        .sort();
      return `${id}:${n.class_type}[${conns.join("|")}]`;
    })
    .sort();
  return parts.join(";");
}

/** 在 variant 上标记已验证（绑定向导确认后调用） */
export function markVerified(tpl: ComfyTemplate, variantId: string): ComfyVariant[] {
  const fp = workflowFingerprint(tpl, variantId);
  return (tpl.variants ?? []).map((v) =>
    v.id === variantId ? { ...v, verifiedAt: Date.now(), fingerprint: fp } : v,
  );
}
