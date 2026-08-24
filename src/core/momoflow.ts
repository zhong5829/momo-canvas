/**
 * .momoflow 分享包组装/解析 — v2 可内嵌素材。复用 blobStore 的 externalizeToMap/hydrateFromMap
 * 与 templateStore 的 nodes↔template 转换（toTemplateNodes 复刻自 saveFrom，加 keepMedia 开关）。
 * 组装：BoardTemplate → externalizeToMap 脱壳大图 → MomoflowPayload（含 assets + requires）。
 * 解析：payload → hydrateFromMap 回填 → BoardTemplate（缺素材的引用宽容保留）。
 */
import type { Edge } from "@xyflow/react";
import { externalizeToMap, hydrateFromMap } from "./blobStore";
import type { AppNode, BoardTemplate, CustomProtocol, ModelRole, MomoflowPayload, MomoflowRequires, NodeKind, TemplateEdge, TemplateNode } from "./types";
import { uid } from "./utils";

/** 模板数据清洗。keepMedia=false（存量模板/仅结构导出）丢运行结果与大图；true（含素材导出）保留 */
export function cleanData(kind: NodeKind, data: Record<string, unknown>, keepMedia = false): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data };
  d.status = "idle";
  delete d.error;
  delete d.progress;
  delete d.progressPct;
  delete d.ignored;
  if ("picked" in d) d.picked = 0;
  if (!keepMedia) {
    if ("results" in d) d.results = Array.isArray(d.results) ? [] : {};
    delete d.result;
    delete d.resultUrl;
    delete d.resultUrls;
    delete d.history;
    delete d.fallbackModel;
    delete d.mask;
    delete d.rect;
    delete d.srcW;
    delete d.srcH;
    delete d.outW;
    delete d.outH;
    if (kind === "image") {
      delete d.src;
      delete d.name;
    }
    if (kind === "chat") d.messages = [];
  }
  return d;
}

/** 一组节点 → 模板节点/边（复刻 templateStore.saveFrom 的坐标转换；keepMedia 控制是否保留素材） */
export function toTemplateNodes(
  nodes: AppNode[],
  edges: Edge[],
  keepMedia = false,
): { nodes: TemplateNode[]; edges: TemplateEdge[] } {
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
    x: n.parentId && ids.has(n.parentId) ? n.position.x : abs(n).x - minX,
    y: n.parentId && ids.has(n.parentId) ? n.position.y : abs(n).y - minY,
    data: cleanData(n.type as NodeKind, n.data as Record<string, unknown>, keepMedia),
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
  return { nodes: tnodes, edges: tedges };
}

/** 模型键字段名（扫描节点 data 抽取需要的模型） */
const MODEL_FIELDS = ["modelId", "chatModelId", "imageModelId", "videoModelId", "audioModelId"];

/** 从 template 抽取分享包要声明的外部依赖（模型名 + 用到的自定义协议） */
async function extractRequires(tpl: BoardTemplate): Promise<MomoflowRequires> {
  const models = new Set<string>();
  let protocols: CustomProtocol[] = [];
  try {
    const { useSettings, splitModelKey } = await import("./stores/settingsStore");
    const s = useSettings.getState().settings;
    for (const tn of tpl.nodes) {
      for (const f of MODEL_FIELDS) {
        const key = (tn.data as Record<string, unknown>)[f];
        if (typeof key === "string" && key) {
          const { model } = splitModelKey(key);
          if (model) models.add(model);
        }
      }
    }
    // 节点引用的自定义协议随包带上（协议体无密钥，安全）
    const protoIds = new Set<string>();
    for (const p of s.models.providers)
      for (const r of ["chat", "image", "video", "audio", "asr"] as const) {
        const slot = p.models[r as ModelRole];
        if (slot?.protocol?.startsWith("custom:")) protoIds.add(slot.protocol.slice("custom:".length));
      }
    protocols = s.customProtocols.filter((p) => protoIds.has(p.id));
  } catch {
    /* settingsStore 尚未初始化 → 空 requires */
  }
  return { models: [...models], protocols: protocols.length ? protocols : undefined };
}

/** 组装 .momoflow 载荷：含素材时大图脱壳进 assets */
export async function buildPayload(
  name: string,
  nodes: AppNode[],
  edges: Edge[],
  withMedia: boolean,
): Promise<MomoflowPayload> {
  const { nodes: tnodes, edges: tedges } = toTemplateNodes(nodes, edges, withMedia);
  const tpl: BoardTemplate = { id: uid(8), name, nodes: tnodes, edges: tedges, createdAt: Date.now() };
  const requires = await extractRequires(tpl);
  if (!withMedia) return { app: "momo-canvas", type: "boardflow", version: 2, template: tpl, requires };
  const assets = new Map<string, string>();
  const externalized = await externalizeToMap(tpl, assets);
  return { app: "momo-canvas", type: "boardflow", version: 2, template: externalized, assets: Object.fromEntries(assets), requires };
}

/** 预估含素材导出的体积（字节）——给 UI 的「含素材/仅结构」开关参考 */
export async function estimateMediaBytes(nodes: AppNode[]): Promise<number> {
  const assets = new Map<string, string>();
  await externalizeToMap({ nodes }, assets);
  let sum = 0;
  for (const v of assets.values()) sum += v.length;
  return sum;
}

/** 解析 .momoflow 载荷 → BoardTemplate（回填素材；缺素材的引用保留不炸） */
export async function parsePayload(payload: MomoflowPayload): Promise<BoardTemplate> {
  return hydrateFromMap(payload.template, payload.assets ?? {});
}

/** 从已存的 BoardTemplate 组装载荷（库存模板导出用；含素材时大图脱壳进 assets） */
export async function wrapTemplatePayload(tpl: BoardTemplate, withMedia: boolean): Promise<MomoflowPayload> {
  const requires = await extractRequires(tpl);
  if (!withMedia) return { app: "momo-canvas", type: "boardflow", version: 2, template: tpl, requires };
  const assets = new Map<string, string>();
  const externalized = await externalizeToMap(tpl, assets);
  return { app: "momo-canvas", type: "boardflow", version: 2, template: externalized, assets: Object.fromEntries(assets), requires };
}
