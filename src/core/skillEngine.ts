/**
 * Skill 执行引擎 — 把 Skill 指令 + 变量值拼成 system prompt，交给对话模型执行。
 *
 * 阶段 5 最小实现（方案 §17.5 执行链的简化版）：
 *   当前文本/图片上下文 → 填充变量 → 拼 system → 调 llmTextTransform("custom", ...) → 返回结果
 *
 * 暂不实现：
 *  - Skill 栈（多 Skill 串联、阶段排序、冲突检测）—— 首版单 Skill 执行
 *  - 结构化输出解析（PosterPlan / DirectorPlan）—— 首版只支持 text 输出
 *  - 预览差异 UI —— 复用现有「直接替换」链路，预览留到后续
 *  - 参考资料文件读取 —— references 暂不注入
 */
import type { MomoSkill, SkillVariable } from "./skillTypes";
import { llmTextTransform } from "./runner";

/** 把变量值注入 Skill 指令，拼成最终 system prompt */
export function buildSkillSystem(skill: MomoSkill, values: Record<string, string | number | boolean>): string {
  let sys = skill.instructions;
  // 把变量以「键: 值」形式追加到指令末尾，供模型参考
  const filled = skill.variables
    .filter((v) => {
      const val = values[v.key];
      return val !== undefined && val !== "" && !(v.type === "select" && val === "自动");
    })
    .map((v) => `${v.label}（${v.key}）：${values[v.key]}`);
  if (filled.length) {
    sys += `\n\n【本次参数】\n${filled.join("\n")}`;
  }
  return sys;
}

/** 从 Skill 的变量定义生成默认值表（导入后 / 选择后初始化用） */
export function defaultSkillValues(skill: MomoSkill): Record<string, string | number | boolean> {
  const vals: Record<string, string | number | boolean> = {};
  for (const v of skill.variables) {
    if (v.default !== undefined) vals[v.key] = v.default;
  }
  return vals;
}

/**
 * 执行一个 text-output Skill：
 *  - 拼好 system（instructions + 变量值）
 *  - 复用 llmTextTransform 的 "custom" 分支（把 system 原样发给模型）
 *  - 返回结果文本（已 trim）
 *
 * 注：本函数不处理 image 输入——Skill 若需图片反推，调用方自行判断。
 * 模型选择走 llmTextTransform 内部的 resolveModelCard("chat")。
 */
export async function runSkill(
  skill: MomoSkill,
  values: Record<string, string | number | boolean>,
  text: string,
  image?: string,
): Promise<string> {
  if (skill.output !== "text") {
    // 非 text 输出的 Skill（poster-plan / director-plan）需要结构化解析，首版不支持
    throw new Error(`Skill「${skill.name}」的输出类型为 ${skill.output}，当前版本只支持文本输出 Skill`);
  }
  const system = buildSkillSystem(skill, values);
  // isCaptionOp 判断：如果 Skill 指令里包含「分析图片/反推」且提供了 image，走 image 分支
  const isCaption = /分析.*图|反推|描述.*图|看图/.test(skill.instructions) && !!image;
  return llmTextTransform("custom", system, isCaption ? "请分析这张图片。" : text, isCaption ? image : undefined);
}

/** 类型便利：给 UI 用，拿到变量的合法值列表（select 类型） */
export function variableOptions(v: SkillVariable): string[] {
  return v.type === "select" ? v.options ?? [] : [];
}
