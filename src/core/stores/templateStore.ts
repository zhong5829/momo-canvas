/**
 * 画布模板库 — 把组/一组节点打包成可反复实例化的模板（LibTV「打组模板」/ Krea Node App 的桌面端形态）
 * 内置示例模板（seedTemplates）合并展示，不落盘、不可删除
 */
import { create } from "zustand";
import type { Edge } from "@xyflow/react";
import type { AppNode, BoardTemplate, ImportResult, NodeKind, TemplateEdge, TemplateNode } from "../types";
import { buildPayload, parsePayload, wrapTemplatePayload } from "../momoflow";
import { defaultData, NODE_LABEL, useBoard } from "./boardStore";
import { loadJSON, saveJSON } from "../persist";
import { isTauri, uid } from "../utils";
import { SEED_TEMPLATES } from "../seedTemplates";

/** 模板保存时的数据清洗：保留配置、丢运行结果与大图（模板要轻，且结果没有复用意义） */
function cleanData(kind: NodeKind, data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data };
  d.status = "idle";
  delete d.error;
  delete d.progress;
  delete d.progressPct;
  delete d.ignored;
  if ("picked" in d) d.picked = 0;
  if ("results" in d) d.results = Array.isArray(d.results) ? [] : {};
  delete d.result;
  delete d.resultUrl;
  delete d.mask; // 蒙版/框选与具体图片绑定，模板里没有意义
  delete d.rect;
  delete d.srcW;
  delete d.srcH;
  delete d.outW;
  delete d.outH;
  // 节点级历史 / 脏标记签名 / 备用模型徽标：都是运行态，模板与分享包不带（否则膨胀 + 泄漏跨画布历史）
  delete d.history;
  delete d.inputSig;
  delete d.rev;
  delete d.fallbackModel;
  if (kind === "image") {
    delete d.src; // 图片本体不进模板（避免 boards 级别的大 dataURL 膨胀）
    delete d.name;
  }
  if (kind === "chat") d.messages = [];
  return d;
}

type TemplateState = {
  templates: BoardTemplate[];
  loaded: boolean;
  init: () => Promise<void>;
  /** 全部模板：用户模板 + 内置示例 */
  all: () => BoardTemplate[];
  /** 把一组节点（组成员或多选）存为模板；返回模板 id */
  saveFrom: (name: string, nodes: AppNode[], edges: Edge[]) => string;
  remove: (id: string) => void;
  /** 实例化到画布：以 at 为左上角展开（重新生成 id、恢复连线），并整体选中 */
  instantiate: (tpl: BoardTemplate, at: { x: number; y: number }) => void;
  /** 导出为 .momoflow 工作流文件（Tauri 走存盘对话框，浏览器预览走下载）；withMedia=true 内嵌素材。
   *  返回落点或 null=用户取消 */
  exportOne: (tpl: BoardTemplate, withMedia?: boolean) => Promise<string | null>;
  /** 导出当前画布快照（不入模板库）：name + nodes/edges → .momoflow 文件 */
  exportBoard: (name: string, nodes: AppNode[], edges: Edge[], withMedia?: boolean) => Promise<string | null>;
  /** 从文件文本导入工作流；校验节点类型，回填内嵌素材，返回 {name, missing}（格式不对抛中文错误） */
  importText: (text: string) => Promise<ImportResult>;
  /** Tauri：打开文件对话框选 .momoflow 导入；返回导入结果或 null=取消 */
  importViaDialog: () => Promise<ImportResult | null>;
};

let initOnce: Promise<void> | null = null;
type PersistShape = { templates: BoardTemplate[] };

