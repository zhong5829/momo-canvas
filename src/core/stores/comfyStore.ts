import { create } from "zustand";
import type { ComfyTemplate, ComfyVariant } from "../types";
import { loadJSON, saveJSON } from "../persist";
import { pingComfy } from "../services/comfy";

type ComfyState = {
  templates: ComfyTemplate[];
  online: "unknown" | "ok" | "down";
  onlineInfo: string;
  loaded: boolean;
  init: () => Promise<void>;
  upsert: (tpl: ComfyTemplate) => void;
  remove: (id: string) => void;
  test: (host: string) => Promise<{ ok: boolean; err?: string }>;
};

/**
 * 归一化模板：无 variants 的老模板（v1）派生一个 default 分支，保留原运行行为。
 * default 分支 = 整个工作流，沿用顶层 params/outputNodeId/disabledNodes。
 * 只作用在内存，不主动回写磁盘——下次 upsert 落盘时自然带上 variants。
 */
function normalizeTemplate(t: ComfyTemplate): ComfyTemplate {
  if (Array.isArray(t.variants) && t.variants.length) return t;
  const def: ComfyVariant = {
    id: "default",
    name: "默认",
    color: "blue",
    nodeIds: Object.keys(t.workflow),
    outputNodeIds: t.outputNodeId ? [t.outputNodeId] : [],
    disabledNodes: t.disabledNodes,
    params: t.params,
    slots: [],
  };
  return { ...t, variants: [def] };
}

let initOnce: Promise<void> | null = null;

export const useComfy = create<ComfyState>((set, get) => ({
  templates: [],
  online: "unknown",
  onlineInfo: "",
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<ComfyTemplate[]>("comfy-templates.json", "v1");
      const list = (saved ?? []).map(normalizeTemplate);
      set({ templates: list, loaded: true });
    })()),

  upsert: (tpl) => {
    const list = get().templates.filter((t) => t.id !== tpl.id);
    const next = [tpl, ...list];
    set({ templates: next });
    void saveJSON("comfy-templates.json", "v1", next);
  },

  remove: (id) => {
    const next = get().templates.filter((t) => t.id !== id);
    set({ templates: next });
    void saveJSON("comfy-templates.json", "v1", next);
  },

  test: async (host) => {
    set({ online: "unknown", onlineInfo: "" });
    const r = await pingComfy(host);
    set({ online: r.ok ? "ok" : "down", onlineInfo: r.info ?? "" });
    return { ok: r.ok, err: r.err };
  },
}));
