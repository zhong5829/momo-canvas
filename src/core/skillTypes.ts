/**
 * MOMO Skill 类型定义 — 可安装、可配置、可复用、可验证的创作规则包
 *
 * Skill 不是模型，也不只是保存一段「万能提示词」。它告诉 MOMO：
 *  - 当前内容要按什么专业流程完善
 *  - 必须遵守哪些比例、尺度、构图、镜头或文字规则
 *  - 需要向用户补问哪些变量
 *  - 结果应输出普通文本，还是结构化数据（海报版式、导演镜头等）
 *
 * 详见《MOMO导演台节点-产品与技术方案.md》§17。
 */

/** Skill 适用的工作上下文（决定 Skill 出现在哪些入口） */
export type SkillContext =
  | "prompt.text"
  | "prompt.image"
  | "prompt.video"
  | "director.project"
  | "director.segment"
  | "poster.layout"
  | "ecom.layout"
  | "agent.image"
  | "agent.video";

/** Skill 执行阶段（固定排序：analyze → authoring → model-adapter → validate） */
export type SkillPhase = "analyze" | "authoring" | "model-adapter" | "validate";

/** Skill 输出合同类型 */
export type SkillOutput = "text" | "prompt-plan" | "poster-plan" | "director-plan";

/** Skill 变量类型 */
export type SkillVariableType = "text" | "number" | "boolean" | "select";

/** Skill 变量定义（导入时声明，用户执行前填值） */
export type SkillVariable = {
  key: string;
  label: string;
  type: SkillVariableType;
  /** select 类型的候选值 */
  options?: string[];
  /** 默认值（text/number/boolean/select 各按类型） */
  default?: string | number | boolean;
  required?: boolean;
  /** 一行说明（悬浮提示） */
  hint?: string;
};

/** Skill 本体（保存在 skillStore，节点/导演项目只保存 SkillBinding） */
export type MomoSkill = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 来源：内置 或 用户导入 */
  source: "builtin" | "import";
  /** 适用上下文（决定 Skill 出现在哪些入口） */
  contexts: SkillContext[];
  /** 执行阶段（同一阶段可多个 Skill，用户可排序） */
  phase: SkillPhase;
  /** 输出合同类型 */
  output: SkillOutput;
  /** 完整指令文本（SKILL.md / instructions.md 内容） */
  instructions: string;
  /** 参考资料文件名列表（内容在导入时落盘到 Skill 目录，执行时读取） */
  references?: string[];
  /** 变量定义 */
  variables: SkillVariable[];
  /** 是否启用（禁用的 Skill 不出现在选择器，但已绑定的历史快照仍保留） */
  enabled: boolean;
  /** 是否收藏置顶 */
  starred?: boolean;
  /** 指令内容指纹（用于检测更新后让旧生成记录知道规则已变化） */
  instructionFingerprint?: string;
  createdAt: number;
  updatedAt: number;
};

/** 节点/导演项目里保存的 Skill 绑定（不存 Skill 本体，只存 id + 变量值 + 启停） */
export type SkillBinding = {
  skillId: string;
  enabled: boolean;
  /** 变量值（key → 值） */
  values: Record<string, string | number | boolean>;
};

/** 每次 Skill 执行后写入生成历史 / Take 的快照（不可变，Skill 更新后旧记录仍可追溯） */
export type SkillRunSnapshot = {
  skillId: string;
  name: string;
  version: string;
  instructionFingerprint: string;
  values: Record<string, unknown>;
};

/** 海报结构化输出（SkillOutput = "poster-plan" 时） */
export type PosterPlan = {
  prompt: string;
  negativePrompt?: string;
  aspect: string;
  safeMarginPct: number;
  grid: string;
  subject: { position: string; scalePct: number };
  title: { text: string; zone: string; maxLines: number; hierarchy: number };
  subtitle?: { text: string; zone: string; maxLines: number };
  cta?: { text: string; zone: string };
  palette?: string[];
  checklist: string[];
};
