/**
 * 导演台分析工具集 — 剧情连续性检查 / 批量质量检查 / 优秀范例拆解
 *
 * 三个纯分析模块合并到此文件（都是无副作用的纯函数）：
 *  ① 剧情连续性检查（方案 §23.4）：缺片/重复/跳跃/状态冲突
 *  ② 批量质量检查（方案 §20.5）：确定性检查分辨率/帧率/时长/损坏
 *  ③ 优秀范例拆解（方案 §23.3）：导入提示词 → 拆成结构化字段
 */
import type { DirectorProject } from "./types";

/* ================ ① 剧情连续性检查（方案 §23.4） ================ */

export type ContinuityIssue = {
  level: "error" | "warning" | "info";
  category: "missing" | "duplicate" | "jump" | "conflict" | "duration";
  segmentId?: string;
  message: string;
};

/**
 * 检查项目的剧情连续性。
 *  - 缺片：未采用或未生成的片段
 *  - 重复：相邻片段摘要过于相似
 *  - 跳跃：片段之间缺少 continuityIn/continuityOut 的衔接
 *  - 冲突：同一角色在不同片段的连续性描述矛盾
 *  - 时长：总时长与目标差距过大
 */
export function checkContinuity(project: DirectorProject): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const allSegs = project.scenes.flatMap((s) => s.segments.map((seg) => ({ seg, scene: s })));

  // 缺片
  for (const { seg, scene } of allSegs) {
    const take = seg.takes?.find((t) => t.id === seg.approvedTakeId);
    if (!seg.approvedTakeId || !take || take.status !== "done") {
      issues.push({
        level: "warning",
        category: "missing",
        segmentId: seg.id,
        message: `片段「${scene.location} · ${seg.summary.slice(0, 20)}」缺片（未采用或未完成生成）`,
      });
    }
  }

  // 重复：相邻片段摘要相似度（简单 Jaccard）
  for (let i = 0; i < allSegs.length - 1; i++) {
    const a = allSegs[i].seg;
    const b = allSegs[i + 1].seg;
    const sim = jaccardSimilarity(a.summary, b.summary);
    if (sim > 0.7) {
      issues.push({
        level: "warning",
        category: "duplicate",
        segmentId: b.id,
        message: `片段 ${i + 1} 与 ${i + 2} 内容高度相似（相似度 ${(sim * 100).toFixed(0)}%），可能重复`,
      });
    }
  }

  // 跳跃：片段之间两者都缺 continuityIn/Out 才报（减少 LLM 不返回时的噪音）
  for (let i = 0; i < allSegs.length - 1; i++) {
    const a = allSegs[i].seg;
    const b = allSegs[i + 1].seg;
    if (!a.continuityOut && !b.continuityIn) {
      issues.push({
        level: "info",
        category: "jump",
        segmentId: b.id,
        message: `片段 ${i + 1} → ${i + 2} 之间缺少连续性描述，可能剧情跳跃`,
      });
    }
  }

  // 时长
  const totalSec = allSegs.reduce((n, x) => n + x.seg.durationSec, 0);
  const diff = totalSec - project.targetDurationSec;
  if (Math.abs(diff) > project.targetDurationSec * 0.15) {
    issues.push({
      level: diff > 0 ? "warning" : "info",
      category: "duration",
      message: `总时长 ${totalSec}s 与目标 ${project.targetDurationSec}s 差距 ${diff > 0 ? "+" : ""}${diff}s（超过 15%）`,
    });
  }

  // 角色冲突：同一角色在不同片段的 continuity 描述里出现矛盾关键词
  const charScenes = new Map<string, string[]>();
  for (const c of project.characters) charScenes.set(c.id, [c.continuity]);
  for (const { seg } of allSegs) {
    const cin = seg.continuityIn ?? "";
    const cout = seg.continuityOut ?? "";
    for (const c of project.characters) {
      if (cin.includes(c.name) || cout.includes(c.name)) {
        charScenes.get(c.id)?.push(`${cin} ${cout}`);
      }
    }
  }
  for (const [cid, descs] of charScenes) {
    if (descs.length < 2) continue;
    const char = project.characters.find((c) => c.id === cid);
    if (!char) continue;
    // 简单冲突检测：描述里出现互斥的服装/颜色词
    for (let i = 0; i < descs.length; i++) {
      for (let j = i + 1; j < descs.length; j++) {
        if (detectConflict(descs[i], descs[j])) {
          issues.push({
            level: "warning",
            category: "conflict",
            message: `角色「${char.name}」的连续性描述可能矛盾：\n① ${descs[i].slice(0, 40)}\n② ${descs[j].slice(0, 40)}`,
          });
        }
      }
    }
  }

  return issues;
}

