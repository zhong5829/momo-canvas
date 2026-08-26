/**
 * 设置面板共享件 — 分区说明按钮 / 角色常量 / 服务商草稿转换 / 小号编辑图标
 */
import { IcChat, IcMic, IcMusic, IcSparkles, IcVideo } from "../../ui/icons";
import { uid } from "../../core/utils";
import { PROTOCOLS, type AnyProtocol, type ModelRole, type ProviderCard, type RoleSlot } from "../../core/types";

/**
 * 分区说明按钮：正文里不再铺一大段说明，收进标题右侧的「?」，
 * 鼠标移上去（或键盘聚焦）弹出小浮窗，移开即收。
 */
export function SecHelp({ children }: { children: React.ReactNode }) {
  return (
    <span className="sec-help" tabIndex={0} role="button" aria-label="查看说明">
      ?<span className="sec-help-pop">{children}</span>
    </span>
  );
}

/* ================= 模型配置（服务商卡片） ================= */

export const ROLE_ICON: Record<ModelRole, React.ReactNode> = {
  chat: <IcChat size={16} />,
  image: <IcSparkles size={16} />,
  video: <IcVideo size={16} />,
  audio: <IcMusic size={16} />,
  asr: <IcMic size={16} />,
};

export const ROLES: ModelRole[] = ["chat", "image", "video", "audio", "asr"];

/** 默认模型行的短标签（五个并排一行，用长名会撑爆） */
export const ROLE_SHORT: Record<ModelRole, string> = {
  chat: "对话",
  image: "绘画",
  video: "视频",
  audio: "音频",
  asr: "语音",
};

export const MODEL_PLACEHOLDER: Record<ModelRole, string> = {
  chat: "输入模型名回车添加，如 deepseek-chat",
  image: "输入模型名回车添加，如 gpt-image-1",
  video: "输入模型名回车添加，如 cogvideox-3",
  audio: "输入模型名回车添加，如 tts-1 / speech-02",
  asr: "输入模型名回车添加，如 gpt-4o-transcribe / whisper-1",
};

/** 编辑草稿：三个角色槽位全部实体化，models 为空表示该用途未启用 */
export type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  logo?: string;
  slots: Record<ModelRole, RoleSlot>;
};

export function toDraft(p?: ProviderCard): ProviderDraft {
  const slot = (role: ModelRole): RoleSlot => {
    const s = p?.models[role];
    return s
      ? { protocol: s.protocol, models: [...s.models] }
      : { protocol: PROTOCOLS[role][0].value as AnyProtocol, models: [] };
  };
  return {
    id: p?.id ?? uid(8),
    name: p?.name ?? "",
    baseUrl: p?.baseUrl ?? "",
    apiKey: p?.apiKey ?? "",
    logo: p?.logo,
    slots: { chat: slot("chat"), image: slot("image"), video: slot("video"), audio: slot("audio"), asr: slot("asr") },
  };
}

export function fromDraft(d: ProviderDraft): ProviderCard {
  const models: ProviderCard["models"] = {};
  for (const role of ROLES) {
    const s = d.slots[role];
    if (s.models.length) models[role] = { protocol: s.protocol, models: [...s.models] };
  }
  const fallback = d.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "未命名服务商";
  return { id: d.id, name: d.name.trim() || fallback, baseUrl: d.baseUrl, apiKey: d.apiKey, logo: d.logo, models };
}

/** 小号编辑图标（協議 chip 内联用） */
export function IcEditSmall() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m13.7 5 3.3 3.3L9.3 16 5 17l1-4.3L13.7 5Z" />
    </svg>
  );
}
