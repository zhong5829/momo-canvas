/**
 * 导演台生成队列 — 批量生成调度 + 跨重启恢复
 *
 * 方案 §7.8：任务粒度 = 一个 Segment + 一个生成目标 + 一个 Take。
 * 状态机：草稿→排队中→执行→成功待选 / 失败可重试 / 已取消。
 *
 * 队列规则（方案 §7.8）：
 *  - 本地 ComfyUI 默认并发 1（避免显存竞争）
 *  - 远程 API 按服务商并发
 *  - 支持「生成所选/缺失/重试失败」
 *  - 跨重启恢复：运行中的 Take 标「中断」，不静默重置
 *
 * 本轮实现：
 *  ① 单 Take 执行（图片/视频配方）
 *  ② 批量操作（生成缺失/重试失败/生成所选）
 *  ③ 中断恢复（启动时把 running 标 interrupted）
 */
import { useDirector } from "./stores/directorStore";
import { useAssets } from "./stores/assetStore";
import { useSettings } from "./stores/settingsStore";
import { useComfy } from "./stores/comfyStore";
import { resolveModelCard } from "./stores/settingsStore";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { runComfyTemplate } from "./services/comfy";
import { compilePrompt, compileNegative, segmentShotContexts } from "./directorPrompt";
import { buildSkillSystem } from "./skillEngine";
import { directorError, createTake } from "./directorEngine";
import { refsNoteFromSnapshot, resolveSlotImages } from "./directorRefs";
import { useSkills } from "./stores/skillStore";
import { assetToDataUrl, assetUrl } from "./services/assetFiles";
import { grabFrame } from "./videoEdit";
import type { SkillRunSnapshot } from "./skillTypes";
import type { DirectorProject, DirectorSegment, DirectorTake, DirectorPostRecipe, DirectorRecipe } from "./types";

/** 从一个已完成的 Take 抽出「尾帧」dataURL，作为下一段的接力首帧。视频抽尾帧、图片直接用原图。 */
async function takeTailFrame(take: DirectorTake): Promise<string | null> {
  if (!take.assetId) return null;
  const asset = useAssets.getState().items.find((a) => a.id === take.assetId);
  if (!asset) return null;
  try {
    if (asset.kind === "video") {
      const { dataUrl } = await grabFrame(assetUrl(asset.path), "last");
      return dataUrl;
    }
    return await assetToDataUrl(asset.path, asset.mime);
  } catch {
    return null;
  }
}

/**
 * 为 segment 编译生成提示词：
 *  1. 基础 = segment.promptOverride ?? compilePrompt（模型无关镜头结构）
 *  2. 追加项目级 Skill 栈的指令（方案 §17.8：项目 Skill 作用于所有片段）
 *  3. 追加负向规则（compileNegative）
 * 返回编译后的真实请求文本 + 实际执行的 Skill 快照（方案 §17.4：写进 Take 可追溯）。
 */
function compileSegmentPrompt(
  project: DirectorProject,
  segment: DirectorSegment,
  target: "image-t2i" | "video-t2v",
): { prompt: string; snapshots: SkillRunSnapshot[] } {
  const ctxs = segmentShotContexts(project, segment);
  let prompt = segment.promptOverride ?? (ctxs.length ? compilePrompt(ctxs[0], target) : segment.summary);
  const snapshots: SkillRunSnapshot[] = [];
  // 项目级 Skill 栈：把每个启用绑定的 Skill 指令拼进 prompt
  const skills = useSkills.getState();
  const bindings = (project.skillBindings ?? []).filter((b) => b.enabled);
  if (bindings.length) {
    const skillChunks: string[] = [];
    for (const b of bindings) {
      const sk = skills.getById(b.skillId);
      if (!sk) continue;
      skillChunks.push(buildSkillSystem(sk, b.values));
      snapshots.push({
        skillId: sk.id,
        name: sk.name,
        version: sk.version,
        instructionFingerprint: sk.instructionFingerprint ?? "",
        values: b.values,
      });
    }
    if (skillChunks.length) prompt = `${prompt}\n\n${skillChunks.join("\n\n")}`;
  }
  // 负向规则
  if (ctxs.length) {
    const neg = compileNegative(ctxs[0]);
    if (neg) prompt = `${prompt}\n\n负向：${neg}`;
  }
  return { prompt, snapshots };
}

