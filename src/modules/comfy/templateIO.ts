/**
 * ComfyUI 模板导入/导出工具 — 模板管理器与设置页共用
 *  - 识别三种 JSON：原始 API 工作流 / 单个模板 / 模板包（数组或 {momoComfyTemplates, templates}）
 *  - 原始工作流可自动暴露常用参数直接成模板（批量导入用）
 *  - 导出走 Tauri 保存对话框，浏览器预览退回 a[download]
 */
import type { ComfyExposedParam, ComfyTemplate, ComfyVariant, ComfyWfNode } from "../../core/types";
import { guessOutputNode, isApiWorkflow, listWorkflowInputs, fetchObjectInfo, normalizeHost, type WfInputInfo } from "../../core/services/comfy";
import { xfetch } from "../../core/services/http";
import { isFrontendWorkflow, convertFrontendWorkflow, convertApiToFrontend } from "./frontendConvert";
import { useComfy } from "../../core/stores/comfyStore";
import { useSettings } from "../../core/stores/settingsStore";
import { toast } from "../../core/stores/uiStore";
import { openExternal } from "../../core/external";
import { errMsg, isTauri, uid } from "../../core/utils";

export type ExposeMap = Record<string, { label: string; kind: ComfyExposedParam["kind"] }>;

/** 自动暴露最常用的参数：提示词文本 / 种子 / LoadImage */
export function autoExposeMap(inputs: WfInputInfo[]): ExposeMap {
  const map: ExposeMap = {};
  for (const i of inputs) {
    const key = `${i.nodeId}.${i.input}`;
    const label = `${i.nodeTitle} · ${i.input}`;
    if (i.classType === "CLIPTextEncode" && i.input === "text") map[key] = { label, kind: "text" };
    // Primitive 多行文本（MiniMax H3 REF2VA 的提示词入口）
    else if (i.classType === "PrimitiveStringMultiline" && i.input === "value") map[key] = { label, kind: "text" };
    // 自定义节点的提示词输入（MiniMax H3 FL2VA 子图展开后的 MiniMaxH3ImageToVideo.prompt 等）
    else if (i.input === "prompt" && typeof i.value === "string") map[key] = { label, kind: "text" };
    else if (i.kind === "seed") map[key] = { label, kind: "seed" };
    else if (i.kind === "image") map[key] = { label, kind: "image" };
  }
  return map;
}

/** 暴露表 → 参数列表（保存模板 / 自动建模板共用） */
export function paramsFromExpose(workflow: Record<string, ComfyWfNode>, expose: ExposeMap): ComfyExposedParam[] {
  const params: ComfyExposedParam[] = [];
  for (const i of listWorkflowInputs(workflow)) {
    const key = `${i.nodeId}.${i.input}`;
    const ex = expose[key];
    if (!ex) continue;
    params.push({
      key,
      nodeId: i.nodeId,
      input: i.input,
      label: ex.label || `${i.nodeTitle} · ${i.input}`,
      kind: ex.kind,
      value: i.value as string | number | boolean,
    });
  }
  return params;
}

