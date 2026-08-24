/**
 * 服务商（中转站）预设 — 一键导入常用中转站的默认参数：名称 / logo / Base URL / 各角色协议（+ 建议模型）。
 * 用户只需补 API Key。与 protoPresets.ts 同构。
 *
 * 数据来源：Notion「GPT-Image-2 中转站可用渠道汇总」（2026-08 快照，全表 23 家已收录），
 * Base URL / logo 已逐站实测核实；rating 为原文「推荐指数」(0-10，作稳定性/可信度参考)，
 * price 为原文价格快照（仅作参考，以下单页为准）。排序按推荐指数从高到低。
 */
import { uid } from "./utils";
import type { AnyProtocol, ModelRole, ProviderCard } from "./types";

export type ProviderPresetRole = {
  /** 该角色走的协议（openai / anthropic / gemini / zhipu / siliconflow） */
  protocol: AnyProtocol;
  /** 建议预填的模型名（用户可增删）；留空则只建空槽位，等用户补 */
  models?: string[];
};

export type ProviderPreset = {
  /** 唯一键 */
  key: string;
  /** 显示名（也作为新建卡片的默认名称） */
  label: string;
  /** logo：URL / dataURL / 单字符文字徽标（ProviderCard.logo 透传） */
  logo?: string;
  /** 中转站 Base URL */
  baseUrl: string;
  /** 一行说明（悬浮提示） */
  note: string;
  /** 注册 / 官网地址（预设卡片上的「跳转」按钮用） */
  site?: string;
  /** 推荐指数 0-10（原文档评分，作稳定性 / 可信度参考） */
  rating?: number;
  /** 大概费用（原文快照，如 "0.038–0.100 元/张" / "￥3/M"） */
  price?: string;
  /** 要预填的角色与协议（+ 建议模型）；未列出的角色不创建槽位 */
  roles: Partial<Record<ModelRole, ProviderPresetRole>>;
};

