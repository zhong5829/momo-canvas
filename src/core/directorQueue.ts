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
import { generateMinimaxVideo } from "./services/minimaxVideo";
import { runComfyTemplate, analyzeCapsV3, isImageLoaderClass, isVideoLoaderClass, isAudioLoaderClass, freeComfyMemory, pruneNodesWithServants, defaultParamValues } from "./services/comfy";
import { compilePrompt, compileNegative, segmentShotContexts } from "./directorPrompt";
import { buildSkillSystem } from "./skillEngine";
import { directorError, createTake, isH3ReadyPrompt, mpToSize } from "./directorEngine";
import { refsNoteFromSnapshot, resolveSlotMedia, type ResolvedMedia } from "./directorRefs";
import { useSkills } from "./stores/skillStore";
import { assetToDataUrl, assetToBlobUrl, assetUrl } from "./services/assetFiles";
import { grabFrame } from "./videoEdit";
import type { SkillRunSnapshot } from "./skillTypes";
import type { DirectorProject, DirectorSegment, DirectorTake, DirectorPostRecipe, DirectorRecipe, DirectorSlotValue, ComfyTemplate, ComfyWfNode } from "./types";

/** 从一个已完成的 Take 抽出「尾帧」dataURL，作为下一段的接力首帧。视频抽尾帧、图片直接用原图。 */
async function takeTailFrame(take: DirectorTake): Promise<string | null> {
  if (!take.assetId) return null;
  const asset = useAssets.getState().items.find((a) => a.id === take.assetId);
  if (!asset) return null;
  try {
    if (asset.kind === "video") {
      // 视频源优先转 blob URL：WebView2 的 asset:// 协议不支持 Range 请求，直接 seek 抽帧会定位超时
      const src = await assetToBlobUrl(asset.path, asset.mime).catch(() => assetUrl(asset.path));
      const { dataUrl } = await grabFrame(src, "last");
      return dataUrl;
    }
    return await assetToDataUrl(asset.path, asset.mime);
  } catch {
    return null;
  }
}

/** 尾帧接力虚拟槽的占位资产 id（接力帧不落资产库，仅进槽位快照让 refsNote 编号与实际投喂顺序一致） */
const RELAY_ASSET_ID = "__relay_tail_frame__";

/** 模板是否有标题标注「首帧」的图片入口（FL2VA 类，与 withOptionalFrameDrop 同源判定）：
 *  有则接力帧走首帧语义（buildSlotMap 精确映射 + 不被缺首帧降级剔除）；
 *  无（REF2VA 的「Picture N」参考图标题不含首帧字样）则接力帧作第 1 张参考图按序投喂，
 *  refsNote 的「图N」编号即模板实际的 Picture 位，不错位 */
function hasFirstFrameEntry(tpl: ComfyTemplate): boolean {
  return Object.values(tpl.workflow).some(
    (n) => isImageLoaderClass(n.class_type) && /首帧|first/i.test(n._meta?.title ?? ""),
  );
}

/**
 * 尾帧接力注入：把上一段尾帧并入本段参考素材（项目开关开启时 runBatch 才会传入 relay）。
 *  - 首帧语义（namedFirstFrame 且本段无显式首帧）：远程视频走 image 具名参数，ComfyUI 经
 *    buildSlotMap 精确映射到模板首帧槽；具名槽吃掉的帧会被 runComfyTemplate 从顺序队列扣除，不重复投喂
 *  - 其余情况作为第 1 张参考图（队首）：远程图 refImages[0] / REF2VA 类模板的 Picture 1，
 *    与本段原有参考图一起喂给模型
 *  - 槽位快照同步并入带 label 的虚拟槽，refsNote 的「首帧/图N」编号与模型实际收到的顺序严格一致
 *  - 视频目标本段已有显式首帧时用户已指定开头画面，接力帧不抢（显式优先）
 */
