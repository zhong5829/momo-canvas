/**
 * 节点参数记忆 + 生成参数档位 —— 两套并行结构：
 *  ① prefs（单份）：节点配置每次被修改自动 remember（由 boardStore.updateData 统一挂钩），
 *     新建同类节点按上次设置落地；覆盖全部节点类型，不只生成类。
 *  ② presets（多档）+ activeId：「草稿/标准/精修」内置三档 + 用户自定义档，切档一键应用。
 * 「上次设置」是平行于 presets 的活档（__last__），读 prefs；切到具体档位才写 activeId。
 * 只记「设置类」字段，提示词/档案/结果/状态/历史不记（见下面三张过滤表）。
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import type { GenTierIntent } from "../tierMap";

/** 档位（草稿/标准/精修）只服务这三类节点；prefs 记忆则按任意节点类型生效 */
export type GenPrefKind = "imageGen" | "videoGen" | "audioGen";

/**
 * 记忆字段三层过滤（宁可不记、不可错记：新字段默认不记忆，除非显式登记）：
 *  ① 配置白名单 = defaultData(kind) 的键 ∪ OPTIONAL_PREF_KEYS（由调用方传入 defaults，本表只管可选键）
 *  ② CONTENT_KEYS 全局内容/运行态黑名单：即便出现在 defaultData 里也不记
 *  ③ KIND_CONTENT 按类型的黑名单：同名不同义的字段（style：角色卡=版式偏好 / 分镜=内容文本）
 */

/** 可选配置键：不在 defaultData 里显式初始化（默认 undefined）、但属于「偏好」的字段。
 *  注意 seed 有意不记——锁定种子是单个作品的操作，记住会让新节点全部锁在同一种子上 */
const OPTIONAL_PREF_KEYS = new Set([
  "modelId", "chatModelId", "imageModelId",
  "aspect", "resolution", "quality", "lang",
  "creativity", "parallel", "width", "height", "negative",
  "duration", "audio", "useTail", "refMode", "voice",
  "templateId", "variantId",
]);

/** 全局内容/运行态黑名单（即便出现在 defaultData 里也不记） */
const CONTENT_KEYS = new Set([
  // 运行态
  "status", "error", "progress", "progressPct",
  "history", // 节点级历史不进偏好（否则新节点继承上一次全部历史）
  "fallbackModel", // 备用模型徽标是运行态产物
  // 内容与结果
  "prompt", "text", "messages", "draft", "custom", "result", "results",
  "resultUrl", "resultUrls", "picked", "params", "extra", "selected",
  "prompts", "slides", "userRefs", "productDesc", "styleTone", "h5StyleTone",
]);

/** 按类型的内容黑名单：同名不同义字段在此区分（其余内容字段不在 defaultData 里，天然不记） */
const KIND_CONTENT: Partial<Record<string, ReadonlySet<string>>> = {
  storyboard: new Set(["story", "style", "tone", "shots"]),
};

/** 档位：内置三档带 intent（由 GenConfigPanel 用 tierMap 翻译到当前家族）；自定义档存具体字段快照 */
export type GenTierPreset = {
  id: string;
  name: string;
  kind: GenPrefKind;
  /** 内置档的意图标记；自定义档无 */
  intent?: GenTierIntent;
  /** 自定义档的具体字段快照；内置档为空 {}（应用时按 intent 翻译） */
  data: Record<string, unknown>;
  builtin?: boolean;
};

/** 内置三档（草稿/标准/精修），image 与 video 各一套 */
const LAST_ID = "__last__";
function builtinPresets(): GenTierPreset[] {
  const mk = (kind: GenPrefKind, prefix: string): GenTierPreset[] =>
    (["draft", "standard", "refine"] as GenTierIntent[]).map((intent) => ({
      id: `${prefix}_${intent}`,
      name: intent === "draft" ? "草稿" : intent === "standard" ? "标准" : "精修",
      kind,
      intent,
      data: {},
      builtin: true,
    }));
  return [...mk("imageGen", "img"), ...mk("videoGen", "vid")];
}

type PersistShape = { prefs: Record<string, Record<string, unknown>>; presets: GenTierPreset[]; activeId: Partial<Record<GenPrefKind, string>> };

type GenPrefState = {
  prefs: Record<string, Record<string, unknown>>;
  presets: GenTierPreset[];
  activeId: Partial<Record<GenPrefKind, string>>;
  loaded: boolean;
  init: () => Promise<void>;
  /**
   * 节点配置变更时记一笔「上次设置」（由 boardStore.updateData 统一挂钩）。
   * defaults = defaultData(kind)：配置白名单 = defaults 的键 ∪ OPTIONAL_PREF_KEYS，再按两张黑名单剔除。
   */
  remember: (kind: string, patch: Record<string, unknown>, defaults: Record<string, unknown>) => void;
  /** 取某档（含 __last__ 虚拟档） */
  getPreset: (id: string) => GenTierPreset | { id: string; name: string; data: Record<string, unknown> } | undefined;
  savePreset: (kind: GenPrefKind, name: string, data: Record<string, unknown>) => string;
  removePreset: (id: string) => void;
  setActive: (kind: GenPrefKind, id: string | undefined) => void;
};

