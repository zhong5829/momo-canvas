/**
 * 导演台引擎 — 剧本拆分、生成调度、Take 状态管理
 *
 * 方案 §9 技术分层：directorEngine 不直接操作 React 状态，统一通过 useDirector.getState() 和现有 store API。
 * 运行失败统一 pushError("导演台 · 片段 N", msg)，并写入 Take 错误。
 *
 * 本轮实现：
 *  ① 剧本拆分（方案 §7.1）：LLM 两步法（剧情分析 → 时长装箱），返回结构化 JSON
 *  ② 外部剧本确定性切分（方案 §20.2）：识别「分段N」标记，不依赖 LLM
 *  ③ Take 创建/更新/采用（方案 §7.9）
 *
 * 后续切片实现：生成调度、队列、取消、跨重启恢复。
 */
import { chatOnce } from "./services/llm";
import { resolveModelCard } from "./stores/settingsStore";
import { useDirector } from "./stores/directorStore";
import { useSkills } from "./stores/skillStore";
import { pushError } from "./stores/uiStore";
import { buildSkillSystem } from "./skillEngine";
import { isVideoLoaderClass, isAudioLoaderClass } from "./services/comfy";
import { resolveSlotImages, refsNoteFromSnapshot } from "./directorRefs";
import { errMsg, uid } from "./utils";
import type {
  DirectorCharacter,
  DirectorProject,
  DirectorRecipe,
  DirectorScene,
  DirectorSegment,
  DirectorShot,
  DirectorTake,
  DirectorTimelineEntry,
} from "./types";

/* ---------------- 剧本拆分 ---------------- */

/** LLM 应返回的严格 JSON 结构（方案 §7.1） */
type ParsedScript = {
  title?: string;
  characters: Array<{ id: string; name: string; continuity: string }>;
  scenes: Array<{
    id: string;
    location: string;
    segments: Array<{
      id: string;
      durationSec: number;
      summary: string;
      dialogue: string[];
      shots: Array<{
        startSec: number;
        endSec: number;
        shotSize: string;
        camera: string;
        action: string;
        audio: string;
      }>;
      continuityIn?: string;
      continuityOut?: string;
      scriptRange?: [number, number];
    }>;
  }>;
};

const SPLIT_SYSTEM = `你是一位专业的影视导演与制片。用户会给你一段故事或剧本，请把它拆解成结构化的 JSON：

要求：
1. 按戏剧事件分「场 Scene」（同一地点/时间/事件）
2. 每场内按视频模型单次最大时长（用户会指定）拆成「生成片段 Segment」
3. 每个片段内按景别/机位变化拆成「镜头 Shot」（1-3 个）
4. 为每个出场人物分配稳定的 id，并描述外观与服装连续性
5. 每个 Segment 的 durationSec 不超过指定的单次最大时长
6. Shot 的时间连续、不重叠、不越过 Segment 边界
7. 对白、动作、景别、摄影机、音频要具体，不要空泛

只输出 JSON，不要任何解释。结构如下：
{
  "title": "标题",
  "characters": [{"id":"char_1","name":"角色名","continuity":"外观与服装说明"}],
  "scenes": [{"id":"scene_1","location":"地点","segments":[{"id":"seg_1","durationSec":15,"summary":"片段摘要","dialogue":["角色：台词"],"shots":[{"startSec":0,"endSec":6,"shotSize":"中景","camera":"缓慢推近","action":"动作描述","audio":"音效/音乐"}],"continuityIn":"承接上段","continuityOut":"结束时状态"}]}]
}`;

/**
 * 用 LLM 拆分剧本（方案 §7.1 两步法）。
 * skillSystem：项目绑定的拆分/提示词 Skill 指令（作为补充规范拼在内置规则之后，让「拆分能力」可做成 Skill 扩展）。
 * 失败时抛中文错误，由调用方捕获走 pushError。
 */
export async function splitScript(
  script: string,
  targetDurationSec: number,
  maxSegmentSec: number,
  skillSystem?: string,
): Promise<{ characters: DirectorCharacter[]; scenes: DirectorScene[] }> {
  if (!script.trim()) throw new Error("请先输入剧本或故事");
  if (maxSegmentSec <= 0) throw new Error("单次最大片段时长必须大于 0");

  const card = resolveModelCard("chat");
  // Skill 补充规范前后加防护框定：H3 写作类 Skill 里的「六段式输出模板」会把模型从拆分 JSON 契约上带偏
  // （整份剧本塞进一个片段、产出 H3 格式长文），必须声明它只约束拆分粒度、不是输出格式
  const system = skillSystem
    ? `${SPLIT_SYSTEM}\n\n【项目 Skill 补充规范（只用于指导拆分，不是输出格式）】\n${skillSystem}\n\n【再次强调】补充规范只影响「怎么切」：片段时长、单镜组织、场景/桥接等粒度约束。必须忽略其中任何关于输出格式或提示词模板的指令（如六段式、subject_definitions、## H3 头）。你的唯一任务仍是把剧本拆成多个场/片段/镜头的 JSON：禁止输出提示词模板，禁止把整份剧本并进单个片段。`
    : SPLIT_SYSTEM;
  const user = `目标成片时长：${targetDurationSec} 秒
单次视频模型最大时长：${maxSegmentSec} 秒

剧本：
"""
${script}
"""

请拆解成约 ${Math.max(1, Math.ceil(targetDurationSec / maxSegmentSec))} 个片段。`;

  const raw = await chatOnce(card, system, user);
  const parsed = parseScriptJson(raw);
  const result = normalizeParsedScript(parsed);
  // 校验：每个 segment 的 durationSec 不超过 maxSegmentSec（方案 §7.1）
  if (maxSegmentSec > 0) {
    result.scenes = result.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) => ({
        ...seg,
        durationSec: Math.min(seg.durationSec, maxSegmentSec),
        // 同步 clamp shots 的 endSec 到新的 durationSec
        shots: seg.shots.map((sh) => ({ ...sh, endSec: Math.min(sh.endSec, Math.min(seg.durationSec, maxSegmentSec)) })),
      })),
    }));
  }
  return result;
}

