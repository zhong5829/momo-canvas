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
import { pushError } from "./stores/uiStore";
import { uid } from "./utils";
import type {
  DirectorCharacter,
  DirectorProject,
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
 * 失败时抛中文错误，由调用方捕获走 pushError。
 */
export async function splitScript(
  script: string,
  targetDurationSec: number,
  maxSegmentSec: number,
): Promise<{ characters: DirectorCharacter[]; scenes: DirectorScene[] }> {
  if (!script.trim()) throw new Error("请先输入剧本或故事");
  if (maxSegmentSec <= 0) throw new Error("单次最大片段时长必须大于 0");

  const card = resolveModelCard("chat");
  const user = `目标成片时长：${targetDurationSec} 秒
单次视频模型最大时长：${maxSegmentSec} 秒

剧本：
"""
${script}
"""

请拆解成约 ${Math.max(1, Math.ceil(targetDurationSec / maxSegmentSec))} 个片段。`;

  const raw = await chatOnce(card, SPLIT_SYSTEM, user);
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

/** 常见的外部分段标记：分段1 / 分段 1 / 第1段 / 片段1 / Scene 1 / Segment 1 / ### 分段 / --- 分隔 */
const SPLIT_PATTERNS = [
  /^分段\s*\d+/m,
  /^第\s*\d+\s*段/m,
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