/** 解析 segment 当前使用的 recipe：segment.recipeId > 项目默认 > null（走 provider 远程） */
function resolveRecipe(project: DirectorProject, segment: DirectorSegment): DirectorRecipe | undefined {
  const rid = segment.recipeId;
  if (rid) return project.recipes.find((r) => r.id === rid);
  return undefined;
}

/** 标记某 Take 状态 */
function patchTake(projectId: string, segmentId: string, takeId: string, patch: Partial<DirectorTake>): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const scenes = proj.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((seg) =>
      seg.id === segmentId
        ? { ...seg, takes: (seg.takes ?? []).map((t) => (t.id === takeId ? { ...t, ...patch } : t)) }
        : seg,
    ),
  }));
  useDirector.getState().updateProject(projectId, { scenes });
}

/**
 * 执行单个 Take 的图片生成。
 * recipe 为空或 engine=provider 时走远程 imageGen；engine=comfy 走 ComfyUI（后续接通）。
 */
export async function executeImageTake(
  projectId: string,
  segment: DirectorSegment,
  take: DirectorTake,
  project: DirectorProject,
  relayFirstFrame?: string,
): Promise<void> {
  patchTake(projectId, segment.id, take.id, { status: "running", error: undefined });
  try {
    const recipe = resolveRecipe(project, segment);
    const { prompt, snapshots } = compileSegmentPrompt(project, segment, "image-t2i");
    // 参考图槽位：全局槽（保序）+ 片段槽；图片生成全部进 refImages
    const refs = await resolveSlotImages(project, segment);
    // 前置「图1：首帧…」引用说明：批量生成时每段开头可预测地指明参考图与语义的对应
    const refNote = refs ? refsNoteFromSnapshot(refs.snapshot, "image") : "";
    const finalPrompt = refNote ? `${refNote}\n\n${prompt}` : prompt;
    let results: string[];
    let modelLabel: string;
    if (recipe?.engine === "comfy" && recipe.templateId) {
      // ComfyUI 配方：走 runComfyTemplate
      const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
      if (!tpl) throw new Error(`配方「${recipe.name}」的模板不存在`);
      const host = useSettings.getState().settings.comfy.host;
      if (!host) throw new Error("请先配置 ComfyUI 地址");
      const r = await runComfyTemplate(host, tpl, recipe.defaultParams as Record<string, string | number | boolean>, {
        variantId: recipe.variantId,
        upstreamImages: refs?.orderedAll,
      });
      results = r.images;
      modelLabel = `ComfyUI · ${tpl.name}`;
    } else {
      // 远程配方或无配方：走 generateImage
      const card = recipe?.providerModelKey
        ? resolveModelCard("image", recipe.providerModelKey)
        : resolveModelCard("image");
      // 首尾帧接力：上一段尾帧作为首张参考图（保证跨段画面衔接）
      const relayRefs = relayFirstFrame ? [relayFirstFrame, ...(refs?.orderedAll ?? [])] : refs?.orderedAll;
      results = await generateImage(card, { prompt: finalPrompt, aspect: project.aspect, n: 1, refImages: relayRefs });
      modelLabel = card.model;
    }
    if (!results.length) throw new Error("图片生成未返回结果");
    // 落资产库
    const asset = await useAssets.getState().collect({
      src: results[0],
      kind: "image",
      prompt,
      model: modelLabel,
      director: { projectId, segmentId: segment.id, takeId: take.id, role: "generated" },
    });
    if (!asset) throw new Error("资产收录失败");
    // 完整快照写入（方案 §7.9：保存编译后的真实请求提示词 + 配方 + Skill 栈快照）
    patchTake(projectId, segment.id, take.id, {
      status: "done",
      assetId: asset.id,
      promptSnapshot: finalPrompt,
      recipeSnapshot: recipe,
      paramSnapshot: recipe?.defaultParams,
      skillSnapshots: snapshots.length ? snapshots : undefined,
      slotSnapshot: refs?.snapshot,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchTake(projectId, segment.id, take.id, { status: "error", error: msg });
    directorError(`片段 ${segment.summary.slice(0, 12)}`, msg);
  }
}

/**
 * 执行单个 Take 的视频生成。
 */
export async function executeVideoTake(
  projectId: string,
  segment: DirectorSegment,
  take: DirectorTake,
  project: DirectorProject,
  relayFirstFrame?: string,
): Promise<void> {
  patchTake(projectId, segment.id, take.id, { status: "running", error: undefined });
  try {
    const recipe = resolveRecipe(project, segment);
    const { prompt, snapshots } = compileSegmentPrompt(project, segment, "video-t2v");
    // 参考图槽位：首帧/尾帧单例语义 + 其余参考图（保序）
    const refs = await resolveSlotImages(project, segment);
    // 前置「图1：首帧…」引用说明
    const refNote = refs ? refsNoteFromSnapshot(refs.snapshot, "video") : "";
    const finalPrompt = refNote ? `${refNote}\n\n${prompt}` : prompt;
    let videoUrl: string;
    let modelLabel: string;
    if (recipe?.engine === "comfy" && recipe.templateId) {
      // ComfyUI 配方：走 runComfyTemplate（视频分支）
      const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
      if (!tpl) throw new Error(`配方「${recipe.name}」的模板不存在`);
      const host = useSettings.getState().settings.comfy.host;
      if (!host) throw new Error("请先配置 ComfyUI 地址");
      const r = await runComfyTemplate(host, tpl, recipe.defaultParams as Record<string, string | number | boolean>, {
        variantId: recipe.variantId,
        upstreamImages: refs?.orderedAll,
      });
      videoUrl = r.videos[0] ?? "";
      modelLabel = `ComfyUI · ${tpl.name}`;
    } else {
      // 远程配方或无配方：走 generateVideo；时长按配方能力 clamp，不能超上限（方案 §7.6）
      const card = recipe?.providerModelKey
        ? resolveModelCard("video", recipe.providerModelKey)
        : resolveModelCard("video");
      const maxDur = recipe?.capabilitySnapshot?.maxDurationSec;
      const duration = maxDur ? String(Math.min(segment.durationSec, maxDur)) : String(segment.durationSec);
      // 首尾帧接力：本段没显式首帧槽时，用上一段尾帧作为首帧（保证跨段画面衔接）
      const firstFrame = refs?.firstFrame ?? relayFirstFrame;
      videoUrl = await generateVideo(card, {
        prompt: finalPrompt,
        aspect: project.aspect,
        duration,
        image: firstFrame,
        lastFrame: refs?.lastFrame,
        refImages: refs?.refs.length ? refs.refs : undefined,
      });
      modelLabel = card.model;
    }
    if (!videoUrl) throw new Error("视频生成未返回结果");
    // 落资产库
    const asset = await useAssets.getState().collect({
      src: videoUrl,
      kind: "video",
      prompt,
      model: modelLabel,
      director: { projectId, segmentId: segment.id, takeId: take.id, role: "generated" },
    });
    if (!asset) throw new Error("资产收录失败");
    // 完整快照写入（方案 §7.9：编译后的真实请求提示词 + 配方 + Skill 栈快照）
    patchTake(projectId, segment.id, take.id, {
      status: "done",
      assetId: asset.id,
      promptSnapshot: finalPrompt,
      recipeSnapshot: recipe,
      paramSnapshot: recipe?.defaultParams,
      skillSnapshots: snapshots.length ? snapshots : undefined,
      slotSnapshot: refs?.snapshot,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchTake(projectId, segment.id, take.id, { status: "error", error: msg });
    directorError(`片段 ${segment.summary.slice(0, 12)}`, msg);
  }
}

/** 批量操作类型 */
export type BatchOp = "selected" | "missing" | "failed" | "modified";

/** 批量取消信号 */
let batchAbort: AbortController | null = null;
export function cancelBatch(): void {
  batchAbort?.abort();
  // 不置 null：runBatch 循环靠 batchAbort?.signal.aborted 判断，置 null 后 ?. 短路返回 undefined（falsy），取消无效
}

/** 收集需要批量处理的片段（返回 segment + 新建或现有的 pending/error Take） */
export function collectBatchTasks(project: DirectorProject, op: BatchOp, selectedIds?: string[]): Array<{
  segment: DirectorSegment;
  kind: "image" | "video";
}> {
  const tasks: Array<{ segment: DirectorSegment; kind: "image" | "video" }> = [];
  for (const scene of project.scenes) {
    for (const seg of scene.segments) {
      if (op === "selected" && !selectedIds?.includes(seg.id)) continue;
      const takes = seg.takes ?? [];
      const hasDone = takes.some((t) => t.status === "done");
      if (op === "missing" && hasDone) continue;
      if (op === "failed" && !takes.some((t) => t.status === "error")) continue;
      // modified: 提示词/配方相对采用 Take 已变化的片段（promptOverride 改过、或没有采用版本）
      if (op === "modified") {
        const approved = takes.find((t) => t.id === seg.approvedTakeId);
        if (approved && seg.promptOverride && approved.promptSnapshot !== seg.promptOverride) {
          // 提示词改过，需重生成
        } else if (approved) {
          continue; // 采用版本没变，跳过
        }
      }
      tasks.push({ segment: seg, kind: "video" }); // 默认生成视频片段
    }
  }
  return tasks;
}

/**
 * 批量执行：按队列顺序执行多个片段的视频生成（本地串行，避免显存竞争）。
 * 每个 segment 新建一个 Take。
 */
export async function runBatch(
  projectId: string,
  op: BatchOp,
  selectedIds?: string[],
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<{ done: number; failed: number; cancelled: number }> {
  const project = useDirector.getState().getById(projectId);
  if (!project) return { done: 0, failed: 0, cancelled: 0 };
  const tasks = collectBatchTasks(project, op, selectedIds);
  if (!tasks.length) return { done: 0, failed: 0, cancelled: 0 };

  // 先为每个 task 创建 Take 并入项目
  const newTakesBySeg = new Map<string, DirectorTake>();
  for (const t of tasks) {
    const take = createTake(t.segment.id, t.kind, "clip", t.segment.promptOverride ?? t.segment.summary);
    newTakesBySeg.set(t.segment.id, take);
  }
  // 批量写入项目
  const scenes = project.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((seg) => {
      const nt = newTakesBySeg.get(seg.id);
      return nt ? { ...seg, takes: [...(seg.takes ?? []), nt] } : seg;
    }),
  }));
  useDirector.getState().updateProject(projectId, { scenes });

  // 串行执行（本地默认并发 1）
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  const total = tasks.length;
  batchAbort = new AbortController();
  let aborted = false;
  // 首尾帧接力：上一段视频的尾帧，自动作为下一段的首帧（跨段画面衔接）
  let relayFrame: string | undefined;
  for (let i = 0; i < tasks.length; i++) {
    if (batchAbort?.signal.aborted) { aborted = true; break; }
    const t = tasks[i];
    const take = newTakesBySeg.get(t.segment.id)!;
    onProgress?.(i, total, t.segment.summary.slice(0, 20));
    // 重新读项目（每轮可能被更新）
    const curProj = useDirector.getState().getById(projectId);
    if (!curProj) break;
    const curSeg = curProj.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
    if (!curSeg) continue;
    if (t.kind === "video") {
      await executeVideoTake(projectId, curSeg, take, curProj, relayFrame);
    } else {
      await executeImageTake(projectId, curSeg, take, curProj, relayFrame);
    }
    // 检查执行后的状态
    const finalProj = useDirector.getState().getById(projectId);
    const finalTake = finalProj?.scenes.flatMap((s) => s.segments).flatMap((seg) => seg.takes ?? []).find((tk) => tk.id === take.id);
    if (finalTake?.status === "done") {
      done++;
      // 抽本段尾帧作为下一段的接力首帧；抽不到就断接力（不硬塞旧帧造成错接）
      relayFrame = (await takeTailFrame(finalTake)) ?? undefined;
    } else {
      failed++;
      relayFrame = undefined; // 本段失败，接力链断开
    }
  }
  // 取消后：仍未执行的（status 仍为 queued）Take 标 cancelled（P1-6 修复）
  if (aborted) {
    const curProj = useDirector.getState().getById(projectId);
    if (curProj) {
      // 本轮 batch 新建的 take id 集合
      const batchTakeIds = new Set(Array.from(newTakesBySeg.values()).map((tk) => tk.id));
      const scenes = curProj.scenes.map((s) => ({
        ...s,
        segments: s.segments.map((seg) => ({
          ...seg,
          takes: (seg.takes ?? []).map((tk) => {
            // 只处理本轮 batch 创建的、状态仍是 queued 的（未执行）
            if (batchTakeIds.has(tk.id) && tk.status === "queued") {
              cancelled++;
              return { ...tk, status: "cancelled" as const };
            }
            return tk;
          }),
        })),
      }));
      useDirector.getState().updateProject(projectId, { scenes });
    }
  }
  onProgress?.(total, total, "");
  batchAbort = null;
  return { done, failed, cancelled };
}

/**
 * 跨重启恢复：应用启动时调用。把所有 running 的 Take 标「中断」（方案 §7.8）。
 * 不能静默重置为 queued——用户需要知道上次中断了。
 */
export function recoverInterruptedTasks(): number {
  let count = 0;
  const projects = useDirector.getState().projects;
  for (const proj of projects) {
    let dirty = false;
    const scenes = proj.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) => ({
        ...seg,
        takes: (seg.takes ?? []).map((t) => {
          if (t.status === "running") {
            dirty = true;
            count++;
            return { ...t, status: "error" as const, error: "上次运行中断（应用退出/崩溃）" };
          }
          return t;
        }),
      })),
    }));
    if (dirty) useDirector.getState().updateProject(proj.id, { scenes });
  }
  return count;
}