/** 原始 API 工作流 → 自动暴露参数的完整模板（批量导入时免手工勾选） */
export function autoTemplate(workflow: Record<string, ComfyWfNode>, name: string): ComfyTemplate {
  return {
    id: uid(8),
    name,
    workflow,
    params: paramsFromExpose(workflow, autoExposeMap(listWorkflowInputs(workflow))),
    outputNodeId: guessOutputNode(workflow),
    createdAt: Date.now(),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const looksTemplate = (t: any): boolean =>
  !!t && typeof t === "object" && typeof t.name === "string" && isApiWorkflow(t.workflow);

/**
 * 从任意 JSON 里解析出模板列表：
 * 模板包 {momoComfyTemplates, templates:[…]} / 模板数组 / 单个模板对象；都不是则返回 null
 */
export function templatesFromJson(json: unknown): ComfyTemplate[] | null {
  const j = json as any;
  const arr: unknown[] | null = Array.isArray(j)
    ? j
    : Array.isArray(j?.templates)
      ? j.templates
      : looksTemplate(j)
        ? [j]
        : null;
  if (!arr) return null;
  const out: ComfyTemplate[] = [];
  for (const raw of arr) {
    const t = raw as any;
    if (!looksTemplate(t)) continue;
    out.push({
      id: typeof t.id === "string" && t.id ? t.id : uid(8),
      name: t.name,
      workflow: t.workflow,
      params: Array.isArray(t.params) ? (t.params as ComfyExposedParam[]) : [],
      outputNodeId: typeof t.outputNodeId === "string" ? t.outputNodeId : undefined,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      // v2 新增：保留 variants（导入后由 comfyStore.init 的 normalizeTemplate 兜底补 default 分支）
      variants: Array.isArray(t.variants) ? (t.variants as ComfyVariant[]) : undefined,
    });
  }
  return out.length ? out : null;
}

/** 模板列表 → 可再导入的模板包 JSON 文本（v2：含子工作流分支） */
export function packTemplates(tpls: ComfyTemplate[]): string {
  return JSON.stringify({ momoComfyTemplates: 2, exportedAt: new Date().toISOString(), templates: tpls }, null, 2);
}

/**
 * 批量导入模板文件：每个文件可以是原始 API 工作流（自动暴露常用参数直接成模板）、
 * 前端格式工作流（nodes/links/definitions，需 ComfyUI 在线辅助转换）、单个模板或模板包；
 * 返回成功数与失败明细
 */
export async function importTemplateFilesAuto(files: Iterable<File>): Promise<{ saved: number; errs: string[] }> {
  let saved = 0;
  const errs: string[] = [];
  const upsert = useComfy.getState().upsert;
  for (const f of Array.from(files)) {
    try {
      const json: unknown = JSON.parse(await f.text());
      if (isApiWorkflow(json)) {
        upsert(autoTemplate(json, f.name.replace(/\.json$/i, "")));
        saved++;
        continue;
      }
      // 前端格式（graph JSON）：需 ComfyUI 在线（/object_info 提供 widget 名序），支持一层子图展开
      if (isFrontendWorkflow(json)) {
        const host = useSettings.getState().settings.comfy.host;
        const info = host ? await fetchObjectInfo(host) : null;
        if (!info) throw new Error("导入前端格式工作流需要 ComfyUI 在线（用于读取节点定义），请先启动 ComfyUI 并在设置里配置地址");
        const { workflow, warnings } = convertFrontendWorkflow(json, info);
        upsert(autoTemplate(workflow, f.name.replace(/\.json$/i, "")));
        saved++;
        for (const w of warnings) errs.push(`${f.name}：⚠️ ${w}`);
        continue;
      }
      const tpls = templatesFromJson(json);
      if (!tpls) throw new Error("不是 API 格式工作流，也不是 momo 模板/模板包");
      for (const t of tpls) upsert(t);
      saved += tpls.length;
    } catch (e) {
      errs.push(`${f.name}：${errMsg(e)}`);
    }
  }
  return { saved, errs };
}

/** 按文件扩展名推断保存对话框过滤器名 + MIME */
function fileFilter(filename: string): { filterName: string; ext: string; mime: string } {
  const ext = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? "json";
  const map: Record<string, { filterName: string; mime: string }> = {
    json: { filterName: "JSON", mime: "application/json" },
    xml: { filterName: "XML", mime: "application/xml" },
    srt: { filterName: "SRT 字幕", mime: "application/x-subrip" },
    csv: { filterName: "CSV 表格", mime: "text/csv" },
    md: { filterName: "Markdown", mime: "text/markdown" },
    txt: { filterName: "文本", mime: "text/plain" },
  };
  const m = map[ext] ?? { filterName: "文本", mime: "text/plain" };
  return { filterName: m.filterName, ext, mime: m.mime };
}

/** 保存文本到本地文件（Tauri 保存对话框 / 浏览器下载） */
export async function saveTextFile(filename: string, text: string): Promise<boolean> {
  const { filterName, ext, mime } = fileFilter(filename);
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename, filters: [{ name: filterName, extensions: [ext] }] });
    if (!path) return false;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, text);
    return true;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