/**
 * 预设清单 —— GPT-Image-2 中转站合集（OpenAI 兼容协议，预填 image 角色 + gpt-image-2 模型）。
 * logo 为站点实测图标地址；个别站无独立图标文件时用单字符文字徽标兜底。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "65535",
    label: "65535",
    logo: "https://my.65535.space/favicon.svg",
    baseUrl: "https://api.65535.space/v1",
    site: "https://my.65535.space/register?aff=U2RF7SAVFLP3",
    rating: 10,
    price: "0.038–0.100 元/张",
    note: "按次计费 · 多渠道，稳定组原生4K、低价组超分4K，支持异步协议与香蕉生图，站内有出图记录",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "apiqik",
    label: "APIQIK 主站",
    logo: "https://api.apiqik.com/logo.png",
    baseUrl: "https://api.apiqik.com/v1",
    site: "https://api.apiqik.com/register?aff=ZTXo",
    rating: 10,
    price: "￥3/M（按量）",
    note: "注册送￥7额度；codex 分组便宜仅 1K，4K 走 azure/sp/gpt 分组，速度快，综合体验最好",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "change2pro",
    label: "Change2Pro",
    logo: "https://change2pro.com/logo.svg",
    baseUrl: "https://api.change2pro.com/v1",
    site: "https://change2pro.com/register?aff=WCYL3GENQDLL",
    rating: 9,
    price: "0.020–0.100 元/张",
    note: "按次计费 · 渠道多，支持原生4K与香蕉生图",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "meinianda",
    label: "Meinianda AI",
    logo: "https://meinianda.top/logo.png",
    baseUrl: "https://meinianda.top/v1",
    site: "https://meinianda.top/sign-up?aff=CJbT",
    rating: 9,
    price: "0.030–0.060 元/张",
    note: "按次计费 · 4K 价格非常便宜，速度快",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "buchi-kunrou",
    label: "不吃坤肉(生图版)",
    logo: "https://img.yunfei.best/logo.png",
    baseUrl: "https://img.yunfei.best/v1",
    site: "https://img.yunfei.best/sign-up?aff=2u5b",
    rating: 9,
    price: "0.010–0.060 元/张",
    note: "按次计费 · 价格低速度也不错，支持原生 image2 2K/4K",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "moyuu",
    label: "摸鱼AI",
    logo: "https://moyuu.cc/favicon.svg?v=20260426-pink",
    baseUrl: "https://moyuu.cc/v1",
    site: "https://moyuu.cc/register?aff=ANO9",
    rating: 8,
    price: "0.012–0.104 元/张",
    note: "按次计费 · 支持原生4K与香蕉生图，速度还行",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "mikotopro",
    label: "MikotoPro",
    logo: "https://api.mikoto.vip/logo.png",
    baseUrl: "https://api.mikoto.vip/v1",
    site: "https://api.mikoto.vip/register?aff=SGQGHCBKSKRL",
    rating: 8,
    price: "0.020–0.080 元/张",
    note: "按次计费 · 1K 组 0.02/张，4K 0.08/张（目前不稳定）",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "manxiaobai",
    label: "漫小白",
    logo: "https://api.manxiaobai.online/logo.png",
    baseUrl: "https://api.manxiaobai.online/v1",
    site: "https://api.manxiaobai.online/register?aff=m8AZ",
    rating: 8,
    price: "0.020–0.108 元/张",
    note: "按次计费 · 渠道多、原生4K；4K 建议用网站生图工作台（画布直连易超时扣费）",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "jbb",
    label: "JBB 金贝贝",
    logo: "https://downstream.jbbtoken.cn/logo.png",
    baseUrl: "https://downstream.jbbtoken.cn/v1",
    site: "https://downstream.jbbtoken.cn/sign-up?aff=MRdP",
    rating: 8,
    price: "0.030 元/张",
    note: "按次计费 · 仅 1K/2K（4K 为超分非原生），速度快价格低",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "aipai",
    label: "AI派",
    logo: "https://aipaiai.cn/logo.png",
    baseUrl: "https://aipaiai.cn/v1",
    site: "https://aipaiai.cn/register?aff=rEMO",
    rating: 8,
    price: "0.050–0.060 元/张",
    note: "按次计费 · 1K/4K 同价，速度不稳定时快时慢",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "proxyai",
    label: "ProxyAI",
    logo: "P",
    baseUrl: "https://cn.proxy2it.com/v1",
    site: "https://cn.proxy2it.com/register?aff=36XEVVMQWVBJ",
    rating: 8,
    price: "0.050–0.120 元/张",
    note: "按次计费 · 低价组 0.05 仅 1K；稳定组原生4K 0.12/张",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "jucodex",
    label: "JuCodex",
    logo: "https://jucodex.com/logo.png",
    baseUrl: "https://api.jucodex.com/v1",
    site: "https://jucodex.com/register?aff=7TVO",
    rating: 8,
    price: "0.060–0.120 元/张",
    note: "按次计费 · 注册送￥2；原生4K 建议用网站工作台（画布直连易超时扣费）",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "aigeek",
    label: "AI 极客",
    logo: "https://lsky.zhongzhuan.chat/i/2026/05/01/69f405bd4ff81.png",
    baseUrl: "https://www.aigeek.life/v1",
    site: "https://www.aigeek.life/register?aff=OUiy",
    rating: 7,
    price: "￥3/M",
    note: "按量计费 · 0元购已失效",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "yuli",
    label: "玉玉API",
    logo: "https://lsky.zhongzhuan.chat/i/2025/12/27/694fd316934c9.png",
    baseUrl: "https://yuli.host/v1",
    site: "https://yuli.host/register?aff=kcHT",
    rating: 7,
    price: "￥3/M",
    note: "按量计费",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "zmzai",
    label: "造梦者AI",
    logo: "https://i.imgs.ovh/2026/05/24/fd3248eba5e82103ced7dddca436f544.jpg",
    baseUrl: "https://zmzai.cn/v1",
    site: "https://zmzai.cn/register?aff=djgF",
    rating: 7,
    price: "￥3/M",
    note: "按量计费 · 品牌迁站中（新域名 aiwts.com），API 暂仍可用",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "youziapi",
    label: "柚子中转API",
    logo: "https://lsky.zhongzhuan.chat/i/2026/07/23/6a616a0f351c2.jpg",
    baseUrl: "https://youziapi.com/v1",
    site: "https://youziapi.com/register?aff=fk3x",
    rating: 7,
    price: "￥3/M",
    note: "按量计费",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "yunwu",
    label: "云雾 API",
    logo: "https://lsky.zhongzhuan.chat/i/2025/12/21/694715f67ece8.png",
    baseUrl: "https://yunwu.ai/v1",
    site: "https://yunwu.ai/register?aff=NeEm",
    rating: 7,
    price: "￥3/M",
    note: "按量计费",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "apitrans",
    label: "Apitrans",
    logo: "https://lsky.zhongzhuan.chat/i/2026/01/08/695f5287623a9.png",
    baseUrl: "https://apitrans.top/v1",
    site: "https://apitrans.top/register?aff=21WL",
    rating: 7,
    price: "￥3/M",
    note: "按量计费",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "apimart",
    label: "ApiMart",
    logo: "https://aishuch.com/logo.png",
    baseUrl: "https://api.aishuch.com/v1",
    site: "https://aishuch.com/register?aff=imMT49",
    rating: 7,
    price: "0.059–0.147 元/张",
    note: "按次计费 · 站内有出图记录，近期涨价",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "apilio",
    label: "apilio（柏拉图）",
    logo: "https://api.apilio.ai/favicon.png",
    baseUrl: "https://api.apilio.ai/v1",
    site: "https://api.apilio.ai/register?aff=zkhB140656",
    rating: 7,
    price: "0.060 元/张",
    note: "按次计费 · 近期 4K 有点拉",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "grsai",
    label: "Grsai",
    logo: "https://grsai.com/images/logo.png",
    baseUrl: "https://api.grsai.com/v1",
    site: "https://grsai.com/",
    rating: 7,
    price: "0.060 元/张",
    note: "按次计费 · 多位博主推荐，比较稳定",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "pixel-api",
    label: "Pixel API",
    logo: "https://ai-pixel.online/brand/site-logo",
    baseUrl: "https://api.ai-pixel.online/v1",
    site: "https://ai-pixel.online/register?aff=5USEFQC8N8AD",
    rating: 7,
    price: "0.02–0.08 元/张",
    note: "按次计费 · ⚠️暂停注册；free 组低价但不稳，pro 组约 0.08 较稳",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "evai",
    label: "EVAI",
    logo: "https://www.openevai.com/favicon.ico",
    baseUrl: "https://www.openevai.com/v1",
    site: "https://www.openevai.com?referralCode=140776359591424",
    rating: 5,
    price: "年会员 1K 0.066 / 4K 0.197",
    note: "⚠️仅网站自带生图，无标准 OpenAI 兼容 API，导入后可能不可用",
    roles: { image: { protocol: "openai", models: ["gpt-image-2"] } },
  },
  {
    key: "ollama",
    label: "Ollama 本地",
    logo: "🦙",
    baseUrl: "http://127.0.0.1:11434",
    note: "本地 Ollama，无需 API Key。需先安装 Ollama 并 ollama pull 模型；默认端口 11434。支持 thinking 字段与 keep_alive 显存释放。",
    site: "https://ollama.com",
    roles: { chat: { protocol: "ollama" } },
  },
];

/** Ollama 本地预设（设置页固定卡片用；无需 API Key，chat 槽走原生协议） */
export const OLLAMA_PRESET: ProviderPreset = PROVIDER_PRESETS.find((p) => p.key === "ollama")!;

/** 由预设生成一个待编辑的服务商卡片（apiKey 留空，等用户补；id 新建） */
export function buildPresetProvider(preset: ProviderPreset): ProviderCard {
  const models: ProviderCard["models"] = {};
  for (const [role, cfg] of Object.entries(preset.roles)) {
    if (!cfg) continue;
    models[role as ModelRole] = { protocol: cfg.protocol, models: [...(cfg.models ?? [])] };
  }
  return { id: uid(8), name: preset.label, baseUrl: preset.baseUrl, apiKey: "", logo: preset.logo, models };
}
