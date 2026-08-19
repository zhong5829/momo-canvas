/**
 * 自定义协议规格 — 占位符总表 + 协议 JSON 校验（协议助手生成 / 手动保存 / 校准 / 自愈四处共用）
 *
 * 占位符清单只在这里维护一份：以前 PROTOCOL_SYSTEM（协议助手）、REPAIR_SYSTEM（自愈）、
 * 三个服务层各写各的，扩了视频/音频能力之后提示词没跟上，模型压根不知道
 * {{duration}}/{{voice}} 存在，生成的协议天然接不上面板参数。
 */
import type { CustomProtocol } from "../types";

type VarDoc = { name: string; desc: string };

/** 三种用途都有的占位符 */
const COMMON_VARS: VarDoc[] = [
  { name: "baseUrl", desc: "服务商 Base URL（不含结尾斜杠）" },
  { name: "apiKey", desc: "API Key" },
  { name: "model", desc: "模型名" },
  { name: "prompt", desc: "提示词 / 朗读文本（已做 JSON 转义，模板里写在引号内）" },
  { name: "n", desc: "生成数量" },
  { name: "taskId", desc: "任务 ID（只在 poll 的 url/body 里用）" },
];

/** 按用途区分的占位符 */
const ROLE_VARS: Record<CustomProtocol["role"], VarDoc[]> = {
  image: [
    { name: "size", desc: '尺寸串，如 "1024x1024"（图生图可能是 auto）' },
    { name: "aspect", desc: '宽高比，如 "16:9"（不需要时为空）' },
    { name: "resolution", desc: "清晰度档 1K / 2K / 4K" },
    { name: "quality", desc: "质量档 high / medium / low" },
    { name: "image", desc: "第一张参考图 dataURL" },
    { name: "image2", desc: "第二张参考图 dataURL" },
    { name: "images", desc: "全部参考图的 JSON 数组字面量（模板里不要加引号，如 \"image_urls\": {{images}}）" },
    { name: "mask", desc: "局部重绘/扩图的蒙版 PNG dataURL" },
    { name: "seed", desc: "随机种子（数字串，锁定可复现；不传 = 随机）" },
    { name: "negative", desc: "负向提示词（不想出现的内容，已 JSON 转义）" },
  ],
  video: [
    { name: "duration", desc: '时长秒数字符串，如 "5"' },
    { name: "resolution", desc: '分辨率档，如 "720p"' },
    { name: "aspect", desc: '宽高比，如 "16:9"' },
    { name: "audio", desc: '是否生成音频 "true" / "false"' },
    { name: "size", desc: '由分辨率+比例折算的尺寸串，如 "1280x720"' },
    { name: "image", desc: "首帧图 dataURL" },
    { name: "image2", desc: "尾帧图 dataURL（首尾帧过渡）" },
    { name: "images", desc: "全部参考图的 JSON 数组字面量（不加引号）" },
    { name: "video", desc: "参考视频（URL 或 dataURL）" },
    { name: "refAudio", desc: "参考音频（URL 或 dataURL）" },
  ],
  audio: [{ name: "voice", desc: "音色 / 歌手 / 风格 ID" }],
};

/** 应用真正会注入的占位符全集（模板里出现清单外的 {{xxx}} 一律渲染成空串 → 属于配置错误） */
export const KNOWN_VARS: ReadonlySet<string> = new Set(
  [...COMMON_VARS, ...ROLE_VARS.image, ...ROLE_VARS.video, ...ROLE_VARS.audio].map((v) => v.name),
);

/** 占位符结构化清单（设置页「占位符参考」chips 用，与 varsDoc 同源，勿另抄一份） */
export function varList(role: CustomProtocol["role"]): VarDoc[] {
  return [...COMMON_VARS, ...ROLE_VARS[role]];
}

/** 喂给对话模型的占位符说明（按用途裁剪，生成/自愈共用同一份） */
export function varsDoc(role: CustomProtocol["role"]): string {
  const list = [...COMMON_VARS, ...ROLE_VARS[role]];
  const label = role === "video" ? "视频" : role === "audio" ? "音频" : "图片";
  return (
    `可用占位符（${label}生成，清单之外的占位符一律会被渲染成空串，不要自创）：\n` +
    list.map((v) => `  {{${v.name}}} — ${v.desc}`).join("\n")
  );
}