/* ---------------- 后处理派生链（方案 §20.5） ---------------- */

/**
 * 对一个已采用 Take 执行后处理（放大/补帧/修复），产出派生 Take。
 *
 * 流程：
 *  1. 取原始 Take 的资产地址
 *  2. 喂给 ComfyUI 后处理分支（recipe.templateId + variantId）
 *  3. 结果落资产库
 *  4. 创建派生 Take，记录 derivedFrom 链
 *  5. 派生 Take 不自动采用（用户决定是否替换时间线上的原版）
 */
export async function executePostProcess(
  projectId: string,
  segmentId: string,
  sourceTakeId: string,
  recipe: DirectorPostRecipe,
): Promise<DirectorTake | null> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return null;
  const seg = proj.scenes.flatMap((s) => s.segments).find((x) => x.id === segmentId);
  if (!seg) return null;
  const sourceTake = (seg.takes ?? []).find((t) => t.id === sourceTakeId);
  if (!sourceTake?.assetId) {
    directorError("后处理", `原始 Take ${sourceTakeId} 没有资产，无法后处理`);
    return null;
  }
  // 取资产地址
  const asset = useAssets.getState().items.find((a) => a.id === sourceTake.assetId);
  if (!asset) {
    directorError("后处理", `资产 ${sourceTake.assetId} 不在资产库`);
    return null;
  }
  const inputUrl = await assetToDataUrl(asset.path);

  // 创建派生 Take（先标 running）
  const derived = createTake(segmentId, recipe.outputKind, sourceTake.target, sourceTake.promptSnapshot);
  derived.status = "running";
  derived.derivedFrom = { takeId: sourceTakeId, postRecipeId: recipe.id, postRecipeName: recipe.name };
  // 写入项目
  const writeDerived = (take: DirectorTake) => {
    const p = useDirector.getState().getById(projectId);
    if (!p) return;
    const scenes = p.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((x) =>
        x.id === segmentId ? { ...x, takes: [...(x.takes ?? []).filter((t) => t.id !== take.id), take] } : x,
      ),
    }));
    useDirector.getState().updateProject(projectId, { scenes });
  };
  writeDerived(derived);

  try {
    // 调 ComfyUI 后处理分支
    const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
    if (!tpl) throw new Error(`后处理配方「${recipe.name}」的模板 ${recipe.templateId} 不存在`);
    const host = useSettings.getState().settings.comfy.host;
    if (!host) throw new Error("请先在设置里配置 ComfyUI 地址");
    const { images, videos } = await runComfyTemplate(host, tpl, recipe.defaultParams as Record<string, string | number | boolean>, {
      variantId: recipe.variantId,
      upstreamImages: recipe.inputKind === "image" ? [inputUrl] : [],
      upstreamVideos: recipe.inputKind === "video" ? [inputUrl] : [],
    });
    const resultUrl = recipe.outputKind === "image" ? images[0] : videos[0];
    if (!resultUrl) throw new Error(`后处理配方「${recipe.name}」未返回结果`);
    // 落资产
    const newAsset = await useAssets.getState().collect({
      src: resultUrl,
      kind: recipe.outputKind,
      prompt: `${sourceTake.promptSnapshot}（后处理：${recipe.name}）`,
      model: `ComfyUI · ${recipe.name}`,
    });
    derived.status = "done";
    derived.assetId = newAsset?.id;
    derived.note = `由「${sourceTake.note ?? "原始版本"}」经 ${recipe.name} 派生`;
    writeDerived(derived);
    return derived;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    derived.status = "error";
    derived.error = msg;
    writeDerived(derived);
    directorError(`后处理 · ${recipe.name}`, msg);
    return null;
  }
}

/**
 * 批量后处理：把所有采用版本按后处理配方跑一遍。
 * 通常用于「放大所有低于目标分辨率的片段」。
 */
export async function runBatchPostProcess(
  projectId: string,
  recipe: DirectorPostRecipe,
  predicate?: (seg: DirectorSegment, take: DirectorTake) => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; failed: number }> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return { done: 0, failed: 0 };
  // 收集需要后处理的（采用版本 + 满足谓词）
  const tasks: Array<{ segmentId: string; takeId: string }> = [];
  for (const scene of proj.scenes) {
    for (const seg of scene.segments) {
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (!take || take.status !== "done") continue;
      // 排除已经是派生版本的（避免无限派生）
      if (take.derivedFrom) continue;
      if (predicate && !predicate(seg, take)) continue;
      tasks.push({ segmentId: seg.id, takeId: take.id });
    }
  }
  let done = 0;
  let failed = 0;
  for (let i = 0; i < tasks.length; i++) {
    onProgress?.(i, tasks.length);
    const result = await executePostProcess(projectId, tasks[i].segmentId, tasks[i].takeId, recipe);
    if (result?.status === "done") done++;
    else failed++;
  }
  onProgress?.(tasks.length, tasks.length);
  return { done, failed };
}
