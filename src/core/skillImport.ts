/**
 * Skill 安全导入 — 两种入口：
 *  ① 快速 Skill：直接导入一个 SKILL.md（frontmatter 元数据 + 正文指令）
 *  ② 完整 Skill 包：.momoskill ZIP（skill.json + instructions.md + references/ + assets/）
 *
 * 安全策略（方案 §17.9）：
 *  - 第一版只读取声明式文件，不执行 scripts/、.js、.py、可执行文件
 *  - 解压时校验路径，禁止 ../ 路径穿越
 *  - 文件数量 ≤ 100、总体积 ≤ 20MB
 *  - 导入向导让用户补充名称、分类、适用位置、执行阶段
 */
import type { MomoSkill, SkillContext, SkillOutput, SkillPhase, SkillVariable } from "./skillTypes";
import { newSkill } from "./stores/skillStore";

/** 导入结果 */
export type ImportResult = {
  skill: MomoSkill;
  warnings: string[]; // 非 fatal 警告（如忽略了脚本文件）
};

const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** SKILL.md frontmatter 里的合法字段 */
type Frontmatter = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  contexts?: string[];
  phase?: string;
  output?: string;
  variables?: SkillVariable[];
};

/** 解析 SKILL.md：首段 YAML frontmatter（--- 分隔）+ 剩余正文作为 instructions */
function parseSkillMd(text: string): { fm: Frontmatter; instructions: string } {
  const fm: Frontmatter = {};
  let instructions = text;
  // 匹配首行 --- ... --- 包裹的 frontmatter
  const m = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    const yaml = m[1];
    instructions = m[2].trim();
    // 极简 YAML 解析（不引第三方库）：只认 key: value 和 key: [a, b] 和列表
    for (const line of yaml.split(/\r?\n/)) {
      const mm = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (!mm) continue;
      const [, k, v] = mm;
      if (k === "contexts") {
        fm.contexts = v.replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "variables") {
        // variables 是多行结构，极简解析跳过（导入向导里让用户补）
      } else if (k === "id" || k === "name" || k === "version" || k === "description" || k === "phase" || k === "output") {
        (fm as any)[k] = v.trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return { fm, instructions };
}

/** 从纯文本 SKILL.md 导入（快速 Skill 入口） */
export function importSkillMd(filename: string, text: string): ImportResult {
  const { fm, instructions } = parseSkillMd(text);
  const warnings: string[] = [];
  // 校验 contexts 合法性
  const validContexts: SkillContext[] = (fm.contexts ?? ["prompt.text"]).filter(
    (c): c is SkillContext =>
      [
        "prompt.text", "prompt.image", "prompt.video",
        "director.project", "director.segment",
        "poster.layout", "ecom.layout",
        "agent.image", "agent.video",
      ].includes(c),
  );
  if (fm.contexts && validContexts.length !== fm.contexts.length) {
    warnings.push(`部分 contexts 值不合法，已保留合法项：${validContexts.join(", ")}`);
  }
  const validPhases: SkillPhase[] = ["analyze", "authoring", "model-adapter", "validate"];
  const phase = (fm.phase && validPhases.includes(fm.phase as SkillPhase) ? fm.phase : "authoring") as SkillPhase;
  const validOutputs: SkillOutput[] = ["text", "prompt-plan", "poster-plan", "director-plan"];
  const output = (fm.output && validOutputs.includes(fm.output as SkillOutput) ? fm.output : "text") as SkillOutput;

  const skill = newSkill({
    id: fm.id || undefined,
    name: fm.name || filename.replace(/\.md$/i, ""),
    version: fm.version || "1.0.0",
    description: fm.description || "",
    contexts: validContexts,
    phase,
    output,
    instructions,
    source: "import",
  });
  return { skill, warnings };
}

/** .momoskill ZIP 包内的 skill.json 结构 */
type SkillJson = {
  momoSkill?: number;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  contexts?: string[];
  phase?: string;
  output?: string;
  variables?: SkillVariable[];
};

/**
 * 从 .momoskill ZIP 解析（需传入已解压的文件映射）。
 * 本项目浏览器/Tauri 环境统一用 JSZip 解压，但为了不在 core 层引依赖，
 * 这里只接受「文件名 → 内容」的映射，解压由调用方完成。
 *
 * 安全检查：
 *  - 路径穿越：禁止包含 .. 或绝对路径的条目
 *  - 脚本文件：忽略并记 warning
 *  - 文件数量 / 总体积上限
 */
export function importSkillPackage(
  files: Map<string, Uint8Array | string>,
): ImportResult {
  const warnings: string[] = [];

  // 1. 安全检查：路径穿越 + 脚本文件 + 体积
  const blocked = [".js", ".mjs", ".cjs", ".py", ".sh", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".so", ".dylib"];
  let totalBytes = 0;
  const cleaned = new Map<string, Uint8Array | string>();
  for (const [path, content] of files) {
    // 路径穿越防御
    if (path.includes("..") || /^[\\/]/.test(path)) {
      warnings.push(`忽略路径不安全的条目：${path}`);
      continue;
    }
    // 脚本文件忽略
    const lower = path.toLowerCase();
    if (blocked.some((ext) => lower.endsWith(ext)) || lower.startsWith("scripts/")) {
      warnings.push(`当前版本不执行 Skill 脚本，已忽略：${path}`);
      continue;
    }
    const bytes = typeof content === "string" ? content.length : content.byteLength;
    totalBytes += bytes;
    cleaned.set(path, content);
  }
  if (cleaned.size > MAX_FILES) throw new Error(`Skill 包文件数量超过 ${MAX_FILES} 上限`);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Skill 包总体积超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`);

  // 2. 读 skill.json
  const jsonRaw = cleaned.get("skill.json");
  if (!jsonRaw) throw new Error("Skill 包缺少 skill.json（请确认这是 MOMO Skill 包）");
  let sj: SkillJson;
  try {
    sj = JSON.parse(typeof jsonRaw === "string" ? jsonRaw : new TextDecoder().decode(jsonRaw));
  } catch {
    throw new Error("skill.json 解析失败：文件不是合法 JSON");
  }
  if (sj.momoSkill !== 1) throw new Error("skill.json 的 momoSkill 字段不是 1，可能不是 MOMO Skill 包");

  // 3. 读 instructions.md
  const instructionsRaw = cleaned.get("instructions.md");
  const instructions = instructionsRaw
    ? typeof instructionsRaw === "string" ? instructionsRaw : new TextDecoder().decode(instructionsRaw)
    : "";

  // 4. 读 references/（只记文件名列表，内容留在内存 Map 供执行时读取；本轮暂不落盘）
  const references: string[] = [];
  for (const path of cleaned.keys()) {
    if (path.startsWith("references/") && !path.endsWith("/")) {
      references.push(path.slice("references/".length));
    }
  }

  // 5. 校验 contexts/phase/output 合法性（同 importSkillMd）
  const validContexts: SkillContext[] = (sj.contexts ?? ["prompt.text"]).filter(
    (c): c is SkillContext =>
      [
        "prompt.text", "prompt.image", "prompt.video",
        "director.project", "director.segment",
        "poster.layout", "ecom.layout",
        "agent.image", "agent.video",
      ].includes(c),
  );
  const validPhases: SkillPhase[] = ["analyze", "authoring", "model-adapter", "validate"];
  const phase = (sj.phase && validPhases.includes(sj.phase as SkillPhase) ? sj.phase : "authoring") as SkillPhase;
  const validOutputs: SkillOutput[] = ["text", "prompt-plan", "poster-plan", "director-plan"];
  const output = (sj.output && validOutputs.includes(sj.output as SkillOutput) ? sj.output : "text") as SkillOutput;

  const skill = newSkill({
    id: sj.id,
    name: sj.name || "未命名 Skill",
    version: sj.version || "1.0.0",
    description: sj.description || "",
    contexts: validContexts,
    phase,
    output,
    instructions,
    references,
    variables: sj.variables ?? [],
    source: "import",
  });
  return { skill, warnings };
}