/** 协议里所有模板文本（url / body / headers，提交与轮询都算） */
export function protoTemplates(p: CustomProtocol): string[] {
  const out: string[] = [p.submit?.url ?? "", p.submit?.body ?? ""];
  for (const v of Object.values(p.submit?.headers ?? {})) out.push(v);
  if (p.poll) {
    out.push(p.poll.url ?? "", p.poll.body ?? "");
    for (const v of Object.values(p.poll.headers ?? {})) out.push(v);
  }
  return out.filter((s) => typeof s === "string");
}

/** 模板里出现过的占位符名（含条件块 {{?x}} / {{^x}}） */
export function placeholdersIn(p: CustomProtocol): Set<string> {
  const set = new Set<string>();
  for (const t of protoTemplates(p)) {
    for (const m of t.matchAll(/\{\{[?^/]?(\w+)\}\}/g)) set.add(m[1]);
  }
  return set;
}

/** 模板里应用不认识的占位符（拼错名字最典型：{{Prompt}} / {{text}} / {{input}}） */
export function unknownPlaceholders(p: CustomProtocol): string[] {
  return [...placeholdersIn(p)].filter((k) => !KNOWN_VARS.has(k));
}

/* ---------------- 协议 JSON 校验 ----------------
   对话模型吐出的 JSON 最常见的畸形是把 submit.body 写成对象而不是字符串模板：
   以前从生成到保存到执行全程零类型校验，一路存盘，最后以 `tpl.replace is not a function`
   这种原生 TypeError 糊到用户脸上。这里统一拦住，能自动纠的自动纠。 */

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function normHeaders(h: unknown, where: string): Record<string, string> | undefined {
  if (h === undefined || h === null) return undefined;
  if (typeof h !== "object" || Array.isArray(h)) throw new Error(`${where}.headers 必须是「键: 字符串」对象`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else throw new Error(`${where}.headers 的「${k}」不是字符串（值是 ${Array.isArray(v) ? "数组" : typeof v}）`);
  }
  return out;
}

/** body 允许模型写成对象：自动 JSON.stringify（占位符能原样存活），其它类型直接报错 */
function normBody(b: unknown, where: string, warnings: string[]): string | undefined {
  if (b === undefined || b === null || b === "") return undefined;
  if (typeof b === "string") return b;
  if (typeof b === "object") {
    warnings.push(`${where}.body 是对象而不是 JSON 字符串模板，已自动转成字符串`);
    return JSON.stringify(b);
  }
  throw new Error(`${where}.body 必须是 JSON 字符串模板，当前是 ${typeof b}`);
}

/**
 * 校验（并轻度纠正）一份协议 JSON。字段类型不合法时抛出中文可读错误，
 * 别等到运行时才以 `.replace is not a function` 的形式炸出来。
 */