/** 从 LLM 返回的文本里提取 JSON（容错：可能有 markdown 代码块包裹） */
function parseScriptJson(raw: string): ParsedScript {
  let text = raw.trim();
  // 去掉可能的 ```json ... ``` 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // 找第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("模型没有返回有效的 JSON 结构");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("剧本拆分结果 JSON 解析失败，请重试或换一个对话模型");
  }
}

/** 把 LLM 返回的解析结构规整成内部类型 + 去重/校验 */
function normalizeParsedScript(
  parsed: ParsedScript,
): { characters: DirectorCharacter[]; scenes: DirectorScene[] } {
  const characters: DirectorCharacter[] = (parsed.characters ?? []).map((c) => ({
    id: c.id || uid(6),
    name: c.name || "未命名角色",
    continuity: c.continuity || "",
  }));

  const scenes: DirectorScene[] = (parsed.scenes ?? []).map((s) => {
    const sceneId = s.id || uid(6); // 先算一次，scene.id 和 segment.sceneId 共用
    return {
      id: sceneId,
      location: s.location || "未指定地点",
      segments: (s.segments ?? []).map((seg) => {
      const dur = seg.durationSec || 10;
      // 校验 Shot 时间边界：clamp 到 [0, dur]，相邻不重叠，无法容纳的过滤掉（P2-5 修复）
      let prevEnd = 0;
      const rawShots: DirectorShot[] = [];
      for (const sh of seg.shots ?? []) {
        let start = Math.max(prevEnd, sh.startSec ?? 0);
        let end = Math.min(dur, sh.endSec ?? dur);
        // 无法容纳（start >= dur）→ 停止添加后续镜头
        if (start >= dur) break;
        if (end <= start) end = Math.min(dur, start + 1);
        prevEnd = end;
        rawShots.push({
          id: uid(6),
          startSec: start,
          endSec: end,
          shotSize: sh.shotSize ?? "中景",
          camera: sh.camera ?? "",
          action: sh.action ?? "",
          audio: sh.audio ?? "",
        });
      }
      const shots = rawShots;
        const segment: DirectorSegment = {
          id: seg.id || uid(6),
          sceneId, // 复用上面的 sceneId，不再各调 uid(6)
        durationSec: seg.durationSec || 10,
        summary: seg.summary || "",
        dialogue: seg.dialogue ?? [],
        shots,
        continuityIn: seg.continuityIn,
        continuityOut: seg.continuityOut,
        scriptRange: seg.scriptRange,
        approvedTakeId: null,
        takes: [],
      };
      return segment;
    }),
    };
  });

  // 检查原文覆盖（方案 §7.1：LLM 不得静默丢段）
  const totalSegs = scenes.reduce((n, s) => n + s.segments.length, 0);
  if (totalSegs === 0) throw new Error("拆分结果没有任何片段，请检查剧本内容或换一个对话模型");

  return { characters, scenes };
}

/* ---------------- 确定性切分（方案 §20.2 外部剧本导入） ---------------- */

/** 常见的外部分段标记：分段1 / 分段 1 / 第1段 / 第一分段（中文数字） / 片段1 / Scene 1 / Segment 1 / ### 分段 / --- 分隔 */
const SPLIT_PATTERNS = [
  /^分段\s*\d+/m,
  /^#{0,4}\s*第\s*[0-9一二三四五六七八九十百零两]+\s*(?:分段|段)/m,
  /^片段\s*\d+/m,
  /^(?:Scene|Segment)\s*\d+/im,
  /^#{2,3}\s+.+/m, // markdown 二级/三级标题
];

/** 检测剧本是否含外部分段标记 */
export function hasExternalSegments(script: string, delimiter?: string): boolean {
  if (delimiter?.trim()) {
    // 自定义分段标记：至少出现一次就算有外部结构
    return script.split("\n").some((line) => line.includes(delimiter.trim()));
  }
  if (/^---+\s*$/m.test(script)) return true; // 单独一行的 ---
  return SPLIT_PATTERNS.some((re) => re.test(script));
}

/** 按自定义分隔符切分：行内含 delimiter 即在该行处下刀，分隔符行保留为下一段开头（通常是标题行） */
function splitByDelimiter(script: string, delimiter: string): string[] {
  const d = delimiter.trim();
  if (!d) return [script];
  const lines = script.split("\n");
  const parts: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.includes(d) && cur.some((l) => l.trim())) {
      parts.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.some((l) => l.trim())) parts.push(cur.join("\n"));
  const cleaned = parts.map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 1 ? cleaned : [script];
}

/** 分层切分结果：场 → 片段 */
export type StructuredSplit = { scenes: Array<{ title: string; parts: string[] }> };

/**
 * 分层确定性切分（方案 §20.2 扩展）：
 *  - 传了 sceneDelimiter：先切场，场内再按 delimiter / 内置标记 / 时长装箱切片段
 *  - 只传 delimiter：单层，按自定义标记切片段
 *  - 都不传：等同 deterministicSplit 的单层结果
 */