let initOnce: Promise<void> | null = null;

/** 落盘防抖：滑杆拖动每秒触发几十次修改，内存即时生效、写文件 300ms 尾沿合并 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => GenPrefState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = get();
    void saveJSON("gen-prefs.json", "v1", { prefs: s.prefs, presets: s.presets, activeId: s.activeId } satisfies PersistShape);
  }, 300);
}

export const useGenPref = create<GenPrefState>((set, get) => ({
  prefs: {},
  presets: [],
  activeId: {},
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      // 兼容 v1（形如 { imageGen:{...} }，即裸 prefs）与 v2（{prefs,presets,activeId}）
      const saved = await loadJSON<Partial<Record<GenPrefKind, Record<string, unknown>>> & PersistShape>("gen-prefs.json", "v1");
      let prefs: PersistShape["prefs"] = {};
      let presets = builtinPresets();
      let activeId: PersistShape["activeId"] = {};
      if (saved) {
        if (saved.prefs || saved.presets) {
          // v2
          prefs = saved.prefs ?? {};
          // 合并内置档与用户档（用户档 id 不撞内置前缀）
          const user = (saved.presets ?? []).filter((p) => !p.builtin && !p.id.startsWith("img_") && !p.id.startsWith("vid_"));
          presets = [...presets, ...user];
          activeId = saved.activeId ?? {};
        } else {
          // v1：整份就是 prefs
          prefs = saved as unknown as PersistShape["prefs"];
        }
      }
      set({ prefs, presets, activeId, loaded: true });
    })()),

  remember: (kind, patch, defaults) => {
    const kindContent = KIND_CONTENT[kind];
    const clean: Record<string, unknown> = {};
    // 保留 undefined：面板把宽高清成「自动」正是靠 undefined，过滤掉会让新节点继承过期尺寸
    for (const k of Object.keys(patch)) {
      if (CONTENT_KEYS.has(k) || kindContent?.has(k)) continue;
      if (!(k in defaults) && !OPTIONAL_PREF_KEYS.has(k)) continue;
      clean[k] = patch[k];
    }
    if (!Object.keys(clean).length) return;
    const commit = () => {
      const s = get();
      const prefs = { ...s.prefs, [kind]: { ...(s.prefs[kind] ?? {}), ...clean } };
      set({ prefs });
      scheduleSave(get);
    };
    if (!get().loaded) void get().init().then(commit);
    else commit();
  },

  getPreset: (id) => {
    if (id === LAST_ID) return { id, name: "上次设置", data: {} };
    return get().presets.find((p) => p.id === id);
  },

  savePreset: (kind, name, data) => {
    const id = uid(6);
    const preset: GenTierPreset = { id, name, kind, data };
    const s = get();
    const presets = [...s.presets, preset];
    set({ presets, activeId: { ...s.activeId, [kind]: id } });
    scheduleSave(get);
    return id;
  },

  removePreset: (id) => {
    const s = get();
    const preset = s.presets.find((p) => p.id === id);
    if (preset?.builtin) return; // 内置档不可删
    const presets = s.presets.filter((p) => p.id !== id);
    // 删的是当前激活档 → 该 kind 回退「上次设置」
    const activeId = { ...s.activeId };
    if (preset && activeId[preset.kind] === id) delete activeId[preset.kind];
    set({ presets, activeId });
    scheduleSave(get);
  },

  setActive: (kind, id) => {
    const s = get();
    const activeId = { ...s.activeId };
    if (id === undefined || id === LAST_ID) delete activeId[kind];
    else activeId[kind] = id;
    set({ activeId });
    scheduleSave(get);
  },
}));

/** 新建节点时取出该类节点的「激活档」参数：自定义档返回其 data，内置档/上次设置/未激活 → 读 prefs */
export function genPrefFor(kind: string): Record<string, unknown> {
  const s = useGenPref.getState();
  if (!s.loaded) void s.init();
  const k = kind as GenPrefKind;
  const activeId = s.activeId[k];
  // 激活的是自定义档（有具体 data、非内置意图档）→ 用其参数落地
  if (activeId && activeId !== LAST_ID) {
    const p = s.presets.find((x) => x.id === activeId && x.kind === k);
    if (p && !p.builtin && Object.keys(p.data).length) return { ...p.data };
  }
  return s.prefs[k] ?? {};
}