function withRelayFrame(
  media: ResolvedMedia | null,
  relay: string | undefined,
  opts: { target: "image" | "video"; namedFirstFrame: boolean },
): ResolvedMedia | null {
  if (!relay) return media;
  if (opts.target === "video" && media?.images.firstFrame) return media;
  const asFirst = !media?.images.firstFrame && opts.namedFirstFrame;
  const slot: DirectorSlotValue = {
    semantic: asFirst ? "firstFrame" : "referenceImage",
    assetIds: [RELAY_ASSET_ID],
    auto: true,
    label: "上一段尾帧（自动接力）",
  };
  const images = {
    orderedAll: [relay, ...(media?.images.orderedAll ?? [])],
    refs: asFirst ? (media?.images.refs ?? []) : [relay, ...(media?.images.refs ?? [])],
    firstFrame: asFirst ? relay : media?.images.firstFrame,
    lastFrame: media?.images.lastFrame,
    snapshot: [slot, ...(media?.images.snapshot ?? [])],
  };
  return { images, videos: media?.videos ?? [], audios: media?.audios ?? [], snapshot: [slot, ...(media?.snapshot ?? [])] };
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
  // 最终提示词覆盖：用户在「预览最终提示词」弹窗里改定的整段最终文本，原样发送
  // （风格/Skill/负向都已在文本里，不再自动拼接；参考素材编号说明由执行层按当前素材槽前置）
  if (segment.promptFinalOverride?.trim()) return { prompt: segment.promptFinalOverride, snapshots: [] };
  const ctxs = segmentShotContexts(project, segment);
  let prompt = segment.promptOverride ?? (ctxs.length ? compilePrompt(ctxs[0], target) : segment.summary);
  // 全局风格锚定：编译路径的 compilePrompt 已消费 ruleSet.positive.style；promptOverride（H3 成品/直录）路径这里补拼
  const gStyle = project.ruleSet?.positive.style?.trim();
  if (segment.promptOverride && gStyle) prompt = `${gStyle}\n\n${prompt}`;
  const snapshots: SkillRunSnapshot[] = [];
  // 项目级 Skill 栈：把每个启用绑定的 Skill 指令拼进 prompt
  // 段提示词已是 H3 成品（Skill 精炼/成品直录产物）时跳过拼接，避免指令重复与超长
  const h3Ready = !!segment.promptOverride && isH3ReadyPrompt(segment.promptOverride);
  const skills = useSkills.getState();
  const bindings = (project.skillBindings ?? []).filter((b) => b.enabled);
  if (bindings.length && !h3Ready) {
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

/**
 * 预览某片段的最终生成提示词：与批量生成实际发送的文本完全同构
 * （参考素材编号说明 + 风格锚定 + Skill 栈指令 + 负向规则），供分镜卡在生成前核对。
 */
export async function previewSegmentPrompt(project: DirectorProject, segment: DirectorSegment): Promise<string> {
  const { prompt } = compileSegmentPrompt(project, segment, "video-t2v");
  const media = await resolveSlotMedia(project, segment);
  const note = media ? refsNoteFromSnapshot(media.snapshot, "video") : "";
  return note ? `${note}\n\n${prompt}` : prompt;
}

/** 解析 segment 当前使用的 recipe：segment.recipeId > 项目默认 defaultRecipeId > null（走 provider 远程） */
function resolveRecipe(project: DirectorProject, segment: DirectorSegment): DirectorRecipe | undefined {
  const rid = segment.recipeId ?? project.defaultRecipeId;
  if (rid) return project.recipes.find((r) => r.id === rid);
  return undefined;
}

/**
 * 按语义把首帧/尾帧精确映射到模板图片入口（FL2VA 的 first_frame/last_frame）。
 * 无首尾帧素材时返回空表——全部图片走默认顺序分配（REF2VA 的 LoadImage 节点 id 序 = Picture 1..4 槽序，天然一一对应）。
 */
function buildSlotMap(tpl: ComfyTemplate, media: ResolvedMedia): Record<string, string> | undefined {
  if (!media.images.firstFrame && !media.images.lastFrame) return undefined;
  const caps = analyzeCapsV3(tpl.workflow);
  const map: Record<string, string> = {};
  for (const slot of caps.autoSlots ?? []) {
    if (slot.media !== "image") continue;
    const key = `${slot.nodeId}.${slot.input}`;
    if (slot.semantic === "firstFrame" && media.images.firstFrame) map[key] = media.images.firstFrame;
    else if (slot.semantic === "lastFrame" && media.images.lastFrame) map[key] = media.images.lastFrame;
  }
  return Object.keys(map).length ? map : undefined;
}

/**
 * 首尾帧工作流的按需降级（FL2VA）：本段没有首帧/尾帧素材时，把标题明确标注「首帧/尾帧」的
 * LoadImage 节点临时忽略——pruneDisabled 会删掉 H3 节点的 first_frame/last_frame 可选输入，
 * 退化为文生视频/仅首帧模式，避免 LoadImage 占位图（1.png）不存在导致执行报错。
 * 判定只看节点标题（REF2VA 的「Picture N」参考图标题不含首尾帧字样，不会被误剔）。
 */
function withOptionalFrameDrop(tpl: ComfyTemplate, media: ResolvedMedia): ComfyTemplate {
  const drop: string[] = [];
  for (const [nid, node] of Object.entries(tpl.workflow)) {
    if (!isImageLoaderClass(node.class_type)) continue;
    const title = node._meta?.title ?? "";
    if (/首帧|first/i.test(title) && !media.images.firstFrame) drop.push(nid);
    else if (/尾帧|末帧|last|end/i.test(title) && !media.images.lastFrame) drop.push(nid);
  }
  if (!drop.length) return tpl;
  return { ...tpl, disabledNodes: [...(tpl.disabledNodes ?? []), ...drop] };
}

/**
 * 无视频/音频参考时的显存瘦身（REF2VA 多参考工作流）：
 * 模板内置的默认 LoadVideo/LoadAudio 参考文件，即使本段没接任何视/音参考也会被解码并参与计算，
 * 会把 32GB 级显存顶爆（GPU 陷入换页空转：100% 利用率但功耗极低，实测 15s 片从 ~600s 拖到 40min+）。
 * 做法＝「连坐旁路」：本段没接的媒体类型的加载节点，连同只服务于它们的下游节点
 * （如 GetVideoComponents 拆分器）整条剔除出提交工作流，消费端的可选参考链接一并摘除。
 */
function withUnrefedMediaDrop(tpl: ComfyTemplate, media: ResolvedMedia): ComfyTemplate {
  const dropVideo = !media.videos.length;
  const dropAudio = !media.audios.length;
  if (!dropVideo && !dropAudio) return tpl;
  const wf: Record<string, ComfyWfNode> = JSON.parse(JSON.stringify(tpl.workflow));
  const marked = new Set<string>();
  for (const [id, n] of Object.entries(wf)) {
    if ((dropVideo && isVideoLoaderClass(n.class_type)) || (dropAudio && isAudioLoaderClass(n.class_type))) marked.add(id);
  }
  if (!marked.size) return tpl;
  return { ...tpl, workflow: pruneNodesWithServants(wf, marked) };
}

/** 标记某 Take 状态 */
function patchTake(projectId: string, segmentId: string, takeId: string, patch: Partial<DirectorTake>): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  // 进入终态（完成/失败/取消）时记录结束时间：版本卡的「生成耗时」= finishedAt - createdAt
  const withEnd =
    patch.status && patch.status !== "queued" && patch.status !== "running" && patch.finishedAt === undefined
      ? { finishedAt: Date.now() }
      : {};
  const scenes = proj.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((seg) =>
      seg.id === segmentId
        ? { ...seg, takes: (seg.takes ?? []).map((t) => (t.id === takeId ? { ...t, ...patch, ...withEnd } : t)) }
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
  onSub?: (msg: string, pct?: number) => void,
): Promise<void> {
  patchTake(projectId, segment.id, take.id, { status: "running", error: undefined, startedAt: Date.now() });
  try {
    const recipe = resolveRecipe(project, segment);
    const { prompt, snapshots } = compileSegmentPrompt(project, segment, "image-t2i");
    // 参考素材槽位：全局槽（保序）+ 片段槽；图/视/音三类按语义分流（图片生成通常只用图）
    const mediaRaw = await resolveSlotMedia(project, segment);
    // ComfyUI 配方先取模板：接力注入需要知道模板有没有具名首帧入口
    const useComfyEngine = recipe?.engine === "comfy" && !!recipe.templateId;
    const comfyTpl = useComfyEngine
      ? useComfy.getState().templates.find((t) => t.id === recipe!.templateId)
      : undefined;
    if (useComfyEngine && !comfyTpl) throw new Error(`配方「${recipe!.name}」的模板不存在`);
    // 尾帧接力：上一段尾帧并入参考素材（远程作首张参考图；ComfyUI 有「首帧」入口走首帧映射，否则 Picture 1）
    const media = withRelayFrame(mediaRaw, relayFirstFrame, {
      target: "image",
      namedFirstFrame: comfyTpl ? hasFirstFrameEntry(comfyTpl) : false,
    });
    // 前置引用说明：图N / 视频N / 音频N 编号与模型实际收到的素材顺序严格一致
    const refNote = media ? refsNoteFromSnapshot(media.snapshot, "image") : "";
    const finalPrompt = refNote ? `${refNote}\n\n${prompt}` : prompt;
    let results: string[];
    let modelLabel: string;
    if (comfyTpl) {
      // ComfyUI 配方：走 runComfyTemplate
      // 首尾帧模板按需降级：缺首帧/尾帧素材时忽略对应 LoadImage，退化为 T2V/I2V（接力帧顶上的 firstFrame 不算缺）
      const tpl = media ? withUnrefedMediaDrop(withOptionalFrameDrop(comfyTpl, media), media) : comfyTpl;
      const host = useSettings.getState().settings.comfy.host;
      if (!host) throw new Error("请先配置 ComfyUI 地址");
      const r = await runComfyTemplate(host, tpl, recipe!.defaultParams as Record<string, string | number | boolean>, {
        variantId: recipe!.variantId,
        onProgress: onSub,
        upstreamImages: media?.images.orderedAll,
        upstreamVideos: media?.videos.length ? media.videos : undefined,
        upstreamAudios: media?.audios.length ? media.audios : undefined,
        upstreamTexts: [finalPrompt],
        imageSlotMap: media ? buildSlotMap(tpl, media) : undefined,
      });
      results = r.images;
      modelLabel = `ComfyUI · ${tpl.name}`;
    } else {
      // 远程配方或无配方：走 generateImage（接力帧已在 orderedAll 队首，与本段参考图一起投喂）
      onSub?.("已提交远程生成任务…");
      const card = recipe?.providerModelKey
        ? resolveModelCard("image", recipe.providerModelKey)
        : resolveModelCard("image");
      results = await generateImage(card, { prompt: finalPrompt, aspect: project.aspect, n: 1, refImages: media?.images.orderedAll });
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
      slotSnapshot: media?.snapshot,
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
type H3Mode = "auto" | "t2va" | "i2va" | "fl2va" | "l2va" | "ref2va";
/** MiniMax H3 支持的画幅（9 种），越界回落 16:9 */
const H3_ASPECTS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "4:5", "5:4"]);

/** 按素材自动推断 H3 生模式：首尾帧→fl2va / 仅首帧→i2va / 仅尾帧→l2va / 参考图或音频→ref2va / 无→t2va */
function inferH3Mode(media: ResolvedMedia | null | undefined): Exclude<H3Mode, "auto"> {
  const first = media?.images.firstFrame;
  const last = media?.images.lastFrame;
  const refs = media?.images.refs?.length ?? 0;
  const auds = media?.audios?.length ?? 0;
  if (last && !first) return "l2va";
  if (first && last) return "fl2va";
  if (first) return "i2va";
  if (refs > 0 || auds > 0) return "ref2va";
  return "t2va";
}

/** 显式选中的 H3 模式缺对应素材时报错（用户已显式选择，不静默回退） */
function ensureH3Media(mode: Exclude<H3Mode, "auto">, media: ResolvedMedia | null | undefined): void {
  if (mode === "t2va") return;
  if (mode === "i2va" && !media?.images.firstFrame)
    throw new Error("MiniMax H3「首帧」模式需要本段有首帧素材（上游图 或 上一段尾帧接力）");
  if (mode === "l2va" && !media?.images.lastFrame)
    throw new Error("MiniMax H3「尾帧」模式需要本段有尾帧素材");
  if (mode === "fl2va") {
    if (!media?.images.firstFrame) throw new Error("MiniMax H3「首尾帧」模式需要本段有首帧素材");
    if (!media?.images.lastFrame) throw new Error("MiniMax H3「首尾帧」模式需要本段有尾帧素材");
  }
  if (mode === "ref2va" && !((media?.images.refs?.length ?? 0) > 0 || (media?.audios?.length ?? 0) > 0))
    throw new Error("MiniMax H3「多参考」模式至少需要一张参考图或一个音频");
}

/** 按 mode 从槽位素材打包 images（fl2va=首帧+尾帧 / i2va=首帧 / l2va=尾帧 / ref2va=参考图≤9） */
function packH3Images(media: ResolvedMedia | null | undefined, mode: Exclude<H3Mode, "auto">): string[] {
  switch (mode) {
    case "fl2va":
      return [media?.images.firstFrame, media?.images.lastFrame].filter(Boolean) as string[];
    case "i2va":
      return media?.images.firstFrame ? [media.images.firstFrame] : [];
    case "l2va":
      return media?.images.lastFrame ? [media.images.lastFrame] : [];
    case "ref2va":
      return media?.images.refs?.slice(0, 9) ?? [];
    default:
      return [];
  }
}

export async function executeVideoTake(
  projectId: string,
  segment: DirectorSegment,
  take: DirectorTake,
  project: DirectorProject,
  relayFirstFrame?: string,
  onSub?: (msg: string, pct?: number) => void,
): Promise<void> {
  patchTake(projectId, segment.id, take.id, { status: "running", error: undefined, startedAt: Date.now() });
  try {
    const recipe = resolveRecipe(project, segment);
    const { prompt, snapshots } = compileSegmentPrompt(project, segment, "video-t2v");
    // 参考素材槽位：首帧/尾帧单例语义 + 其余参考图（保序）+ 视频/音频参考（REF2VA 等多模态工作流）
    const mediaRaw = await resolveSlotMedia(project, segment);
    // ComfyUI 配方先取模板：接力注入需要知道模板有没有具名首帧入口
    const useComfyEngine = recipe?.engine === "comfy" && !!recipe.templateId;
    const comfyTpl = useComfyEngine
      ? useComfy.getState().templates.find((t) => t.id === recipe!.templateId)
      : undefined;
    if (useComfyEngine && !comfyTpl) throw new Error(`配方「${recipe!.name}」的模板不存在`);
    // 尾帧接力：本段无显式首帧时上一段尾帧顶上（远程走 image 具名参数；ComfyUI 有「首帧」入口走精确映射，
    // REF2VA 类无首帧入口的模板作 Picture 1 参考图与本段参考图一起投喂）；本段有显式首帧则显式优先、不注入
    const media = withRelayFrame(mediaRaw, relayFirstFrame, {
      target: "video",
      namedFirstFrame: comfyTpl ? hasFirstFrameEntry(comfyTpl) : true,
    });
    // 前置引用说明：图N / 视频N / 音频N 编号与模型实际收到的素材顺序严格一致
    const refNote = media ? refsNoteFromSnapshot(media.snapshot, "video") : "";
    const finalPrompt = refNote ? `${refNote}\n\n${prompt}` : prompt;
    let videoUrl: string;
    let modelLabel: string;
    let h3Info: Record<string, unknown> | undefined;
    if (comfyTpl) {
      // ComfyUI 配方：走 runComfyTemplate（视频分支；提示词 + 图/视/音参考全部透传模板）
      // 首尾帧模板按需降级：缺首帧/尾帧素材时忽略对应 LoadImage，退化为 T2V/I2V（接力帧顶上的 firstFrame 不算缺）
      const tpl = media ? withUnrefedMediaDrop(withOptionalFrameDrop(comfyTpl, media), media) : comfyTpl;
      const host = useSettings.getState().settings.comfy.host;
      if (!host) throw new Error("请先配置 ComfyUI 地址");
      const r = await runComfyTemplate(host, tpl, recipe!.defaultParams as Record<string, string | number | boolean>, {
        variantId: recipe!.variantId,
        onProgress: onSub,
        upstreamImages: media?.images.orderedAll,
        upstreamVideos: media?.videos.length ? media.videos : undefined,
        upstreamAudios: media?.audios.length ? media.audios : undefined,
        upstreamTexts: [finalPrompt],
        imageSlotMap: media ? buildSlotMap(tpl, media) : undefined,
        // 画幅与像素（顶栏设置）→ 模板分辨率参数（百万像素 / 宽高 / 比例，各有则各写）
        resolution: (() => {
          const size = mpToSize(project.aspect, project.resolutionMP ?? 1);
          return { aspect: project.aspect, mp: project.resolutionMP ?? 1, width: size.width, height: size.height };
        })(),
        // 片段时长写入模板的时长槽位（如 H3 的「时长（秒）」→ 自动对齐帧数节点换算）；配方有能力上限则 clamp
        durationSec: recipe?.capabilitySnapshot?.maxDurationSec
          ? Math.min(segment.durationSec, recipe.capabilitySnapshot.maxDurationSec)
          : segment.durationSec,
      });
      videoUrl = r.videos[0] ?? "";
      modelLabel = `ComfyUI · ${tpl.name}`;
    } else {
      // 远程配方或无配方：走 generateVideo / MiniMax H3 API；时长按配方能力 clamp，不能超上限（方案 §7.6）
      onSub?.("已提交远程生成任务…");
      const card = recipe?.providerModelKey
        ? resolveModelCard("video", recipe.providerModelKey)
        : resolveModelCard("video");
      const maxDur = recipe?.capabilitySnapshot?.maxDurationSec;
      const duration = maxDur ? String(Math.min(segment.durationSec, maxDur)) : String(segment.durationSec);
      if (/minimax[-_]?h3/i.test(card.model)) {
        // MiniMax H3 API：模式按 project.h3Mode（显式）或素材自动推断；缺素材/超时长直接报错
        const dur = segment.durationSec;
        if (dur < 5 || dur > 15 || !Number.isInteger(dur))
          throw new Error(`片段时长 ${dur}s 超出 MiniMax H3 支持的 5–15 秒（整数），请先调整片段时长`);
        const mode =
          (project.h3Mode ?? "auto") === "auto" ? inferH3Mode(media) : (project.h3Mode as Exclude<H3Mode, "auto">);
        ensureH3Media(mode, media);
        videoUrl = await generateMinimaxVideo(card, {
          prompt: finalPrompt,
          mode,
          resolution: (project.resolutionMP ?? 1) <= 0.5 ? "480p" : "720p",
          seconds: String(dur),
          aspect: H3_ASPECTS.has(project.aspect) ? project.aspect : "16:9",
          promptOptimization: false,
          images: packH3Images(media, mode),
          audios: mode === "ref2va" ? media?.audios?.slice(0, 3) ?? [] : [],
          onProgress: onSub,
        });
        modelLabel = card.model;
        h3Info = { h3Mode: mode, h3Seconds: String(dur) };
      } else {
        // 首帧 = 本段显式首帧 ?? 上一段尾帧（显式优先已在接力注入时处理）
        videoUrl = await generateVideo(card, {
          prompt: finalPrompt,
          aspect: project.aspect,
          duration,
          image: media?.images.firstFrame,
          lastFrame: media?.images.lastFrame,
          refImages: media?.images.refs.length ? media.images.refs : undefined,
        });
        modelLabel = card.model;
      }
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
      paramSnapshot: h3Info ? { ...(recipe?.defaultParams ?? {}), ...h3Info } : recipe?.defaultParams,
      skillSnapshots: snapshots.length ? snapshots : undefined,
      slotSnapshot: media?.snapshot,
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
  onProgress?: (done: number, total: number, current: string, detail?: { msg?: string; pct?: number }) => void,
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
  // 尾帧接力（项目开关 tailFrameRelay）：上一段生成完成后抽尾帧，作为下一段的首帧/首张参考图（跨段画面衔接）；关闭则各段独立生成
  const relayOn = !!project.tailFrameRelay;
  let relayFrame: string | undefined;
  for (let i = 0; i < tasks.length; i++) {
    if (batchAbort?.signal.aborted) { aborted = true; break; }
    const t = tasks[i];
    const take = newTakesBySeg.get(t.segment.id)!;
    onProgress?.(i, total, t.segment.summary.slice(0, 20));
    // 细粒度进度（ComfyUI 节点/步数百分比、上传/参数写入各阶段）续在段级进度上
    const sub = (msg: string, pct?: number) => onProgress?.(i, total, t.segment.summary.slice(0, 20), { msg, pct });
    // 重新读项目（每轮可能被更新）
    const curProj = useDirector.getState().getById(projectId);
    if (!curProj) break;
    const curSeg = curProj.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
    if (!curSeg) continue;
    if (t.kind === "video") {
      await executeVideoTake(projectId, curSeg, take, curProj, relayFrame, sub);
    } else {
      await executeImageTake(projectId, curSeg, take, curProj, relayFrame, sub);
    }
    // 检查执行后的状态
    const finalProj = useDirector.getState().getById(projectId);
    const finalTake = finalProj?.scenes.flatMap((s) => s.segments).flatMap((seg) => seg.takes ?? []).find((tk) => tk.id === take.id);
    if (finalTake?.status === "done") {
      done++;
      // 抽本段尾帧接力下一段（最后一段无人消费、不抽）；抽不到就断接力（不硬塞旧帧造成错接）
      if (relayOn && i < tasks.length - 1) {
        onProgress?.(i + 1, total, "抽取尾帧…");
        relayFrame = (await takeTailFrame(finalTake)) ?? undefined;
      } else {
        relayFrame = undefined;
      }
    } else {
      failed++;
      relayFrame = undefined; // 本段失败，接力链断开
    }
    // 每段结束后按项目开关清理 ComfyUI 显存（无论成败；失败不阻断队列，下一段会重新加载模型）
    if (curProj.freeMemBetween) {
      const host = useSettings.getState().settings.comfy.host;
      if (host) {
        onProgress?.(i + 1, total, "清理显存…");
        const r = await freeComfyMemory(host);
        if (!r.ok) console.warn("[导演台] 清理显存失败：", r.err);
      }
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
    // 与批量生成同一开关：每段后处理结束也清理显存
    if (proj.freeMemBetween) {
      const host = useSettings.getState().settings.comfy.host;
      if (host) await freeComfyMemory(host);
    }
  }
  onProgress?.(tasks.length, tasks.length);
  return { done, failed };
}

/**
 * 批量高清放大（成片检查通过后）：把每个片段的采用版本视频逐条送入指定 ComfyUI 放大模板，
 * 成功后派生新版本并自动切换采用——成片预览/成片检查/片段卡即刻显示高清版（原版本保留在版本列表可回退）。
 * 模板必须带视频入口（LoadVideo 类节点）；图片版放大模板会在这里被明确拦下。
 */
export async function runBatchUpscale(
  projectId: string,
  templateId: string,
  onProgress?: (done: number, total: number, name: string) => void,
  paramOverride?: Record<string, string | number | boolean>,
): Promise<{ done: number; failed: number }> {
  const tpl = useComfy.getState().templates.find((t) => t.id === templateId);
  if (!tpl) throw new Error("放大模板不存在，请先在「设置 → ComfyUI 模板」导入");
  const hasVideoEntry = Object.values(tpl.workflow).some((n) => isVideoLoaderClass(n.class_type));
  if (!hasVideoEntry) {
    throw new Error(
      `模板「${tpl.name}」没有视频入口（LoadVideo 类节点），吃不了视频——请导入带 LoadVideo 的视频放大工作流（图片版放大模板不行）`,
    );
  }
  const recipe: DirectorPostRecipe = {
    id: `upscale_${tpl.id}`,
    name: `${tpl.name} · 高清放大`,
    kind: "upscale-video",
    templateId: tpl.id,
    variantId: "default",
    inputKind: "video",
    outputKind: "video",
    defaultParams: { ...defaultParamValues(tpl.params), ...(paramOverride ?? {}) },
  };
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return { done: 0, failed: 0 };
  const tasks: Array<{ segmentId: string; takeId: string; name: string }> = [];
  for (const scene of proj.scenes) {
    for (const seg of scene.segments) {
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (!take || take.status !== "done" || take.kind !== "video" || !take.assetId) continue;
      if (take.derivedFrom?.postRecipeId === recipe.id) continue; // 已是本模板的放大版，跳过防循环
      tasks.push({ segmentId: seg.id, takeId: take.id, name: seg.summary.slice(0, 12) });
    }
  }
  if (!tasks.length) return { done: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    onProgress?.(i, tasks.length, t.name);
    const derived = await executePostProcess(projectId, t.segmentId, t.takeId, recipe);
    if (derived?.status === "done" && derived.assetId) {
      done++;
      // 替换：采用版本切到高清派生版（成片预览/成片检查/片段卡即刻生效；原版本保留可回退）
      const cur = useDirector.getState().getById(projectId);
      if (cur) {
        const scenes = cur.scenes.map((s) => ({
          ...s,
          segments: s.segments.map((x) => (x.id === t.segmentId ? { ...x, approvedTakeId: derived.id } : x)),
        }));
        useDirector.getState().updateProject(projectId, { scenes });
      }
    } else {
      failed++;
    }
  }
  onProgress?.(tasks.length, tasks.length, "");
  return { done, failed };
}
