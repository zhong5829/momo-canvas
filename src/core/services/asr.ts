/**
 * 语音识别服务（ASR）— OpenAI 兼容 /audio/transcriptions（multipart）
 * 覆盖 whisper-1 / gpt-4o-transcribe / SenseVoice / 豆包 ASR 等绝大多数中转站接法。
 * 返回纯文本；识别不到内容返回空串（调用方据此判断「这段没说话」）。
 */
import type { ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

export type AsrReq = {
  /** 录音数据（MediaRecorder 产出的 webm/mp4 等） */
  audio: Blob;
  /** 语言提示（zh/en…），留空由模型自动判定 */
  lang?: string;
  /** 领域提示词：把专有名词喂给模型，明显提升生僻词准确率 */
  hint?: string;
  signal?: AbortSignal;
};

/** blob 的 mime → 文件扩展名（部分服务按扩展名判定容器格式，传错会 400） */
function extOf(b: Blob): string {
  const t = (b.type || "").toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "mp4";
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  return "webm";
}

export async function transcribe(card: ModelCard, req: AsrReq): Promise<string> {
  if (!card.baseUrl) throw new Error(`语音识别模型「${card.name}」缺少 Base URL`);
  if (!card.model) throw new Error(`语音识别模型「${card.name}」缺少模型名称`);
  const base = trimBase(card.baseUrl);
  const fd = new FormData();
  fd.append("model", card.model);
  fd.append("file", req.audio, `speech.${extOf(req.audio)}`);
  fd.append("response_format", "json");
  if (req.lang) fd.append("language", req.lang);
  if (req.hint) fd.append("prompt", req.hint.slice(0, 900));

  const resp = await xfetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {},
    body: fd,
    signal: req.signal,
  });
  if (!resp.ok) throw new Error(`语音识别失败 ${resp.status}: ${await readErrorBody(resp)}`);

  // 兼容：标准 {text}；部分中转返回 {data:{text}} / {result:{text}} / 纯文本
  const raw = await resp.text();
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const pick = (o: unknown): string | undefined => {
      if (!o || typeof o !== "object") return undefined;
      const r = o as Record<string, unknown>;
      if (typeof r.text === "string") return r.text;
      if (typeof r.transcript === "string") return r.transcript;
      if (typeof r.result === "string") return r.result;
      return pick(r.data) ?? pick(r.result) ?? pick(r.output);
    };
    return (pick(j) ?? "").trim();
  } catch {
    return raw.trim();
  }
}
