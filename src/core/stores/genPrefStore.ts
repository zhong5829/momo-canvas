/**
 * 面板参数记忆 + 生成参数档位 —— 两套并行结构：
 *  ① prefs（单份）：面板每次改参数自动 remember，新建同类节点按上次设置落地。
 *  ② presets（多档）+ activeId：「草稿/标准/精修」内置三档 + 用户自定义档，切档一键应用。
 * 「上次设置」是平行于 presets 的活档（__last__），读 prefs；切到具体档位才写 activeId。
 * 只记「设置类」字段，提示词/结果/状态/历史不记。
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import type { GenTierIntent } from "../tierMap";

export type GenPrefKind = "imageGen" | "videoGen" | "audioGen";

/** 参与记忆的字段黑名单（内容/运行态/历史 不记） */
const EXCLUDE = new Set([
  "prompt", "text", "results", "resultUrl", "resultUrls", "picked", "status", "error", "progress", "progressPct",
  "history", // 节点级历史不进偏好（否则新节点继承上一次全部历史）
  "fallbackModel", // 备用模型徽标是运行态产物
]);

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

type PersistShape = { prefs: Partial<Record<GenPrefKind, Record<string, unknown>>>; presets: GenTierPreset[]; activeId: Partial<Record<GenPrefKind, string>> };

type GenPrefState = {
  prefs: Partial<Record<GenPrefKind, Record<string, unknown>>>;
  presets: GenTierPreset[];
  activeId: Partial<Record<GenPrefKind, string>>;
  loaded: boolean;
  init: () => Promise<void>;
  /** 面板 patch 时顺手记一笔（只保留设置类字段） */
  remember: (kind: GenPrefKind, patch: Record<string, unknown>) => void;
  /** 取某档（含 __last__ 虚拟档） */
  getPreset: (id: string) => GenTierPreset | { id: string; name: string; data: Record<string, unknown> } | undefined;
  savePreset: (kind: GenPrefKind, name: string, data: Record<string, unknown>) => string;
  removePreset: (id: string) => void;
  setActive: (kind: GenPrefKind, id: string | undefined) => void;
};

let initOnce: Promise<void> | null = null;

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

  remember: (kind, patch) => {
    const clean: Record<string, unknown> = {};
    // 保留 undefined：面板把宽高清成「自动」正是靠 undefined，过滤掉会让新节点继承过期尺寸
    for (const k of Object.keys(patch)) {
      if (!EXCLUDE.has(k)) clean[k] = patch[k];
    }
    if (!Object.keys(clean).length) return;
    const commit = () => {
      const s = get();
      const prefs = { ...s.prefs, [kind]: { ...(s.prefs[kind] ?? {}), ...clean } };
      set({ prefs });
      void saveJSON("gen-prefs.json", "v1", { prefs, presets: s.presets, activeId: s.activeId } satisfies PersistShape);
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
    void saveJSON("gen-prefs.json", "v1", { prefs: s.prefs, presets, activeId: { ...s.activeId, [kind]: id } } satisfies PersistShape);
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
    void saveJSON("gen-prefs.json", "v1", { prefs: s.prefs, presets, activeId } satisfies PersistShape);
  },

  setActive: (kind, id) => {
    const s = get();
    const activeId = { ...s.activeId };
    if (id === undefined || id === LAST_ID) delete activeId[kind];
    else activeId[kind] = id;
    set({ activeId });
    void saveJSON("gen-prefs.json", "v1", { prefs: s.prefs, presets: s.presets, activeId } satisfies PersistShape);
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