export function structuredSplit(
  script: string,
  maxSegmentSec: number,
  opts?: { delimiter?: string; sceneDelimiter?: string },
): StructuredSplit {
  const sceneDelim = opts?.sceneDelimiter?.trim() ?? "";
  const segDelim = opts?.delimiter?.trim() ?? "";
  const blocks = sceneDelim ? splitByDelimiter(script, sceneDelim) : [script];
  const scenes = blocks.map((block) => {
    const firstLine = (block.split("\n")[0] ?? "").trim();
    const titled = !!sceneDelim && firstLine.includes(sceneDelim);
    // 场名取分场标记行的剩余文本（如「第1场 咖啡馆」→「咖啡馆」），没有就用行本身
    const title = titled ? firstLine.replace(sceneDelim, "").trim() || firstLine.slice(0, 20) : "";
    const parts = segDelim ? splitByDelimiter(block, segDelim) : deterministicSplit(block, maxSegmentSec);
    return { title, parts };
  });
  return { scenes: scenes.filter((s) => s.parts.length > 0) };
}

/**
 * 确定性切分：按外部分段标记把剧本切成段落，不依赖 LLM。
 * 方案 §20.2 的「严格保留已有分段」模式。
 */
export function deterministicSplit(script: string, maxSegmentSec: number): string[] {
  // 先试 --- 分隔符
  let parts = script.split(/^---+\s*$/m).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts;

  // 再试各分段标记
  for (const re of SPLIT_PATTERNS) {
    // 保留原正则的 flags（m/i），只补 g——直接写 "gm" 会丢掉 Scene/Segment 的大小写不敏感标志
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const matches = [...script.matchAll(new RegExp(re.source, flags))];
    if (matches.length >= 2) {
      parts = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index!;
        const end = i + 1 < matches.length ? matches[i + 1].index! : script.length;
        parts.push(script.slice(start, end).trim());
      }
      return parts.filter(Boolean);
    }
  }
  // 没有标记 → 按段落时长装箱（粗略按字数比例分）
  const avgCharsPerSec = 4; // 粗估：每秒约 4 个字
  const targetLen = maxSegmentSec * avgCharsPerSec;
  if (script.length <= targetLen) return [script];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < script.length) {
    let end = Math.min(pos + targetLen, script.length);
    // 尽量在句末断
    if (end < script.length) {
      const nextBreak = script.slice(end).search(/[。！？\n]/);
      if (nextBreak >= 0 && nextBreak < 50) end += nextBreak + 1;
    }
    chunks.push(script.slice(pos, end).trim());
    pos = end;
  }
  return chunks.filter(Boolean);
}

/* ---------------- 剧本形态识别与成品提示词直录 ---------------- */

export type ScriptKind = "full" | "segmented" | "prompts";

