/**
 * 视频模型服务 — 三种主流 API 风格适配（提交任务 → 轮询结果）
 *  - zhipu       智谱 CogVideoX：POST /videos/generations → GET /async-result/{id}
 *  - siliconflow 硅基流动：POST /video/submit → POST /video/status
 *  - openai      OpenAI 兼容：POST /videos → GET /videos/{id} → /videos/{id}/content
 */
import type { CustomProtocol, ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { absolutize, extractResultStrings, resolveCustomProto, runCustomFlow } from "./customProto";
import { runWithSelfHeal } from "./protoSelfHeal";
import { soraSize, videoFamily, videoWh } from "../videoMeta";

export type VideoGenReq = {
  prompt: string;
  image?: string; // 首帧参考图 dataURL
  /** 尾帧参考图 dataURL（首尾帧过渡；家族支持时才传） */
  lastFrame?: string;
  /** 参考图模式：全部上游图作为角色/主体参考（Seedance 2.0 / Veo 3.1 / 可灵 elements / Vidu reference） */
  refImages?: string[];
  /** 参考视频（部分家族支持；自定义协议用 {{video}} 占位） */
  video?: string;
  /** 参考音频（Seedance 2.0 等支持；自定义协议用 {{refAudio}} 占位） */
  refAudio?: string;
  /** 时长（秒数字符串，如 "5"；服务层按协议转格式） */
  duration?: string;
  /** 分辨率档（如 "720p"） */
  resolution?: string;
  /** 宽高比（如 "16:9"） */
  aspect?: string;
  /** 生成音频 */
  audio?: boolean;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("已取消"));
    });
  });

/** 最终响应 → 视频地址（纯解析步骤，自愈重解析时复用，避免重复出片扣费） */
function parseVideo(p: CustomProtocol, final: unknown, base = ""): string | null {
  const first = extractResultStrings(final, p.resultPath, "video")[0];
  if (!first) return null;
  // 相对地址先补成绝对地址，否则取到了也会被当成"不像地址"丢掉
  const v = absolutize(first, base);
  if (v.startsWith("http") || v.startsWith("data:") || v.startsWith("blob:")) return v;
  if (v.length > 200) return `data:video/mp4;base64,${v}`;
  return null;
}

/** 自定义协议（设置 → 协议，用途 = 视频生成）：模板执行器跑提交/轮询，结果按视频地址取用 */
async function genCustomVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  const proto = await resolveCustomProto(card.protocol, "video");
  // 自愈闭环：运行失败且像协议配置问题时，AI 依据执行现场自动修协议并重试一次
  return runWithSelfHeal(
    proto,
    "生成视频",
    async (p, ctx) => {
      const trace = ctx.trace;
      const wh = req.resolution ? videoWh(req.resolution, req.aspect ?? "16:9") : null;
      const vars: Record<string, string> = {
        baseUrl: trimBase(card.baseUrl),
        apiKey: card.apiKey,
        model: card.model,
        // 完整 JSON 转义：手动 replace 只转义 " 和 \n，漏掉反斜杠本身与 \r \t，
        // 提示词里出现一个 \（Windows 路径、LaTeX、颜文字）就会破坏请求体 JSON，直接 400
        prompt: JSON.stringify(req.prompt).slice(1, -1),
        // 尺寸串按分辨率+比例折算（以前恒为空，模板写了 {{size}} 也拿不到值）
        size: wh ? `${wh.w}x${wh.h}` : "",
        n: "1",
        taskId: "",
        // 首帧参考图 dataURL（模板用 {{image}} 占位）；{{image2}} = 尾帧；
        // {{images}} = 参考图 JSON 数组（角色/主体参考模式）；{{video}} = 参考视频
        image: req.image ?? req.refImages?.[0] ?? "",
        image2: req.lastFrame ?? "",
        images: JSON.stringify(req.refImages ?? []),
        video: req.video ?? "",
        refAudio: req.refAudio ?? "",
        // 家族化参数（模板按需引用；空值配合条件块 {{?duration}}…{{/duration}} 不发）
        duration: req.duration ?? "",
        resolution: req.resolution ?? "",
        aspect: req.aspect ?? "",
        audio: req.audio === undefined ? "" : String(req.audio),
      };
      req.onProgress?.("提交任务…");
      const final = await runCustomFlow(p, vars, req.onProgress, trace, req.signal);
      // 记下最终响应：只是 resultPath 写错时，自愈可从这份响应里救结果，不必重新出片
      ctx.lastFinal = final;
      const v = parseVideo(p, final, trimBase(card.baseUrl));
      if (!v)
        throw new Error(
          `协议「${p.name}」未取到视频（路径 ${p.resultPath}）。响应：${JSON.stringify(final).slice(0, 250)}`,
        );
      return v;
    },
    req.onProgress,
    // 自愈重解析：只用修好的路径重读这次的响应，不重发生成请求（视频重发很贵）
    (p, final) => parseVideo(p, final, trimBase(card.baseUrl)),
    trimBase(card.baseUrl),
  );
}

