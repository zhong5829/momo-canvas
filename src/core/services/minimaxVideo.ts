/**
 * MiniMax H3 视频服务 — 专用适配 minimax.api.easyframe.cn 的 /v1/videos
 *  流程：POST /v1/videos 提交（带本地媒体走 multipart，纯文生走 JSON）→ 轮询状态 → /content 下载 MP4。
 *  提交端点 / 字段、5 种模式与媒体限制依据官方文档（minimax.api.easyframe.cn/docs）。
 *  ⚠ 查询/下载路径：文档首页仅示意「返回 id → 查询 → /content 下载」，此处沿用与项目 Sora
 *    分支同骨架的 /v1/videos/{id} + /v1/videos/{id}/content，并对状态字段做宽容解析；若实际
 *    路径/字段有出入，运行日志会自动暴露，届时按供应商响应修正。
 */
import type { MinimaxVideoData, ModelCard } from "../types";
import { dataUrlToBlob } from "../utils";
import { xfetch, trimBase, readErrorBody } from "./http";

export type MinimaxVideoReq = {
  prompt: string;
  mode: MinimaxVideoData["mode"];
  /** 分辨率档：480p / 720p */
  resolution: string;
  /** 时长（秒）：5~15 的字符串 */
  seconds: string;
  /** 画面比例，如 "16:9" */
  aspect: string;
  /** 是否授权 AI 优化提示词 */
  promptOptimization: boolean;
  /** 参考图片 dataURL 列表（按 mode：i2va 首帧 / fl2va 首尾帧 / l2va 尾帧 / ref2va 多参考） */
  images: string[];
  /** 参考音频 dataURL 列表（ref2va 可选） */
  audios: string[];
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

/** 状态字符串 → 任务是否成功/失败（宽容解析，兼容不同供应商字段取值） */
function settle(status: unknown): "ok" | "fail" | "pending" {
  const s = String(status ?? "").toLowerCase();
  if (/^(s?complet|succeed|succeeded|success|done|finished)/.test(s)) return "ok";
  if (/^(fail|failed|failure|error|cancel|cancelled|reject|rejected)/.test(s)) return "fail";
  return "pending";
}

export async function generateMinimaxVideo(card: ModelCard, req: MinimaxVideoReq): Promise<string> {
  if (!card.baseUrl || !card.model) throw new Error(`模型「${card.name}」缺少 Base URL 或模型名称`);
  const base = trimBase(card.baseUrl);
  const headers: Record<string, string> = card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {};

  const hasMedia = req.images.length + req.audios.length > 0;
  let id: string | undefined;

  if (hasMedia) {
    // 带本地文件：multipart/form-data（浏览器/plugin-http 自动生成 boundary）
    const fd = new FormData();
    fd.append("model", card.model);
    fd.append("mode", req.mode);
    fd.append("resolution", req.resolution);
    fd.append("seconds", req.seconds);
    fd.append("aspect_ratio", req.aspect);
    fd.append("prompt_optimization", String(req.promptOptimization));
    fd.append("prompt", req.prompt);
    req.images.forEach((img, i) => fd.append("images", dataUrlToBlob(img), `ref_${i}.png`));
    req.audios.forEach((au, i) => fd.append("audios", dataUrlToBlob(au), `ref_${i}.m4a`));
    req.onProgress?.("提交任务…");
    const resp = await xfetch(`${base}/v1/videos`, { method: "POST", headers, body: fd, signal: req.signal });
    if (!resp.ok) throw new Error(`视频提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = (await resp.json().catch(() => ({}))) as { id?: string };
    id = j.id;
  } else {
    // 纯文生：JSON
    const body = {
      model: card.model,
      mode: req.mode,
      resolution: req.resolution,
      seconds: req.seconds,
      aspect_ratio: req.aspect,
      prompt_optimization: req.promptOptimization,
      prompt: req.prompt,
    };
    req.onProgress?.("提交任务…");
    const resp = await xfetch(`${base}/v1/videos`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!resp.ok) throw new Error(`视频提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = (await resp.json().catch(() => ({}))) as { id?: string };
    id = j.id;
  }

  if (!id) throw new Error(`视频任务未返回 id，请到运行日志查看`);
  req.onProgress?.("任务已提交，生成中…");

  // 轮询（2s 间隔，最长约 20 分钟）
  for (let i = 0; i < 600; i++) {
    await sleep(2000, req.signal);
    const r = await xfetch(`${base}/v1/videos/${id}`, { headers, signal: req.signal });
    if (!r.ok) continue;
    const j = (await r.json().catch(() => null)) as (Record<string, unknown> & { progress?: number }) | null;
    if (!j) continue;
    const st = settle(j.status ?? j.state ?? j.task_status);
    if (st === "fail") throw new Error(`视频生成失败: ${String(j.error ?? j.message ?? "") || "供应商返回失败"}`);
    if (st === "ok") break;
    req.onProgress?.(`生成中… ${typeof j.progress === "number" ? Math.round(j.progress * 100) + "%" : `${(i + 1) * 2}s`}`);
  }

  // 下载 MP4
  const cr = await xfetch(`${base}/v1/videos/${id}/content`, { headers, signal: req.signal });
  if (!cr.ok) throw new Error(`下载视频失败 ${cr.status}: ${await readErrorBody(cr)}`);
  const blob = await cr.blob();
  return URL.createObjectURL(blob);
}