/** 简单 Jaccard 相似度（分词后交集/并集） */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.split(/[\s，。、,.\[\]()（）]+/).filter((t) => t.length > 1));
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 检测两段描述里有无互斥词（红/黑、长/短、外套/T恤 等粗略冲突） */
const CONFLICT_PAIRS: [RegExp, RegExp][] = [
  [/红衣|红色.*衣|穿红/, /黑衣|黑色.*衣|穿黑/],
  [/长发|披发/, /短发|马尾/],
  [/外套|大衣/, /短袖|T恤/],
  [/白天|清晨|午后/, /夜晚|深夜|雨夜/],
];
function detectConflict(a: string, b: string): boolean {
  for (const [re1, re2] of CONFLICT_PAIRS) {
    if ((re1.test(a) && re2.test(b)) || (re2.test(a) && re1.test(b))) return true;
  }
  return false;
}

/* ================ ② 批量质量检查（方案 §20.5） ================ */

export type QualityIssue = {
  level: "error" | "warning" | "info";
  segmentId: string;
  check: "resolution" | "fps" | "duration" | "corrupt" | "aspect";
  message: string;
};

export type AssetProbe = {
  assetId: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  hasAudio?: boolean;
  corrupt?: boolean;
};

/**
 * 对采用版本做确定性质量检查。
 * probe 由调用方从资产库收集（实际宽高/帧率/时长/音轨）。
 */
export function checkQuality(project: DirectorProject, probes: Map<string, AssetProbe>): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const targetAsp = parseAspect(project.aspect);
  const targetRatio = targetAsp ? targetAsp[0] / targetAsp[1] : null;

  for (const scene of project.scenes) {
    for (const seg of scene.segments) {
      const take = seg.takes?.find((t) => t.id === seg.approvedTakeId);
      if (!take?.assetId) continue;
      const probe = probes.get(take.assetId);
      if (!probe) continue;

      if (probe.corrupt) {
        issues.push({ level: "error", segmentId: seg.id, check: "corrupt", message: `资产损坏` });
        continue;
      }

      // 分辨率
      if (probe.width && probe.height) {
        if (probe.width < 720 || probe.height < 720) {
          issues.push({
            level: "warning",
            segmentId: seg.id,
            check: "resolution",
            message: `分辨率 ${probe.width}×${probe.height} 低于 720p，建议后处理放大`,
          });
        }
      }

      // 帧率
      if (probe.fps && probe.fps < 24) {
        issues.push({
          level: "warning",
          segmentId: seg.id,
          check: "fps",
          message: `帧率 ${probe.fps.toFixed(1)}fps 低于 24，画面可能不流畅`,
        });
      }

      // 时长
      if (probe.durationSec) {
        const diff = probe.durationSec - seg.durationSec;
        if (Math.abs(diff) > 2) {
          issues.push({
            level: "info",
            segmentId: seg.id,
            check: "duration",
            message: `实际时长 ${probe.durationSec.toFixed(1)}s 与计划 ${seg.durationSec}s 差 ${diff.toFixed(1)}s`,
          });
        }
      }

      // 画幅
      if (probe.width && probe.height && targetRatio) {
        const actualRatio = probe.width / probe.height;
        if (Math.abs(actualRatio - targetRatio) > 0.1) {
          issues.push({
            level: "info",
            segmentId: seg.id,
            check: "aspect",
            message: `画幅 ${probe.width}:${probe.height} 与项目 ${project.aspect} 不一致`,
          });
        }
      }
    }
  }
  return issues;
}