/* ---------------- ComfyUI 往返编辑：模板 ⇄ ComfyUI 画布（一键 + 自动同步） ---------------- */

/** 模板名 → ComfyUI 工作流目录里的文件名（去掉路径非法字符） */
export function comfyEditFilename(name: string): string {
  return `MOMO_${name.replace(/[\\/:*?"<>|]/g, "_")}.json`;
}

/** 工作流目录（设置 comfy.workflowDir）里该模板的完整路径；没配目录返回 null */
function comfyEditPath(tplName: string): string | null {
  const dir = useSettings.getState().settings.comfy.workflowDir?.trim();
  if (!dir) return null;
  return `${dir.replace(/[\\/]+$/, "")}\\${comfyEditFilename(tplName)}`;
}

/** 把模板工作流写出到目标路径（目录不存在则建），返回写出的文本 */
async function writeEditFile(path: string, workflow: Record<string, ComfyWfNode>): Promise<string> {
  const text = JSON.stringify(workflow, null, 2);
  const { writeTextFile, mkdir, exists } = await import("@tauri-apps/plugin-fs");
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  if (!(await exists(dir))) await mkdir(dir, { recursive: true }).catch(() => undefined);
  await writeTextFile(path, text);
  return text;
}

/** ComfyUI userdata 接口 URL：相对路径整体 encodeURIComponent（斜杠必须编码成 %2F 才能命中路由） */
function comfyUserdataUrl(host: string, relPath: string): string {
  return `${normalizeHost(host)}/userdata/${encodeURIComponent(relPath)}`;
}

/** 经 ComfyUI userdata 接口把工作流写进它的工作流库（API 格式，界面可直接打开编辑） */
async function pushWorkflowToComfy(host: string, relPath: string, text: string): Promise<void> {
  const r = await xfetch(`${comfyUserdataUrl(host, relPath)}?overwrite=true&full_info=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
  });
  if (!r.ok) throw new Error(`ComfyUI 拒绝了写入（HTTP ${r.status}）`);
}

/** 经 userdata 接口读回工作流文本；接口不可用/文件不存在返回 null */
async function pullWorkflowText(host: string, relPath: string): Promise<string | null> {
  try {
    const r = await xfetch(`${comfyUserdataUrl(host, relPath)}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/**
 * 读回 ComfyUI 里保存过的工作流文件（前端格式或 API 格式都认），转换并合并回模板：
 * 保留 id/名称/创建时间/分支；暴露参数只留仍存在的节点输入；输出节点丢失时重新猜。
 * 优先走 ComfyUI userdata 接口；没配地址再走本地目录 / 文件选择框。
 */
export async function syncFromComfyEditor(tpl: ComfyTemplate): Promise<{ merged: ComfyTemplate; droppedParams: number; warnings: string[] }> {
  const host = useSettings.getState().settings.comfy.host;
  if (host) {
    const text = await pullWorkflowText(host, `workflows/${comfyEditFilename(tpl.name)}`);
    if (text !== null) return mergeWorkflowText(tpl, text);
    throw new Error("ComfyUI 工作流库里没有这个模板的文件——先点「送 ComfyUI 编辑」推送一次");
  }
  if (!isTauri) throw new Error("浏览器预览模式：请到桌面应用中使用 ComfyUI 往返编辑");
  const dirPath = comfyEditPath(tpl.name);
  let text: string | null = null;
  if (dirPath) {
    const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
    if (await exists(dirPath)) text = await readTextFile(dirPath);
  }
  if (text === null) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      title: `选择「${tpl.name}」在 ComfyUI 里保存的工作流文件（MOMO_*.json）`,
      filters: [{ name: "JSON 工作流", extensions: ["json"] }],
      defaultPath: dirPath?.replace(/[\\/][^\\/]+$/, "") || undefined,
    });
    if (!picked || typeof picked !== "string") throw new Error("已取消");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    text = await readTextFile(picked);
  }
  return mergeWorkflowText(tpl, text);
}