/** 判定剧本形态：完整剧本 / 已分段分镜脚本 / 成品分段提示词包 */
export function detectScriptKind(script: string, delimiter?: string): ScriptKind {
  const t = script.trim();
  if (!t) return "full";
  // 标题/标记扫描一律在「围栏内容遮罩」文本上做：提示词正文里的 ## 行、subject_definitions 字样
  // 不能被当成小节头，否则会把一段提示词切碎
  const masked = maskFencedBodies(t);
  const h3Heads = masked.match(/^#{1,4}\s*H3-/gim)?.length ?? 0;
  const subjDefs = masked.match(/subject_definitions\s*:/g)?.length ?? 0;
  if (h3Heads >= 2 || subjDefs >= 2 || (h3Heads >= 1 && subjDefs >= 1)) return "prompts";
  // 通用提示词包特征：≥2 个「标题 + 代码围栏内容块」的小节
  if (countFencedSections(t) >= 2) return "prompts";
  // 无围栏通用包特征：≥2 个「序号-标题-时长」裸标题行（01-古刹闻客-11秒），每段自带时长与成品提示词
  if (countBareTitleHeads(masked) >= 2) return "prompts";
  if (hasExternalSegments(t, delimiter)) return "segmented";
  return "full";
}

/** 统计「序号-标题-时长」裸标题行数量（无围栏成品包的段头） */
function countBareTitleHeads(t: string): number {
  return [...t.matchAll(new RegExp(BARE_TITLE_SRC, "gim"))].length;
}

/**
 * 把围栏代码块的内部内容替换为等长空白（``` 行本身保留，外部索引不变）。
 * 标题/标记扫描用遮罩文本，防止提示词正文里的 `## xxx` 行被误认成小节头把一段提示词切碎；
 * 围栏行保留意味着「正文带围栏块」的判定在遮罩文本上同样成立。
 */
function maskFencedBodies(t: string): string {
  return t.replace(/(^|\n)([ \t]*```[^\n]*\n)([\s\S]*?)([ \t]*```[ \t]*(?=\n|$))/g, (_all, nl: string, open: string, body: string, close: string) =>
    nl + open + body.replace(/[^\n]/g, " ") + close,
  );
}

/** 统计「标题 + 代码围栏内容块」的小节数（通用提示词包特征；标题认 1-4 级） */
function countFencedSections(t: string): number {
  const heads = [...maskFencedBodies(t).matchAll(/^#{1,4}\s+(.+)$/gm)];
  let n = 0;
  for (let i = 0; i < heads.length; i++) {
    const body = t.slice(heads[i].index!, i + 1 < heads.length ? heads[i + 1].index! : t.length);
    if (/```/.test(body)) n++;
  }
  return n;
}

/**
 * 「序号-标题-时长」裸标题行（01-古刹闻客-11秒 / 02｜青衣叩门｜11s）：
 * 无围栏成品提示词包的段头特征——不用 markdown 头、不用代码围栏，每段标题行自带时长。
 */
const BARE_TITLE_SRC = "^\\d{1,3}\\s*[-－—–|｜][^\\n]{1,60}?[-－—–|｜]\\s*\\d+(?:\\.\\d+)?\\s*(?:秒|s|sec)\\s*$";
const isBareTitleLine = (l: string) => new RegExp(BARE_TITLE_SRC, "i").test(l);
/** 纯分段序号头（# 第一分段 / 共十五分段）：只承载序号，真实标题（01-古刹闻客-11秒）在其后一行 */
const INDEX_HEAD_RE = /^#{1,4}\s*第\s*[0-9一二三四五六七八九十百零两]+\s*(?:分段|场|幕)(?:\s*[/／][^\n]*)?$/;

/** 判断提示词是否已是 H3 成品格式（精炼/直录产物），生成时不再重复拼 Skill 全文指令 */
export function isH3ReadyPrompt(text: string): boolean {
  return /subject_definitions\s*:/.test(text) || /^##\s*H3-/im.test(text);
}

/**
 * 通用片段标题解析：`## H3-01｜三岁的画｜12 秒` / `## 分镜1 开场` / `## 回家第一句 16s` 都认。
 * 剥掉 H3-N 序号前缀与尾部时长（全角｜/半角|/中文「秒」都行），返回净标题与时长。
 */
function parseSegmentTitle(line: string): { title?: string; durationSec?: number } {
  let s = line.replace(/^#{1,4}\s*/, "").trim();
  // H3-01 / 分镜01 / 第一分段（中文数字）等序号前缀
  s = s.replace(/^(?:H3[-_ ]?\d+|分镜\s*\d+|第\s*[0-9一二三四五六七八九十百零两]+\s*分段?|Scene\s*\d+)\s*[|｜:：\-—]?\s*/i, "");
  // 裸序号标题（01-古刹闻客-11秒）的 NN- 前缀：只认 1-3 位数字 + 分隔符，避免误吞 1988- 这类年份
  s = s.replace(/^\d{1,3}\s*[-－—–.、)）]\s*/, "");
  // 尾部时长：｜12 秒 / | 12s / 12秒
  let durationSec: number | undefined;
  const dm = s.match(/[|｜]\s*(\d+(?:\.\d+)?)\s*(?:s|秒|sec)?\s*$/i) ?? s.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec)\s*$/i);
  if (dm) {
    durationSec = Number(dm[1]);
    s = s.slice(0, dm.index).replace(/[|｜\s\-—]+$/, "").trim();
  }
  return { title: s || undefined, durationSec };
}

/** 剥掉 markdown 代码围栏行（```text / ```），保留正文内容 */
function stripFenceLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*```/.test(l))
    .join("\n")
    .trim();
}

/** 从提示词包的前言里提取「定调/风格」内容：优先认风格小节标题，退化到前言里第一个代码围栏块 */
export function extractGlobalStyle(prefix: string): string | undefined {
  if (!prefix.trim()) return undefined;
  // 优先认「## 全局风格锚定 / ## 风格定调 / ## 统一风格」一类小节
  const sec = prefix.match(/##\s*(?:全局风格锚定|风格锚定|全剧风格|统一风格定调|风格定调|统一风格|定调|全局风格|风格)\s*\n([\s\S]*)$/i);
  const body = (sec ? sec[1] : prefix).trim();
  const fenced = body.match(/```(?:text|markdown|md|prompt)?\s*\n([\s\S]*?)```/);
  if (sec || fenced) {
    const out = (fenced ? fenced[1] : body).trim();
    return out.length >= 20 ? out : undefined;
  }
  // 兜底（无风格小节、无围栏块）：前言逐行过筛，只收带风格/规格关键词的行——
  // 主标题、故事概述、总分段数/总时长这类元信息不是风格锚定，整段塞进每段提示词只会产生噪声
  const keep = prefix
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^#{1,4}\s/.test(l))
    .filter((l) => !/^(?:故事概述|剧情简介|故事梗概|梗概|简介|总分段数|总时长|共\s*\S+\s*分段)/.test(l))
    .filter((l) => /风格|画风|画质|色调|规格|画幅|帧率|fps|光影|质感|锚定/.test(l));
  const out = keep.join("\n").trim();
  return out.length >= 20 ? out : undefined;
}

/** 统计成品提示词段数（识别条显示用）：H3 头 / subject_definitions / 带围栏块的通用小节 */
export function countPromptSegments(script: string): number {
  const t = script.trim();
  if (!t) return 0;
  const masked = maskFencedBodies(t);
  const heads = masked.match(/^#{1,4}\s*H3-/gim)?.length ?? 0;
  if (heads > 0) return heads;
  const sd = masked.match(/subject_definitions\s*:/g)?.length ?? 0;
  if (sd > 0) return sd;
  const bare = countBareTitleHeads(masked);
  if (bare > 0) return bare;
  return countFencedSections(t);
}

/** 收集片段起点：H3 头 → subject_definitions → 通用「标题」（序号标题或带围栏块的小节，认 1-4 级） */
function collectSegmentMarks(t: string): number[] {
  const masked = maskFencedBodies(t);
  const h3 = [...masked.matchAll(/^#{1,4}\s*H3-[\w-]+.*$/gim)].map((m) => m.index!);
  if (h3.length) return h3;
  const sd = [...masked.matchAll(/subject_definitions\s*:/g)].map((m) => m.index!);
  if (sd.length) return sd;
  // 通用提示词包：标题（1-4 级）带序号（H3-N/第N段/分镜N/Scene N/1.）或正文带围栏块的算片段；
  // 定调/风格/说明类小节永远不作片段起点（其围栏块是风格内容，不是分镜提示词），内容自然并入前言
  const STYLE_HEAD = /风格|定调|锚定|说明|规则|注意|前言|简介|资产|附录|参考|原则/;
  const heads = [...masked.matchAll(/^#{1,4}\s+(.+)$/gm)];
  const segMarks: number[] = [];
  heads.forEach((h, i) => {
    const title = h[1];
    if (STYLE_HEAD.test(title)) return;
    const body = t.slice(h.index!, i + 1 < heads.length ? heads[i + 1].index! : t.length);
    const looksSegment =
      /(?:H3[-_ ]?\d+|第\s*[0-9一二三四五六七八九十百零两]+\s*(?:分段|段|集|镜)|分镜\s*\d+|Scene\s*\d+|^\d+\s*[.、)）])/i.test(title) ||
      /```/.test(body) ||
      /subject_definitions\s*:/.test(body);
    if (looksSegment) segMarks.push(h.index!);
  });
  if (segMarks.length) return segMarks;
  // 无 markdown 头的包：「序号-标题-时长」裸标题行自己当段头
  const bare = [...masked.matchAll(new RegExp(BARE_TITLE_SRC, "gim"))].map((m) => m.index!);
  if (bare.length >= 2) return bare;
  return segMarks;
}

/**
 * 成品分段提示词包直录（通用）：剧本 = 定调前言 + 片段列表（片段标题 + 片段内容/围栏提示词块）。
 * 切段点按 collectSegmentMarks；每段标题→summary（全角｜/「12 秒」单位都认）、剥掉代码围栏后全文→promptOverride、
 * locked 标记防被重拆覆盖。前言里的「定调/风格锚定」提取为 globalStyle，由调用方写进 ruleSet.positive.style。
 */
export function importPromptSegments(script: string, maxSegmentSec: number): { scenes: DirectorScene[]; globalStyle?: string } {
  const t = script.trim();
  if (!t) throw new Error("请先粘贴分段提示词");
  const marks = collectSegmentMarks(t);
  let parts: string[];
  let prefix = "";
  if (marks.length >= 1) {
    prefix = t.slice(0, marks[0]); // 前言：主标题/说明/全局风格定调
    parts = marks.map((start, i) => t.slice(start, i + 1 < marks.length ? marks[i + 1] : t.length).trim()).filter(Boolean);
  } else {
    parts = deterministicSplit(t, maxSegmentSec);
  }
  if (!parts.length) throw new Error("没有识别出任何分段提示词");
  const globalStyle = extractGlobalStyle(prefix);
  // 主标题（前言里的 markdown 标题行）作为唯一场景的场名，没有就「分镜提示词」
  const mainTitle = prefix.match(/^#{1,4}\s+(.+)$/m)?.[1]?.trim();
  const sceneId = "scene_prompts";
  const segments: DirectorSegment[] = parts.map((raw, i) => {
    // 段尾的 --- 分隔线先剥掉（按下一分段头切时，分隔线会落在上一段尾部），再剥围栏行
    const text = stripFenceLines(raw.replace(/(?:\r?\n[ \t]*-{3,}[ \t]*)+\s*$/, ""));
    const lines = text.split("\n");
    let li = 0;
    while (li < lines.length && !lines[li].trim()) li++;
    let titleLine = (lines[li] ?? "").trim();
    // 纯分段序号头（# 第一分段 / 共十五分段）只承载序号：真正的标题在下一非空行
    if (INDEX_HEAD_RE.test(titleLine)) {
      li++;
      while (li < lines.length && !lines[li].trim()) li++;
      titleLine = (lines[li] ?? "").trim();
    }
    const head = parseSegmentTitle(titleLine);
    const dur = head.durationSec && head.durationSec >= 4 && head.durationSec <= 60 ? Math.round(head.durationSec) : maxSegmentSec;
    // 成品提示词本体优先取 ```text 围栏（语言标记大小写不敏感；N/A 占位结尾行剥掉），其余语言围栏后备；
    // 上方的 **Purpose** 等元数据是中文规划信息，不进提示词（分镜卡折叠视图会按需解析展示六段正文）。
    // 无围栏的裸标题包：标题行（markdown 头或 01-古刹闻客-11秒 段头）与 TEXT 包装行是结构行，不进提示词本体
    const fenced = raw.match(/```text[ \t]*\r?\n([\s\S]*?)```/i) ?? raw.match(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/);
    const structuralTitle = /^#{1,4}\s+\S/.test(titleLine) || isBareTitleLine(titleLine);
    let body = structuralTitle || fenced ? lines.slice(li + 1).join("\n") : text;
    body = body.replace(/^[ \t]*(?:TEXT|PROMPT)[ \t]*\r?\n/i, "");
    const promptBody = (fenced ? fenced[1] : body).replace(/\n[ \t]*n\/a[ \t]*(?:\r?\n)*$/i, "").trim();
    return {
      id: `seg_p_${i + 1}`,
      sceneId,
      durationSec: dur,
      summary: head.title || titleLine.replace(/^#{1,4}\s*/, "").slice(0, 40) || `提示词 ${i + 1}`,
      dialogue: [],
      shots: [],
      promptOverride: promptBody,
      locked: true,
      approvedTakeId: null,
      takes: [],
    };
  });
  return { scenes: [{ id: sceneId, location: mainTitle || "分镜提示词", segments }], globalStyle };
}

/* ---------------- AI 精读：规则切段后逐段提取结构化内容 ---------------- */

/**
 * 精读输出契约：已切好的片段原文 → 结构化分镜字段（摘要/时长/对白/镜头/连续性）。
 * 规则切段只负责边界（快、免费、零误差）；内容的结构化理解交给对话模型。
 */
const SEGMENT_READ_SYSTEM = `你是影视分镜分析师。用户给你一个已经切好的剧本片段原文，请提取结构化分镜内容，只输出 JSON，不要任何解释：

{
  "summary": "一句话概括本段（20 字内）",
  "durationSec": 12,
  "dialogue": ["角色：台词"],
  "shots": [{"startSec": 0, "endSec": 6, "shotSize": "中景", "camera": "缓慢推近", "action": "动作描述", "audio": "音效/音乐"}],
  "continuityIn": "承接上段的状态（没有就空字符串）",
  "continuityOut": "本段结束时的状态（没有就空字符串）"
}

规则：
- durationSec 按对白字数与动作复杂度估计，4-18 秒之间
- 无对白给空数组；shots 1-2 个，时间是段内相对时间且不重叠
- 原文里明确的信息才提取，不要编造人物、道具或台词`;

type SegmentReadResult = {
  summary?: string;
  durationSec?: number;
  dialogue?: string[];
  shots?: Array<{ startSec?: number; endSec?: number; shotSize?: string; camera?: string; action?: string; audio?: string }>;
  continuityIn?: string;
  continuityOut?: string;
};

/**
 * AI 精读分段：对规则切段（detect/structuredSplit）产生的片段逐段调对话模型，
 * 把原文提取成结构化分镜字段（summary/dialogue/shots/durationSec/连续性），写回 segment。
 * 跳过 locked 段（成品提示词直录段不该被覆盖）与已有结构化内容的段（除非显式指定 segmentIds）。
 * 项目绑定的 Skill 规范会注入 system（与拆分/精炼同一套绑定）。
 */
export async function analyzeSegmentsWithLLM(
  projectId: string,
  segmentIds?: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; failed: number; skipped: number }> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) throw new Error("项目不存在");
  const card = resolveModelCard("chat");
  const skillSys = (proj.skillBindings ?? [])
    .filter((b) => b.enabled)
    .map((b) => {
      const sk = useSkills.getState().getById(b.skillId);
      return sk ? buildSkillSystem(sk, b.values) : "";
    })
    .filter(Boolean)
    .join("\n\n");
  // 与拆分同款防护：Skill 只用于内容理解（动作/镜头/时长语义），输出格式必须是本任务的 JSON
  const system = skillSys
    ? `${SEGMENT_READ_SYSTEM}\n\n【项目 Skill 补充规范（只用于内容理解，不是输出格式）】\n${skillSys}\n\n【再次强调】补充规范只帮助你理解动作、镜头与时长语义；必须忽略其中任何输出格式或提示词模板指令，只输出本任务要求的 JSON。`
    : SEGMENT_READ_SYSTEM;

  const all = proj.scenes.flatMap((s) => s.segments);
  const targets = all.filter((seg) => {
    if (segmentIds) return segmentIds.includes(seg.id);
    if (seg.locked) return false; // 成品直录段不动
    // 已有结构化内容（镜头/对白）的段默认跳过，不重复花钱
    return !seg.shots.length && !seg.dialogue.length;
  });
  const totalAll = all.filter((seg) => (segmentIds ? segmentIds.includes(seg.id) : true)).length;
  if (!targets.length) return { ok: 0, failed: 0, skipped: totalAll };

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const seg = targets[i];
    try {
      const raw = await chatOnce(card, system, `片段原文：\n"""\n${seg.scriptText ?? seg.promptOverride ?? seg.summary}\n"""`);
      const parsed = parseSegmentReadJson(raw);
      const dur = parsed.durationSec && parsed.durationSec >= 4 && parsed.durationSec <= 60 ? Math.round(parsed.durationSec) : seg.durationSec;
      // 镜头时间 clamp 到段内（沿用 normalizeParsedScript 的边界规则）
      let prevEnd = 0;
      const shots: DirectorShot[] = [];
      for (const sh of parsed.shots ?? []) {
        const start = Math.max(prevEnd, sh.startSec ?? 0);
        let end = Math.min(dur, sh.endSec ?? dur);
        if (start >= dur) break;
        if (end <= start) end = Math.min(dur, start + 1);
        prevEnd = end;
        shots.push({
          id: uid(6),
          startSec: start,
          endSec: end,
          shotSize: sh.shotSize ?? "中景",
          camera: sh.camera ?? "",
          action: sh.action ?? "",
          audio: sh.audio ?? "",
        });
      }
      // 写回（读最新项目，避免覆盖精读期间的其它改动）；原文摘要若原文本身是长文则保留原 summary 的前 50 字
      const cur = useDirector.getState().getById(projectId);
      if (!cur) throw new Error("项目已被关闭");
      useDirector.getState().updateProject(projectId, {
        scenes: cur.scenes.map((s) => ({
          ...s,
          segments: s.segments.map((x) =>
            x.id === seg.id
              ? {
                  ...x,
                  summary: parsed.summary?.trim() || x.summary,
                  durationSec: dur,
                  dialogue: (parsed.dialogue ?? []).filter(Boolean),
                  shots,
                  continuityIn: parsed.continuityIn || x.continuityIn,
                  continuityOut: parsed.continuityOut || x.continuityOut,
                }
              : x,
          ),
        })),
      });
      ok++;
    } catch (e) {
      failed++;
      directorError(`精读 · ${seg.summary.slice(0, 12)}`, errMsg(e));
    }
    onProgress?.(i + 1, targets.length);
  }
  return { ok, failed, skipped: totalAll - targets.length };
}