export function validateProto(raw: unknown): { proto: CustomProtocol; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("协议不是一个 JSON 对象");
  const r = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const name = asStr(r.name);
  if (!name) throw new Error("协议缺少必填字段：name（协议显示名）");

  if (!r.submit || typeof r.submit !== "object" || Array.isArray(r.submit)) throw new Error("协议缺少 submit 提交配置");
  const submitUrl = asStr(r.submit.url);
  if (!submitUrl) throw new Error("协议缺少必填字段：submit.url（提交地址）");
  const submitMethod = r.submit.method === "GET" ? "GET" : r.submit.method === "POST" ? "POST" : undefined;
  const submitBody = normBody(r.submit.body, "submit", warnings);
  if (submitMethod === "GET" && submitBody) warnings.push("submit 是 GET 却带了 body，执行时不会发送");

  const resultPath = asStr(r.resultPath);
  if (!resultPath) throw new Error("协议缺少必填字段：resultPath（结果字段的 JSON 路径）");

  const proto: CustomProtocol = {
    id: asStr(r.id) ?? "",
    name,
    role: r.role === "video" ? "video" : r.role === "audio" ? "audio" : "image",
    submit: {
      url: submitUrl,
      ...(submitMethod ? { method: submitMethod } : {}),
      ...(normHeaders(r.submit.headers, "submit") ? { headers: normHeaders(r.submit.headers, "submit")! } : {}),
      ...(submitBody ? { body: submitBody } : {}),
    },
    resultPath,
    ...(asStr(r.taskIdPath) ? { taskIdPath: asStr(r.taskIdPath)! } : {}),
    ...(typeof r.verifiedAt === "number" ? { verifiedAt: r.verifiedAt } : {}),
  };

  if (r.poll !== undefined && r.poll !== null) {
    if (typeof r.poll !== "object" || Array.isArray(r.poll)) throw new Error("poll 必须是对象（异步轮询配置）");
    const pollUrl = asStr(r.poll.url);
    if (!pollUrl) throw new Error("poll.url（轮询地址）缺失或不是字符串");
    const statusPath = asStr(r.poll.statusPath);
    if (!statusPath) throw new Error("poll.statusPath（状态字段路径）缺失或不是字符串");
    const doneValue = asStr(r.poll.doneValue);
    if (!doneValue) throw new Error("poll.doneValue（表示完成的状态值）缺失或不是字符串");
    let interval = typeof r.poll.intervalMs === "number" ? r.poll.intervalMs : Number(r.poll.intervalMs);
    if (!Number.isFinite(interval) || interval <= 0) interval = 3000;
    // 钳制：AI 写出 intervalMs:100 会每分钟打 600 次查询（吃 429），写得太大则一次都发不出去
    const clamped = Math.min(30_000, Math.max(1000, Math.round(interval)));
    if (clamped !== interval) warnings.push(`poll.intervalMs ${interval} 已钳制到 ${clamped} 毫秒`);
    proto.poll = {
      url: pollUrl,
      ...(r.poll.method === "POST" ? { method: "POST" as const } : r.poll.method === "GET" ? { method: "GET" as const } : {}),
      ...(normHeaders(r.poll.headers, "poll") ? { headers: normHeaders(r.poll.headers, "poll")! } : {}),
      ...(normBody(r.poll.body, "poll", warnings) ? { body: normBody(r.poll.body, "poll", warnings)! } : {}),
      intervalMs: clamped,
      statusPath,
      doneValue,
      ...(asStr(r.poll.failValue) ? { failValue: asStr(r.poll.failValue)! } : {}),
    };
    if (!proto.taskIdPath && !pollUrl.includes("{{taskId}}"))
      warnings.push("配了 poll 却既没有 taskIdPath、轮询地址里也没有 {{taskId}}：轮询可能查不到本次任务");
  }

  const unknown = unknownPlaceholders(proto);
  if (unknown.length) warnings.push(`模板里有应用不认识的占位符（会被渲染成空串）：${unknown.map((k) => `{{${k}}}`).join(" ")}`);
  if (!placeholdersIn(proto).has("prompt")) warnings.push("模板里没有 {{prompt}}：提示词发不出去，生成结果会与输入无关");

  return { proto, warnings };
}

/** 稳定指纹：忽略键顺序与 verifiedAt，用来判断协议内容有没有被改过 */
export function protoFingerprint(p: CustomProtocol): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  const rest = { ...p };
  delete rest.verifiedAt;
  return JSON.stringify(sort(rest));
}

/** 宽容版：校验失败时返回 null（用于"能修就修、修不了走原路"的场景） */
export function tryValidateProto(raw: unknown): CustomProtocol | null {
  try {
    return validateProto(raw).proto;
  } catch {
    return null;
  }
}

/**
 * 自愈护栏：修复后的协议若把原本存在的关键占位符弄丢了，就不能写回。
 * 典型翻车：这次跑的是文生图，模型顺手把 {{images}}/{{mask}} 当"无用字段"删掉，
 * 重试成功照样保存，下次接参考图就直接报错。
 */
export function lostPlaceholders(before: CustomProtocol, after: CustomProtocol): string[] {
  const a = placeholdersIn(before);
  const b = placeholdersIn(after);
  return [...a].filter((k) => KNOWN_VARS.has(k) && !b.has(k));
}

/** 把写死的 Base URL 还原成 {{baseUrl}}（模型看到的执行现场是渲染后的真实地址，很容易照抄写死） */
export function retemplateBaseUrl(p: CustomProtocol, base: string): CustomProtocol {
  if (!base) return p;
  const fix = (s: string | undefined) => (typeof s === "string" && s.includes(base) ? s.split(base).join("{{baseUrl}}") : s);
  const out: CustomProtocol = {
    ...p,
    submit: { ...p.submit, url: fix(p.submit.url)!, ...(p.submit.body ? { body: fix(p.submit.body)! } : {}) },
  };
  if (p.poll) out.poll = { ...p.poll, url: fix(p.poll.url)!, ...(p.poll.body ? { body: fix(p.poll.body)! } : {}) };
  return out;
}