/** 工作流 JSON 文本（前端格式或 API 格式）→ 转换并合并回模板 */
async function mergeWorkflowText(tpl: ComfyTemplate, text: string): Promise<{ merged: ComfyTemplate; droppedParams: number; warnings: string[] }> {
  const json: unknown = JSON.parse(text);
  let workflow: Record<string, ComfyWfNode>;
  let warnings: string[] = [];
  if (isApiWorkflow(json)) {
    workflow = json;
  } else if (isFrontendWorkflow(json)) {
    // ComfyUI 界面 Ctrl+S 保存的是前端格式：转换需要 ComfyUI 在线（/object_info 提供 widget 名序）
    const host = useSettings.getState().settings.comfy.host;
    const info = host ? await fetchObjectInfo(host) : null;
    if (!info) throw new Error("ComfyUI 界面保存的是前端格式，转换需要 ComfyUI 在线，请先启动 ComfyUI");
    const r = convertFrontendWorkflow(json, info);
    workflow = r.workflow;
    warnings = r.warnings;
  } else {
    throw new Error("文件既不是 API 格式工作流，也不是 ComfyUI 前端格式（nodes/links）");
  }
  const params = tpl.params.filter((p) => {
    const n = workflow[p.nodeId];
    return !!n && p.input in (n.inputs ?? {});
  });
  const outputNodeId = tpl.outputNodeId && workflow[tpl.outputNodeId] ? tpl.outputNodeId : guessOutputNode(workflow);
  return { merged: { ...tpl, workflow, params, outputNodeId }, droppedParams: tpl.params.length - params.length, warnings };
}

/* —— 自动往返会话：推送到 ComfyUI 工作流库 → 打开 ComfyUI → 轮询，Ctrl+S 后自动同步回模板 —— */

type TripSession = { timer: number; last: string; errShown: boolean; http?: { host: string; relPath: string }; file?: string };
/** 模板 id → 监听会话（组件外存活：用户切走模板管理弹窗也继续监听） */
const tripSessions = new Map<string, TripSession>();

export function isTripWatching(tplId: string): boolean {
  return tripSessions.has(tplId);
}

/** 停止监听（ComfyUI 工作流库里的文件保留，不影响） */
export function stopTripWatch(tplId: string): void {
  const s = tripSessions.get(tplId);
  if (!s) return;
  clearInterval(s.timer);
  tripSessions.delete(tplId);
}

/**
 * 确保有可用的 ComfyUI 工作流目录（仅在没配 ComfyUI 地址、走本地文件兜底时用到）：
 * 弹一次目录选择器，选完写回设置永久记住。取消返回 null。
 */
async function ensureWorkflowDir(): Promise<string | null> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const cur = useSettings.getState().settings.comfy.workflowDir?.trim();
  if (cur && (await exists(cur))) return cur;
  if (cur) toast("配置的 ComfyUI 工作流目录不存在，请重新选择一次", "info");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    title: "首次使用：选择 ComfyUI 的工作流目录（通常在 …/ComfyUI/user/default/workflows；选这一次以后全程自动）",
  });
  if (!picked || typeof picked !== "string") return null;
  const s = useSettings.getState().settings;
  useSettings.getState().update("comfy", { ...s.comfy, workflowDir: picked });
  if (!/[\\/]workflows$/i.test(picked)) {
    toast("注意：一般应选 ComfyUI 目录下的 user\\default\\workflows，选错的话 ComfyUI 左侧列表里看不到模板", "info");
  }
  return picked;
}