export async function generateVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  if (!card.baseUrl || !card.model) throw new Error(`模型「${card.name}」缺少 Base URL 或模型名称`);
  if (card.protocol.startsWith("custom:")) return genCustomVideo(card, req);
  const base = trimBase(card.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...(card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {}),
  };
  const progress = (m: string) => req.onProgress?.(m);
  const tick = (i: number) => progress(`生成中… (${Math.floor(((i + 1) * 3) / 60)}分${((i + 1) * 3) % 60}秒)`);

  const family = videoFamily(card);

  if (card.protocol === "zhipu") {
    const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
    // 首帧兜底：面板只连了参考图没设首帧时，也要把第一张图发出去（否则图生视频退化成文生视频）
    if (req.image ?? req.refImages?.[0]) body.image_url = req.image ?? req.refImages![0];
    if (req.duration) body.duration = Number(req.duration);
    if (req.resolution) {
      const wh = videoWh(req.resolution, req.aspect ?? "16:9");
      if (wh) body.size = `${wh.w}x${wh.h}`;
    }
    if (req.audio !== undefined) body.with_audio = req.audio;
    const resp = await xfetch(`${base}/videos/generations`, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { id } = await resp.json();
    if (!id) throw new Error("视频任务未返回 id");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const r = await xfetch(`${base}/async-result/${id}`, { headers, signal: req.signal });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.task_status === "SUCCESS") {
        const url = j.video_result?.[0]?.url;
        if (!url) throw new Error("任务成功但未返回视频地址");
        return url;
      }
      if (j.task_status === "FAIL") throw new Error("视频生成失败（供应商返回 FAIL）");
      tick(i);
    }
    throw new Error("视频生成超时");
  }

  if (card.protocol === "siliconflow") {
    const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
    if (req.image ?? req.refImages?.[0]) body.image = req.image ?? req.refImages![0];
    if (req.resolution) {
      const wh = videoWh(req.resolution, req.aspect ?? "16:9");
      if (wh) body.image_size = `${wh.w}x${wh.h}`;
    }
    const resp = await xfetch(`${base}/video/submit`, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { requestId } = await resp.json();
    if (!requestId) throw new Error("视频任务未返回 requestId");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const r = await xfetch(`${base}/video/status`, { method: "POST", headers, body: JSON.stringify({ requestId }), signal: req.signal });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === "Succeed") {
        const url = j.results?.videos?.[0]?.url;
        if (!url) throw new Error("任务成功但未返回视频地址");
        return url;
      }
      if (j.status === "Failed") throw new Error(`视频生成失败: ${j.reason ?? "未知原因"}`);
      tick(i);
    }
    throw new Error("视频生成超时");
  }

  // openai 任务式（Sora 风格：seconds 字符串 + size 尺寸串；首帧 input_reference）
  {
    const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
    if (req.duration) body.seconds = req.duration;
    if (req.resolution) {
      if (family === "sora") {
        body.size = soraSize(req.resolution, req.aspect ?? "16:9");
      } else {
        const wh = videoWh(req.resolution, req.aspect ?? "16:9");
        if (wh) body.size = `${wh.w}x${wh.h}`;
      }
    }
    if (req.image ?? req.refImages?.[0]) body.input_reference = req.image ?? req.refImages![0];
    // 尾帧 / 多参考图 / 音画同出：中转站字段不统一，按常见命名一并带上（不支持的会忽略未知字段）
    if (req.lastFrame) body.input_reference_last = req.lastFrame;
    if ((req.refImages?.length ?? 0) > 1) body.reference_images = req.refImages;
    if (req.audio !== undefined) body.with_audio = req.audio;
    const resp = await xfetch(`${base}/videos`, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { id } = await resp.json();
    if (!id) throw new Error("视频任务未返回 id");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const r = await xfetch(`${base}/videos/${id}`, { headers, signal: req.signal });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === "completed") {
        const cr = await xfetch(`${base}/videos/${id}/content`, { headers, signal: req.signal });
        if (!cr.ok) throw new Error(`下载视频失败 ${cr.status}`);
        const blob = await cr.blob();
        return URL.createObjectURL(blob);
      }
      if (j.status === "failed") throw new Error(`视频生成失败: ${j.error?.message ?? "未知原因"}`);
      progress(`生成中… ${j.progress ?? ""}`);
    }
    throw new Error("视频生成超时");
  }
}