/** 解析精读返回的单对象 JSON（容错：剥 markdown 围栏、取首个 { 到末个 }） */
function parseSegmentReadJson(raw: string): SegmentReadResult {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("模型没有返回有效的 JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("精读结果 JSON 解析失败，请重试");
  }
}

/* ---------------- Skill 精炼：逐段产出 H3 成品提示词 ---------------- */
/** 追加在 Skill 指令之后的输出契约：固定六段式 + 元数据头，便于直录/识别 */
const H3_REFINE_CONTRACT = `

【输出契约】只输出这一个分镜的 H3 提示词，不要任何解释或前后缀。结构严格如下：

## H3-XX | 分段标题 | 时长s

**Purpose**:
**Continuity bridge in**:
**Continuity bridge out**:
**Reference image order**: <Picture 1> ..., <Picture 2> ...
**Characters**:
**Scene**:
**Props**:
**Dialogue**:
**Camera**:

subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...`;

/**
 * 用项目绑定的 Skill（如 MiniMax H3 Prompt）把每个分镜精炼成 H3 成品提示词。
 * 参考图顺序在精炼时锁进 user 消息（skill 规则：先锁顺序再写提示词）。
 * 结果写 segment.promptOverride；失败段记报错中心、不阻断整批。
 */
export async function refineSegmentPrompts(
  projectId: string,
  segmentIds?: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; failed: number; skipped: number }> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) throw new Error("项目不存在");
  const skillsState = useSkills.getState();
  const bound = (proj.skillBindings ?? [])
    .filter((b) => b.enabled)
    .map((b) => ({ b, sk: skillsState.getById(b.skillId) }))
    .filter((x): x is { b: (typeof proj.skillBindings extends (infer T)[] | undefined ? T : never); sk: NonNullable<ReturnType<typeof skillsState.getById>> } => !!x.sk);
  if (!bound.length) throw new Error("请先在「剧本」页的项目级 Skill 里勾选提示词 Skill（如 MiniMax H3 Prompt）");
  const system = bound.map(({ b, sk }) => buildSkillSystem(sk, b.values)).join("\n\n") + H3_REFINE_CONTRACT;
  const card = resolveModelCard("chat");
  const targets = proj.scenes.flatMap((s) => s.segments).filter((seg) => !segmentIds || segmentIds.includes(seg.id));
  if (!targets.length) throw new Error("没有需要精炼的片段（请先在剧本页拆分）");
  // 成品直录段（locked）不可精炼：它本身就是 H3 成品，精炼会用 AI 重写覆盖原文（数据事故来源）
  const runnable = targets.filter((seg) => !seg.locked);
  // 全部锁定：不算失败（提示词已是成品，本就无需精炼），返回 skipped 让调用方给指引性提示
  if (!runnable.length) return { ok: 0, failed: 0, skipped: targets.length };
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < runnable.length; i++) {
    const seg = runnable[i];
    try {
      const refs = await resolveSlotImages(proj, seg);
      const refNote = refs ? refsNoteFromSnapshot(refs.snapshot, "video") : "";
      const user = [
        `分镜时长：${seg.durationSec} 秒`,
        `分镜摘要：${seg.summary}`,
        seg.dialogue.length ? `对白：${seg.dialogue.join("；")}` : "",
        seg.shots.length ? `镜头：${seg.shots.map((sh) => `${sh.shotSize}/${sh.camera}/${sh.action}`).join("；")}` : "",
        seg.continuityIn ? `承接上段：${seg.continuityIn}` : "",
        seg.continuityOut ? `结束状态：${seg.continuityOut}` : "",
        refNote ? `参考图顺序（<Picture N> 即「图N」）：\n${refNote}` : "本段无参考图。",
        proj.characters.length ? `角色连续性：${proj.characters.map((c) => `${c.name}=${c.continuity}`).join("；")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const raw = await chatOnce(card, system, user);
      const cleaned = stripToH3Prompt(raw);
      if (!isH3ReadyPrompt(cleaned)) throw new Error("模型返回不符合 H3 格式，请重试");
      // 写回 promptOverride（读最新项目，避免覆盖精炼期间的其它改动）
      const cur = useDirector.getState().getById(projectId);
      if (!cur) throw new Error("项目已被关闭");
      useDirector.getState().updateProject(projectId, {
        scenes: cur.scenes.map((s) => ({
          ...s,
          segments: s.segments.map((x) => (x.id === seg.id ? { ...x, promptOverride: cleaned } : x)),
        })),
      });
      ok++;
    } catch (e) {
      failed++;
      directorError(`精炼 · ${seg.summary.slice(0, 12)}`, errMsg(e));
    }
    onProgress?.(i + 1, runnable.length);
  }
  return { ok, failed, skipped: targets.length - runnable.length };
}

/** 清洗模型输出：剥代码围栏、剥闲聊前缀，只保留 H3 提示词本体 */
function stripToH3Prompt(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/```(?:text|markdown|md)?\s*([\s\S]*?)```/);
  if (fence && isH3ReadyPrompt(fence[1])) text = fence[1].trim();
  const headIdx = text.search(/^##\s*H3-/im);
  if (headIdx > 0) return text.slice(headIdx).trim();
  const sdIdx = text.search(/subject_definitions\s*:/);
  if (sdIdx > 0) return text.slice(sdIdx).trim();
  return text;
}

/* ---------------- Take 管理 ---------------- */

/** 创建一个 Take（不可变快照，方案 §7.9） */
export function createTake(
  segmentId: string,
  kind: DirectorTake["kind"],
  target: DirectorTake["target"],
  prompt: string,
): DirectorTake {
  return {
    id: uid(8),
    segmentId,
    kind,
    target,
    status: "queued",
    promptSnapshot: prompt,
    createdAt: Date.now(),
  };
}

/** 采用一个 Take（修改 segment 的 approvedTakeId，方案 §7.9） */
export function approveTake(projectId: string, segmentId: string, takeId: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  // 校验 takeId 属于该 segment（防跨 segment 误用）
  const seg = proj.scenes.flatMap((s) => s.segments).find((x) => x.id === segmentId);
  if (!seg || !(seg.takes ?? []).some((t) => t.id === takeId)) return;
  const scenes = proj.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((seg) =>
      seg.id === segmentId
        ? {
            ...seg,
            approvedTakeId: takeId,
            takes: (seg.takes ?? []).map((t) => ({ ...t, approved: t.id === takeId })),
          }
        : seg,
    ),
  }));
  useDirector.getState().updateProject(projectId, { scenes });
  // 采用后自动更新时间线
  rebuildTimeline(projectId);
}

/**
 * 重建时间线：把所有采用版本按场景/片段顺序排进 timeline（方案 §7.10）。
 * 缺片（未采用）的片段不进时间线，会在剪辑页显示为占位。
 */
export function rebuildTimeline(projectId: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const entries: DirectorTimelineEntry[] = [];
  for (const scene of proj.scenes) {
    for (const seg of scene.segments) {
      if (!seg.approvedTakeId) continue;
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (!take || take.status !== "done") continue;
      entries.push({
        segmentId: seg.id,
        takeId: take.id,
        durationSec: seg.durationSec,
      });
    }
  }
  useDirector.getState().updateProject(projectId, { timeline: entries });
}

/**
 * 从 scenes + approvedTakeId 派生时间线（P1-2 修复：不再只依赖持久化的 project.timeline）。
 * 供剪辑页展示、导出 XML/SRT/预览统一调用，确保与实际采用状态一致。
 */
export function deriveTimeline(project: DirectorProject): DirectorTimelineEntry[] {
  const entries: DirectorTimelineEntry[] = [];
  for (const scene of project.scenes) {
    for (const seg of scene.segments) {
      if (!seg.approvedTakeId) continue;
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (!take || take.status !== "done") continue;
      entries.push({
        segmentId: seg.id,
        takeId: take.id,
        durationSec: seg.durationSec,
      });
    }
  }
  return entries;
}

/** 统计项目完成度 */
export function projectProgress(project: DirectorProject): {
  total: number;
  approved: number;
  missing: number;
  durationSec: number;
} {
  let total = 0;
  let approved = 0;
  let durationSec = 0;
  for (const s of project.scenes) {
    for (const seg of s.segments) {
      total++;
      durationSec += seg.durationSec;
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (take?.status === "done") approved++;
    }
  }
  return { total, approved, missing: total - approved, durationSec };
}

/** 统一报错入口 */
export function directorError(source: string, msg: string): void {
  pushError(`导演台 · ${source}`, msg);
}

/* ---------------- 生成配方的选择与模板直选 ---------------- */

/** ComfyUI 模板的极简形状（避免 UI 层直接依赖 comfyStore 类型） */
export type ComfyTplLike = { id: string; name: string; workflow: unknown };

/**
 * 从 ComfyUI 模板构建生成配方：按工作流里有没有 LoadVideo/LoadAudio 类节点推断能力快照
 * （REF2VA 有视/音接口 → r2v 多参考；否则按 FL2VA 首尾帧）。
 */
export function comfyRecipeFromTemplate(tpl: ComfyTplLike): DirectorRecipe {
  const types = Object.values(tpl.workflow as Record<string, { class_type?: string }>).map((n) => n?.class_type ?? "");
  const hasVideo = types.some(isVideoLoaderClass);
  const hasAudio = types.some(isAudioLoaderClass);
  const isR2V = hasVideo || /REF2VA|多参考/i.test(tpl.name);
  return {
    id: uid(6),
    name: tpl.name,
    engine: "comfy",
    output: "video",
    mode: isR2V ? "r2v" : "fl2v",
    templateId: tpl.id,
    capabilitySnapshot: {
      firstFrame: true,
      lastFrame: !isR2V,
      referenceImages: 4,
      referenceVideos: hasVideo ? 3 : 0,
      referenceAudio: hasAudio ? 3 : 0,
      nativeAudio: true,
    },
    defaultParams: {},
  };
}

/**
 * 配方下拉选项：远程默认 + 已有配方 + 未建配方的 ComfyUI 模板（`tpl:` 前缀 = 直选模板，选中时自动建配方）。
 * 顶栏、分镜页批量条、片段卡共用，保证三处看到同一套选择。
 */
export function recipeOptions(project: DirectorProject, templates: ComfyTplLike[]): Array<{ value: string; label: string }> {
  const withRecipe = new Set(project.recipes.map((r) => r.templateId).filter((v): v is string => !!v));
  return [
    { value: "", label: "远程默认（设置里的视频模型）" },
    ...project.recipes.map((r) => ({ value: r.id, label: `${r.name}${r.engine === "comfy" ? " · ComfyUI" : ""}` })),
    ...templates
      .filter((t) => !withRecipe.has(t.id))
      .map((t) => ({ value: `tpl:${t.id}`, label: `${t.name} · ComfyUI 模板` })),
  ];
}

/**
 * 处理配方下拉的选中值（"" / 配方 id / `tpl:模板id`）：
 * 直选模板时复用同模板已有配方或新建，返回可直接并进 updateProject 的字段。
 */
export function resolveRecipeSelection(
  project: DirectorProject,
  value: string,
  templates: ComfyTplLike[],
): { recipes?: DirectorRecipe[]; recipeId?: string } {
  if (!value.startsWith("tpl:")) return { recipeId: value || undefined };
  const tplId = value.slice(4);
  const exist = project.recipes.find((r) => r.templateId === tplId);
  if (exist) return { recipeId: exist.id };
  const tpl = templates.find((t) => t.id === tplId);
  if (!tpl) return { recipeId: undefined };
  const recipe = comfyRecipeFromTemplate(tpl);
  return { recipes: [...project.recipes, recipe], recipeId: recipe.id };
}

/**
 * 百万像素 + 画幅 → 实际宽高（喂给 ComfyUI 工作流用）。
 * 宽高对齐到 16 的倍数（视频 latent 的通用约束）；输入侧不设最小值限制，这里是发送前的规整。
 */
export function mpToSize(aspect: string, mp: number): { width: number; height: number } {
  const m = aspect.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  const r = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 16 / 9;
  const total = Math.max(0.01, Number.isFinite(mp) ? mp : 1) * 1_000_000;
  const h0 = Math.sqrt(total / r);
  const q = (v: number) => Math.max(16, Math.round(v / 16) * 16);
  return { width: q(h0 * r), height: q(h0) };
}