/**
 * 一键往返编辑（零配置）：模板经 ComfyUI userdata 接口直接写进它的工作流库（MOMO_<模板名>.json，
 * 左侧工作流列表即刻可见）→ 自动在浏览器打开 ComfyUI → 轮询该文件，在 ComfyUI 里 Ctrl+S 保存后
 * 自动转换合并回模板并 toast。没配 ComfyUI 地址时退回本地文件方式（首次选一次目录并记住）。
 */
export async function startComfyRoundTrip(tpl: ComfyTemplate): Promise<string> {
  if (!isTauri) throw new Error("往返编辑需要在桌面应用里使用");
  const host = useSettings.getState().settings.comfy.host;
  const filename = comfyEditFilename(tpl.name);
  const relPath = `workflows/${filename}`;
  let session: TripSession;
  if (host) {
    // ComfyUI 工作流库只认前端格式（nodes/links）：API 格式点开是空白画布，先转换再推
    const info = await fetchObjectInfo(host);
    if (!info) throw new Error("需要 ComfyUI 在线（读取节点定义做格式转换）——请确认 ComfyUI 已启动、设置里的服务地址正确");
    const text = JSON.stringify(convertApiToFrontend(tpl.workflow, info));
    try {
      await pushWorkflowToComfy(host, relPath, text);
    } catch (e) {
      throw new Error(
        `无法写入 ComfyUI 工作流库（${errMsg(e)}）——请确认 ComfyUI 已启动、设置里的服务地址正确（当前 ${host}）`,
      );
    }
    await openExternal(normalizeHost(host)).catch(() => undefined);
    session = { timer: 0, last: text, errShown: false, http: { host, relPath } };
  } else {
    const dir = await ensureWorkflowDir();
    if (!dir) throw new Error("已取消：没有选择 ComfyUI 工作流目录");
    const path = `${dir.replace(/[\\/]+$/, "")}\\${filename}`;
    const text = await writeEditFile(path, tpl.workflow);
    session = { timer: 0, last: text, errShown: false, file: path };
  }
  stopTripWatch(tpl.id);
  session.timer = window.setInterval(() => void pollTrip(tpl.id), 2000);
  tripSessions.set(tpl.id, session);
  return host ? `ComfyUI 工作流库/${filename}` : session.file!;
}

/** 轮询一次：文件内容变了就转换合并回模板（解析失败只提示一次、下轮重试） */
async function pollTrip(tplId: string): Promise<void> {
  const session = tripSessions.get(tplId);
  if (!session) return;
  const cur = useComfy.getState().templates.find((t) => t.id === tplId);
  if (!cur) return stopTripWatch(tplId);
  let text: string | null = null;
  if (session.http) text = await pullWorkflowText(session.http.host, session.http.relPath);
  else if (session.file) {
    try {
      const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
      if (await exists(session.file)) text = await readTextFile(session.file);
    } catch {
      /* ComfyUI 保存瞬间可能读到半截，下一轮再看 */
    }
  }
  if (text === null || text === session.last) return;
  try {
    const r = await mergeWorkflowText(cur, text);
    session.last = text;
    session.errShown = false;
    useComfy.getState().upsert(r.merged);
    toast(
      `「${cur.name}」已从 ComfyUI 自动同步（${Object.keys(r.merged.workflow).length} 节点${r.droppedParams ? `，剔除 ${r.droppedParams} 个失效参数` : ""}）${r.warnings.length ? `；⚠️ ${r.warnings[0]}` : ""}`,
      "ok",
    );
  } catch (e) {
    if (!session.errShown) {
      session.errShown = true;
      toast(`自动同步失败（继续监听，保存完整后会重试）：${errMsg(e)}`, "err");
    }
  }
}
