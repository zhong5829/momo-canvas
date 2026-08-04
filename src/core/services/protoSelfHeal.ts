/**
 * 协议自愈 — 自定义协议运行失败时的自动闭环：
 *  发现错误（捕获失败 + 执行现场）→ 理解错误（交给用户配置的对话模型）→ 修改错误（生成修正协议）
 *  → 衔接（用修正协议自动重试一次；成功才写回设置，失败回滚不留坏协议）
 * 网络/鉴权/额度类错误不属于协议配置问题，不触发自愈（避免白花重试费用）。
 */
import type { CustomProtocol } from "../types";
import { toast } from "../stores/uiStore";
import { errMsg, parseJsonLoose } from "../utils";
import { lostPlaceholders, retemplateBaseUrl, validateProto, varsDoc } from "./protoSpec";

/** 这些错误修协议也没用：跳过自愈，直接按原错误上报 */
const SKIP_PATTERNS = [
  /\b40[13]\b/, /unauthorized/i, /forbidden/i,
  /\b429\b/, /rate.?limit/i, /quota/i, /insufficient/i, /余额|欠费|额度/,
  /error sending request/i, /dns/i, /no such host/i, /certificate|ssl|tls/i,
  /协议不存在/, /的用途是/,
  // ↓ 以下几类都是「任务已提交、钱已经扣了」或纯服务端问题：改协议救不回来，
  //   重试等于再交一次生成费用，还要再等一个完整的超时窗口
  /轮询超时|生成超时/, /任务失败（状态/,
  /请求失败 5\d{2}/, /bad gateway|service unavailable|gateway timeout|internal server error/i,
  /已取消|aborted|request cancelled/i,
  /结果下载失败/, /协议模板字段不是字符串/,
];

function repairable(msg: string): boolean {
  return !SKIP_PATTERNS.some((re) => re.test(msg));
}

const repairSystem = (role: CustomProtocol["role"]) => `你是 API 协议修复专家。momo 画布用一份声明式 JSON 协议调用 AI 生成中转站。
${varsDoc(role)}
条件块语法：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留。
JSON 路径语法：点号访问字段，数组展开加 []（可嵌套，如 data.result.images[].url[]，末段是字符串数组时也要加 []）。

本次调用失败了。你会看到：当前协议 JSON、报错信息、执行现场（真实请求与响应，密钥已脱敏、超长内容已折叠成 <长字符串 N 字符>）。
请对照真实响应找出协议配置的偏差（常见：taskIdPath / poll.url / poll.statusPath / poll.doneValue / resultPath 写错，或同步异步判断错误）。
【硬性要求】① submit.body 必须是 JSON 字符串模板，不能写成嵌套对象；② 不要把地址写死——现场里的真实地址请还原成 {{baseUrl}}；③ 原协议里已有的占位符一个都不许删（哪怕本次没用到，删了会让图生图/蒙版能力永久失效）。
只输出修正后的完整协议 JSON（保留原 id、name、role），不要解释。
若你判断问题不在协议配置（如网络、鉴权、余额、服务商故障），只输出 {"noFix":true}。`;

/** 让对话模型依据执行现场修协议；修不了/没必要修返回 null */
async function aiRepair(proto: CustomProtocol, error: string, trace: string[], baseUrl: string): Promise<CustomProtocol | null> {
  const { resolveModelCard } = await import("../stores/settingsStore");
  const { chatOnce } = await import("./llm");
  const card = resolveModelCard("chat");
  const user = [
    `当前协议 JSON：\n${JSON.stringify(proto, null, 1)}`,
    `报错信息：\n${error}`,
    `执行现场：\n${trace.join("\n") || "（无）"}`,
  ].join("\n\n");
  const out = await chatOnce(card, repairSystem(proto.role), user.slice(0, 24000));
  const raw = parseJsonLoose<CustomProtocol & { noFix?: boolean }>(out);
  if (!raw || raw.noFix) return null;
  delete (raw as { noFix?: boolean }).noFix;
  let p: CustomProtocol;
  try {
    p = validateProto(raw).proto; // 类型畸形（body 写成对象等）当场拦下，不写回坏协议
  } catch {
    return null;
  }
  // 关键身份字段以原协议为准，AI 不许改
  p.id = proto.id;
  p.name = proto.name;
  p.role = proto.role;
  delete p.verifiedAt;
  // 护栏①：现场里的地址是渲染后的真实地址，模型很容易照抄写死 → 还原成 {{baseUrl}}
  p = retemplateBaseUrl(p, baseUrl);
  // 护栏②：原协议有的占位符不能凭空消失（最典型的是文生图这轮把 {{images}}/{{mask}} 顺手"简化"掉）
  const lost = lostPlaceholders(proto, p);
  if (lost.length) {
    console.warn(`[protoSelfHeal] 修复稿丢了占位符 ${lost.join("、")}，拒绝采用`);
    return null;
  }
  if (JSON.stringify(p) === JSON.stringify(proto)) return null; // 没改等于没修
  return p;
}

/** 对比修复前后的关键字段，生成一句人话的改动摘要 */
function diffSummary(a: CustomProtocol, b: CustomProtocol): string {
  const changes: string[] = [];
  const cmp = (label: string, x?: string, y?: string) => {
    if ((x ?? "") !== (y ?? "")) changes.push(`${label}：${x ?? "（无）"} → ${y ?? "（无）"}`);
  };
  cmp("taskIdPath", a.taskIdPath, b.taskIdPath);
  cmp("resultPath", a.resultPath, b.resultPath);
  cmp("submit.url", a.submit.url, b.submit.url);
  cmp("poll.url", a.poll?.url, b.poll?.url);
  cmp("statusPath", a.poll?.statusPath, b.poll?.statusPath);
  cmp("doneValue", a.poll?.doneValue, b.poll?.doneValue);
  if (!changes.length && a.submit.body !== b.submit.body) changes.push("submit.body 请求体");
  return changes.join("；") || "细节字段";
}