export const useTemplates = create<TemplateState>((set, get) => {
  const persist = () => {
    if (!get().loaded) return;
    void saveJSON("boardTemplates.json", "v1", { templates: get().templates } satisfies PersistShape);
  };

  return {
    templates: [],
    loaded: false,

    init: () =>
      (initOnce ??= (async () => {
        const saved = await loadJSON<PersistShape>("boardTemplates.json", "v1");
        set({ templates: saved?.templates ?? [], loaded: true });
      })()),

    all: () => [...get().templates, ...SEED_TEMPLATES],

    saveFrom: (name, nodes, edges) => {
      // 组节点在前（成员 parentTid 指向它）；位置统一转为相对包围盒左上角
      const ids = new Set(nodes.map((n) => n.id));
      const abs = (n: AppNode) => {
        const p = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
        return { x: n.position.x + (p?.position.x ?? 0), y: n.position.y + (p?.position.y ?? 0) };
      };
      const minX = Math.min(...nodes.map((n) => abs(n).x));
      const minY = Math.min(...nodes.map((n) => abs(n).y));
      const idToTid = new Map<string, string>();
      for (const n of nodes) idToTid.set(n.id, uid(6));
      const tnodes: TemplateNode[] = nodes.map((n) => ({
        tid: idToTid.get(n.id)!,
        kind: n.type as NodeKind,
        // 组成员保留相对父级坐标；顶层节点转为相对包围盒
        x: n.parentId && ids.has(n.parentId) ? n.position.x : abs(n).x - minX,
        y: n.parentId && ids.has(n.parentId) ? n.position.y : abs(n).y - minY,
        data: cleanData(n.type as NodeKind, n.data as Record<string, unknown>),
        parentTid: n.parentId && ids.has(n.parentId) ? idToTid.get(n.parentId) : undefined,
        w: n.type === "group" ? Number((n.style as Record<string, unknown> | undefined)?.width) || undefined : undefined,
        h: n.type === "group" ? Number((n.style as Record<string, unknown> | undefined)?.height) || undefined : undefined,
      }));
      const tedges: TemplateEdge[] = edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          sourceTid: idToTid.get(e.source)!,
          targetTid: idToTid.get(e.target)!,
          sourceHandle: e.sourceHandle ?? undefined,
          targetHandle: e.targetHandle ?? undefined,
        }));
      const tpl: BoardTemplate = { id: uid(8), name, nodes: tnodes, edges: tedges, createdAt: Date.now() };
      set((s) => ({ templates: [tpl, ...s.templates] }));
      persist();
      return tpl.id;
    },

    remove: (id) => {
      set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
      persist();
    },

    instantiate: (tpl, at) => {
      const tidToId = new Map<string, string>();
      for (const tn of tpl.nodes) tidToId.set(tn.tid, `n_${uid(8)}`);
      // 组节点必须排在成员之前（xyflow 要求 parent 先于 child）
      const ordered = [...tpl.nodes].sort((a, b) => Number(a.kind !== "group") - Number(b.kind !== "group"));
      const nodes: AppNode[] = ordered.map((tn) => ({
        id: tidToId.get(tn.tid)!,
        type: tn.kind,
        position: tn.parentTid ? { x: tn.x, y: tn.y } : { x: at.x + tn.x, y: at.y + tn.y },
        // 以最新 defaultData 打底，模板缺字段也能得到完整节点数据
        data: { ...defaultData(tn.kind), ...tn.data },
        parentId: tn.parentTid ? tidToId.get(tn.parentTid) : undefined,
        extent: tn.parentTid ? ("parent" as const) : undefined,
        style: tn.kind === "group" && tn.w && tn.h ? { width: tn.w, height: tn.h } : undefined,
        selected: true,
      }));
      const edges: Edge[] = tpl.edges
        .filter((te) => tidToId.has(te.sourceTid) && tidToId.has(te.targetTid))
        .map((te) => {
          return {
            id: `e_${uid(8)}`,
            source: tidToId.get(te.sourceTid)!,
            target: tidToId.get(te.targetTid)!,
            sourceHandle: te.sourceHandle,
            targetHandle: te.targetHandle,
            className: "",
            interactionWidth: 28,
          };
        });
      useBoard.getState().insertFragment(nodes, edges);
    },

    exportOne: async (tpl, withMedia = false) => {
      const payload = await wrapTemplatePayload({ ...tpl, builtin: undefined }, withMedia);
      return saveFile(JSON.stringify(payload, null, 2), `${tpl.name.replace(/[\\/:*?"<>|]/g, "_")}.momoflow`);
    },

    exportBoard: async (name, nodes, edges, withMedia = false) => {
      const payload = await buildPayload(name, nodes, edges, withMedia);
      return saveFile(JSON.stringify(payload, null, 2), `${name.replace(/[\\/:*?"<>|]/g, "_")}.momoflow`);
    },

    importText: async (text) => {
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error("不是有效的工作流文件（JSON 解析失败）");
      }
      // v2 载荷 {template, assets, requires} → 回填素材；v1 纯 template 直接用
      const payload = j as { template?: unknown; assets?: Record<string, string>; requires?: unknown };
      const rawTpl = (payload.template ?? j) as Partial<BoardTemplate>;
      let tpl: BoardTemplate;
      if (payload.assets && payload.template) {
        tpl = await parsePayload(j as Parameters<typeof parsePayload>[0]);
      } else {
        tpl = rawTpl as BoardTemplate;
      }
      if (!Array.isArray(tpl?.nodes) || !tpl.nodes.length) throw new Error("工作流文件里没有节点数据");
      // 只保留本版本认识的节点类型（旧版导入新版文件时跳过未知节点而不是报废整个文件）
      const nodes = tpl.nodes.filter((n) => n?.tid && n.kind in NODE_LABEL);
      if (!nodes.length) throw new Error("工作流文件里的节点类型都无法识别（可能来自更新版本的 MOMO）");
      const tids = new Set(nodes.map((n) => n.tid));
      const edges = (tpl.edges ?? []).filter((e) => tids.has(e.sourceTid) && tids.has(e.targetTid));
      const importTpl: BoardTemplate = {
        id: uid(8),
        name: String(tpl.name ?? "导入的工作流").slice(0, 40),
        nodes,
        edges,
        createdAt: Date.now(),
      };
      set((s) => ({ templates: [importTpl, ...s.templates] }));
      persist();
      // requires 检测：本机缺哪些模型/协议，导入 UI 据此提示
      const req = (payload.requires ?? {}) as { models?: string[]; protocols?: unknown[] };
      const { useSettings } = await import("./settingsStore");
      const haveModels = new Set<string>();
      for (const p of useSettings.getState().settings.models.providers)
        for (const r of Object.values(p.models)) for (const m of r?.models ?? []) haveModels.add(m);
      const missingModels = (req.models ?? []).filter((m) => !haveModels.has(m));
      return { name: importTpl.name, missing: { models: missingModels, protocols: [] } };
    },

    importViaDialog: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, filters: [{ name: "MOMO 工作流", extensions: ["momoflow", "json"] }] });
      if (!path || Array.isArray(path)) return null;
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const text = new TextDecoder().decode(await readFile(path));
      return get().importText(text);
    },
  };
});

/** 存盘/下载 .momoflow 文件的公共逻辑（Tauri 走对话框，浏览器走下载） */
async function saveFile(content: string, fname: string): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: fname, filters: [{ name: "MOMO 工作流", extensions: ["momoflow", "json"] }] });
    if (!path) return null;
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, new TextEncoder().encode(content));
    return path;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  return fname;
}