function parseAspect(aspect: string): [number, number] | null {
  const m = aspect.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/* ================ ③ 优秀范例拆解（方案 §23.3） ================ */

export type PromptBreakdown = {
  subject: string; // 主体/角色
  scene: string; // 场景/时间/天气
  action: string; // 动作/情绪
  shotSize: string; // 景别/构图
  camera: string; // 机位/焦段/运镜
  lighting: string; // 光线/色彩
  style: string; // 美术风格/质感
  negative: string[]; // 负向规则
  modelSpecific: string; // 模型专用表达
  /** 原文（保留，不丢失） */
  original: string;
};

const BREAKDOWN_SYSTEM = `你是一位专业的 AI 绘画提示词分析师。用户会给你一段优秀提示词，请把它拆解成结构化 JSON。

要求：
1. 保留原文（original 字段）
2. 拆成这些字段：subject（主体/角色）、scene（场景/时间/天气）、action（动作/情绪）、shotSize（景别/构图）、camera（机位/焦段/运镜）、lighting（光线/色彩）、style（美术风格/质感）、negative（负向规则数组）、modelSpecific（模型专用表达如 lora/权重/触发词）
3. 每个字段只填原文里有的内容，没有就留空字符串或空数组
4. 只输出 JSON，不要解释

结构：{"subject":"","scene":"","action":"","shotSize":"","camera":"","lighting":"","style":"","negative":[],"modelSpecific":"","original":"原文"}`;

/**
 * 用 LLM 拆解一段优秀提示词为结构化字段（方案 §23.3）。
 * 拆解结果可保存为「提示词配方」，供其他镜头复用。
 */
export async function breakdownPrompt(prompt: string): Promise<PromptBreakdown> {
  if (!prompt.trim()) throw new Error("请输入要拆解的提示词");
  const { chatOnce } = await import("./services/llm");
  const { resolveModelCard } = await import("./stores/settingsStore");
  const card = resolveModelCard("chat");
  const raw = await chatOnce(card, BREAKDOWN_SYSTEM, prompt);
  return parseBreakdownJson(raw, prompt);
}

function parseBreakdownJson(raw: string, original: string): PromptBreakdown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("拆解结果 JSON 解析失败");
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    return {
      subject: j.subject ?? "",
      scene: j.scene ?? "",
      action: j.action ?? "",
      shotSize: j.shotSize ?? "",
      camera: j.camera ?? "",
      lighting: j.lighting ?? "",
      style: j.style ?? "",
      negative: Array.isArray(j.negative) ? j.negative : [],
      modelSpecific: j.modelSpecific ?? "",
      original: j.original ?? original,
    };
  } catch {
    throw new Error("优秀范例拆解结果 JSON 解析失败，请重试");
  }
}

/** 保存到提示词配方库（方案 §23.3）：拆解结果可命名、分类、复用 */
export type PromptRecipe = {
  id: string;
  name: string;
  category: string;
  breakdown: PromptBreakdown;
  /** 适用模型（记录用） */
  modelHint?: string;
  createdAt: number;
};

export async function newPromptRecipe(name: string, breakdown: PromptBreakdown): Promise<PromptRecipe> {
  const { uid } = await import("./utils");
  return {
    id: uid(8),
    name,
    category: "默认",
    breakdown,
    createdAt: Date.now(),
  };
}

/** 把配方编译进镜头提示词（追加到镜头大纲后） */
export function applyRecipeToPrompt(basePrompt: string, recipe: PromptRecipe): string {
  const b = recipe.breakdown;
  const extras = [b.subject, b.scene, b.action, b.shotSize, b.camera, b.lighting, b.style]
    .filter((s) => s && !basePrompt.includes(s));
  return extras.length ? `${basePrompt}\n\n【配方：${recipe.name}】\n${extras.join("，")}` : basePrompt;
}