/** 同一协议同一时刻只跑一次 AI 诊断：并发失败的其余任务复用同一份修复结果 */
const repairInflight = new Map<string, Promise<CustomProtocol | null>>();

async function sharedRepair(
  proto: CustomProtocol,
  error: string,
  trace: string[],
  baseUrl: string,
): Promise<{ fixed: CustomProtocol | null; leader: boolean }> {
  const key = proto.id || proto.name;
  const running = repairInflight.get(key);
  if (running) return { fixed: await running, leader: false };
  const p = aiRepair(proto, error, trace, baseUrl);
  repairInflight.set(key, p);
  try {
    return { fixed: await p, leader: true };
  } finally {
    repairInflight.delete(key);
  }
}

/** 执行上下文：run 回调把最终响应放进 lastFinal，自愈就能只重解析而不重发请求 */
export type HealCtx = {
  /** 执行现场（脱敏后的真实请求/响应），供 AI 分析 */
  trace: string[];
  /** 本次拿到的最终响应 JSON —— 有它说明任务其实已经跑完（钱已经扣了） */
  lastFinal?: unknown;
};

/**
 * 自愈执行器：run 失败且像协议配置问题时，AI 修协议 → 自动重试一次。
 * 重试成功 → 修复写回设置（后续运行直接用好协议）；重试失败 → 不写回，抛出综合错误。
 *
 * 省钱要点：最常见的协议错误是 resultPath 写错——任务其实已经生成成功、服务商已经扣费，
 * 只是结果没解析出来。这种情况下先用修好的协议对**已有响应**重新解析（reparse），
 * 解析得出来就直接收货，绝不重发一次生成请求。
 */
export async function runWithSelfHeal<T>(
  proto: CustomProtocol,
  label: string,
  run: (p: CustomProtocol, ctx: HealCtx) => Promise<T>,
  onProgress?: (msg: string) => void,
  /** 用新协议重新解析已有响应；解析不出来返回 null（不传则跳过这一步直接重发） */
  reparse?: (p: CustomProtocol, final: unknown) => T | null | Promise<T | null>,
  /** 本次使用的 Base URL：用于把 AI 写死的地址还原回 {{baseUrl}} */
  baseUrl = "",
): Promise<T> {
  const ctx: HealCtx = { trace: [] };
  try {
    return await run(proto, ctx);
  } catch (e) {
    const first = errMsg(e);
    const { useSettings } = await import("../stores/settingsStore");
    if (!useSettings.getState().settings.protoSelfHeal || !repairable(first)) throw e;

    onProgress?.("运行失败，AI 正在依据执行现场修复协议…");
    // 并发去重：并行 ×3 / 批量出图时同一协议会同时失败多份，
    // 各自独立自愈 = N 次诊断调用 + N 次付费重发，且互相覆盖协议
    let fixed: CustomProtocol | null = null;
    let leader = false;
    try {
      const r = await sharedRepair(proto, first, ctx.trace, baseUrl);
      fixed = r.fixed;
      leader = r.leader;
    } catch {
      fixed = null; // 修复分析本身失败 → 按原错误上报
    }
    if (!fixed) throw e;

    const saveFixed = (why: string) => {
      const st = useSettings.getState();
      const stamped = { ...fixed!, verifiedAt: Date.now() };
      // 保持原有顺序，只替换本条（filter+push 会把协议甩到列表末尾，UI 顺序会跳）
      const list = st.settings.customProtocols;
      const i = list.findIndex((x) => x.id === stamped.id);
      st.update("customProtocols", i >= 0 ? list.map((x, k) => (k === i ? stamped : x)) : [...list, stamped]);
      toast(`${label}：${why} ✓ 修复后的协议「${fixed!.name}」已保存`, "ok");
    };

    // ① 任务其实已完成，只是没解析出来 → 只重解析，不重发（不重复扣费）
    if (reparse && ctx.lastFinal !== undefined) {
      try {
        const salvaged = await reparse(fixed, ctx.lastFinal);
        if (salvaged) {
          saveFixed("结果已从本次响应中救回，未重复发起生成");
          return salvaged;
        }
      } catch {
        /* 重解析失败 → 落到下面的重试 */
      }
    }

    // ② 请求本身就没跑通（或救不回来）→ 用修好的协议重试一次。
    // 只有发起修复的那一份可以重发：并发的其它份重发 = 同一个 bug 扣 N 次钱
    if (!leader)
      throw new Error(
        `${first}\n—— 同一协议的另一个任务正在自动修复，本次不重复发起付费重试。等提示「协议已保存」后重跑此节点即可`,
      );
    onProgress?.("协议已自动修复，正在重试…");
    toast(`${label}：协议「${proto.name}」运行出错，AI 已自动修复（${diffSummary(proto, fixed)}），正在重试…`, "info");
    const retryCtx: HealCtx = { trace: [] };
    try {
      const result = await run(fixed, retryCtx);
      saveFixed("自愈成功");
      return result;
    } catch (e2) {
      throw new Error(
        `${first}\n—— AI 自动修复（${diffSummary(proto, fixed)}）后重试仍失败：${errMsg(e2)}。修复未保存，可到报错中心「AI 分析」继续排查`,
      );
    }
  }
}
