/**
 * 导演台·分镜页（预处理中心）— 场景/片段结构 + 每分镜一张预处理卡片
 *
 * 方案 §6.2：左侧结构树 + 中央分镜卡 + 右侧检查器。
 * 卡片内容：标题/时长/状态、提示词预览（H3 成品优先）、生成配方（FL2VA/REF2VA/远程）、
 * 图/视/音参考槽（SegmentRefEditor）、单段精炼/生成。
 * 顶部批量工具条：批量配方、批量精炼提示词、全部交给生成。
 */
import { useEffect, useRef, useState } from "react";
import { useDirector } from "../../core/stores/directorStore";
import { useComfyTemplates } from "../../core/stores/comfyStore";
import { toast } from "../../core/stores/uiStore";
import {
  parseH3Prompt,
  H3_META_LABELS,
  H3_SECTION_LABELS,
} from "../../core/directorPrompt";
import {
  isH3ReadyPrompt,
  refineSegmentPrompts,
  analyzeSegmentsWithLLM,
  type ComfyTplLike,
} from "../../core/directorEngine";
import { runBatch, cancelBatch, previewSegmentPrompt } from "../../core/directorQueue";
import { isVideoLoaderClass, isAudioLoaderClass } from "../../core/services/comfy";
import { useAssets } from "../../core/stores/assetStore";
import { errMsg, fileToDataUrl, isTauri } from "../../core/utils";
import { RecipeSelect } from "./RecipeSelect";
import { SegmentRefEditor } from "./SegmentRefEditor";
import { PopLayer } from "../../ui/PopSelect";
import { IcChevronD, IcClapper, IcLoading, IcPlay, IcSparkles, IcBrain, IcText, IcFolder } from "../../ui/icons";
import type { DirectorProject, DirectorRecipe, DirectorScene, DirectorSegment } from "../../core/types";

/** 片段是否已有被采用的成片 take（只读统计用） */
const hasApprovedTake = (seg: DirectorSegment) =>
  !!seg.takes?.some((t) => t.id === seg.approvedTakeId && t.status === "done");

/**
 * 配方对视频/音频参考的支持度：
 *  - ComfyUI 配方：按模板工作流里有没有 LoadVideo/LoadAudio 类节点判定（REF2VA 有、FL2VA 没有）
 *  - 远程配方：按能力快照的 referenceVideos/referenceAudio
 */
function recipeAvSupport(
  templates: Array<{ id: string; workflow: unknown }>,
  recipe: DirectorRecipe | undefined,
): { video: boolean; audio: boolean } {
  if (!recipe) return { video: false, audio: false };
  if (recipe.engine === "comfy" && recipe.templateId) {
    const tpl = templates.find((t) => t.id === recipe.templateId);
    if (tpl) {
      const types = Object.values(tpl.workflow as Record<string, { class_type?: string }>).map((n) => n?.class_type ?? "");
      return { video: types.some(isVideoLoaderClass), audio: types.some(isAudioLoaderClass) };
    }
  }
  const cap = recipe.capabilitySnapshot;
  return { video: (cap?.referenceVideos ?? 0) > 0, audio: (cap?.referenceAudio ?? 0) > 0 };
}

export function StoryboardPage({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const templates = useComfyTemplates();
  const [expanded, setExpanded] = useState<Set<string>>(new Set(project.scenes[0] ? [project.scenes[0].id] : []));
  // 批量工具条状态
  const [refineProg, setRefineProg] = useState<{ done: number; total: number } | null>(null);
  const [readProg, setReadProg] = useState<{ done: number; total: number } | null>(null);
  const [genProg, setGenProg] = useState<{ done: number; total: number; name: string } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);
  // B3 修复：拆分后 expanded 里的 id 全失效，检测到全部失效时自动展开首个
  useEffect(() => {
    if (!project.scenes.length) return;
    const valid = [...expanded].some((id) => project.scenes.some((s) => s.id === id));
    if (!valid) setExpanded(new Set([project.scenes[0].id]));
  }, [project.scenes]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const patchSegment = (segmentId: string, patch: Partial<DirectorSegment>) => {
    const scenes = project.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) => (seg.id === segmentId ? { ...seg, ...patch } : seg)),
    }));
    updateProject(project.id, { scenes });
  };

  /** 把项目默认配方刷到全部片段（片段级覆盖；清空选择 = 全部回到默认/远程） */
  const applyRecipeAll = () => {
    const rid = project.defaultRecipeId ?? "";
    const scenes = project.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) => ({ ...seg, recipeId: rid || undefined })),
    }));
    updateProject(project.id, { scenes });
    toast(rid ? "已给全部片段设置配方" : "已清空全部片段配方（走远程默认模型）", "ok");
  };

  /**
   * 智能导入参考图文件夹：一个分段一个子文件夹。
   * 匹配规则：子文件夹名以序号开头（01 / H3-01 / 第1段）→ 按序号对位片段；
   * 没序号的按名称自然排序依次补到剩余片段。子文件夹内图片按文件名自然顺序填入该段「参考图」格
   * （整体替换该段参考图区，首帧/尾帧/视/音区不动）。
   */
  const importRefGroups = async (groups: Map<string, Array<{ name: string; read: () => Promise<string> }>>) => {
    if (!groups.size) {
      toast("没识别到分段子文件夹（结构应为：选中的文件夹里，一个分段一个子文件夹，内放参考图）", "err");
      return;
    }
    setFolderBusy(true);
    try {
      const segs = project.scenes.flatMap((s) => s.segments);
      const nat = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
      const keys = [...groups.keys()].sort(nat);
      // 序号只认「开头序号」：01_xxx / H3-01 / 第1段 / 1 xxx 才作数；
      // 名字中间的数字（如「三岁的画_小宇3岁」的 3）不是片段序号，绝不能拿来对位
      const leadingNum = (k: string): number => {
        const m = k.match(/^\s*(?:H3[-_ ]?|seg(?:ment)?[-_ ]?|第\s*|片段\s*|分镜\s*)?0*(\d{1,3})\s*(?:[_.、\-—)\]】]|$)/i);
        return m ? Number(m[1]) : NaN;
      };
      const claims = new Map<string, number>();
      for (const k of keys) {
        const n = leadingNum(k);
        if (Number.isFinite(n) && n >= 1 && n <= segs.length) claims.set(k, n);
      }
      // 冲突检测：同一序号被多个文件夹认领 = 序号不可信，全部作废改走名称顺序
      const idxCount = new Map<number, number>();
      for (const n of claims.values()) idxCount.set(n, (idxCount.get(n) ?? 0) + 1);
      const conflicted = [...idxCount.entries()].filter(([, c]) => c > 1);
      const assign = new Map<string, string>();
      const used = new Set<string>();
      for (const k of keys) {
        const n = claims.get(k);
        if (n !== undefined && !conflicted.length && idxCount.get(n) === 1) {
          assign.set(k, segs[n - 1].id);
          used.add(segs[n - 1].id);
        }
      }
      const rest = segs.filter((s) => !used.has(s.id));
      for (const k of keys) {
        if (assign.has(k)) continue;
        const seg = rest.shift();
        if (seg) assign.set(k, seg.id);
      }
      // 逐夹收录资产（图片按文件名自然顺序 = 该段参考格顺序）
      const fills = new Map<string, string[]>();
      let total = 0;
      for (const [k, segId] of assign) {
        const list = [...groups.get(k)!].sort((a, b) => nat(a.name, b.name));
        const ids: string[] = [];
        for (const f of list) {
          const dataUrl = await f.read();
          const asset = await useAssets.getState().collect({
            src: dataUrl,
            kind: "image",
            name: f.name.replace(/\.[^.]+$/, ""),
            director: { projectId: project.id, segmentId: segId, role: "reference" },
          });
          if (asset) ids.push(asset.id);
        }
        if (ids.length) {
          fills.set(segId, ids);
          total += ids.length;
        }
      }
      if (!fills.size) {
        toast("没有匹配到任何片段（子文件夹名带序号如 01、H3-01，或子文件夹数量与片段对应）", "err");
        return;
      }
      // 一次写回：只替换各段「参考图」区，其它槽位不动
      const cur = useDirector.getState().getById(project.id) ?? project;
      const scenes = cur.scenes.map((s) => ({
        ...s,
        segments: s.segments.map((g) => {
          const ids = fills.get(g.id);
          if (!ids) return g;
          const slots = (g.slots ?? []).filter((x) => x.semantic !== "referenceImage" && x.assetIds.length > 0);
          return { ...g, slots: [...slots, { semantic: "referenceImage" as const, assetIds: ids, auto: false }] };
        }),
      }));
      updateProject(project.id, { scenes });
      const unmatched = keys.length - assign.size;
      // 映射摘要：让「哪段导了几张」立等可核（错位一眼可见）
      const idxOf = new Map(segs.map((s, i) => [s.id, i + 1]));
      const sample = [...fills.entries()]
        .slice(0, 3)
        .map(([id, ids]) => `片段${idxOf.get(id)}×${ids.length}张`)
        .join("、");
      toast(
        `已导入 ${fills.size} 段参考图（共 ${total} 张：${sample}${fills.size > 3 ? " 等" : ""}）` +
          `${conflicted.length ? "；文件夹序号冲突，已按名称顺序对应" : ""}` +
          `${unmatched > 0 ? `；${unmatched} 个子文件夹未匹配` : ""}`,
        "ok",
      );
    } catch (e) {
      toast(`参考图文件夹导入失败：${errMsg(e)}`, "err");
    } finally {
      setFolderBusy(false);
    }
  };

  /** 浏览器预览退路：webkitdirectory input（Tauri 下不用——WebView2 会弹一个难关的「上传文件夹」二次确认） */
  const importRefFolderInput = async (files: FileList) => {
    const groups = new Map<string, Array<{ name: string; read: () => Promise<string> }>>();
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const parts = rel.split("/");
      if (parts.length < 3) continue; // 根目录散图无法一一对应，忽略
      const key = parts[1];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ name: f.name, read: () => fileToDataUrl(f) });
    }
    await importRefGroups(groups);
  };

  /** 入口：Tauri 用系统原生目录选择器 + fs 直读（一次弹窗、无二次确认）；浏览器预览退回 webkitdirectory */
  const pickRefFolder = async () => {
    if (!isTauri) {
      dirRef.current?.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "选择参考图根目录（一个分段一个子文件夹）" });
      if (!dir || typeof dir !== "string") return;
      const { readDir, readFile } = await import("@tauri-apps/plugin-fs");
      const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };
      const ext = (n: string) => (n.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
      const groups = new Map<string, Array<{ name: string; read: () => Promise<string> }>>();
      const join = (a: string, b: string) => a.replace(/[/]+$/, "") + "/" + b;
      for (const sub of (await readDir(dir)).filter((e) => e.isDirectory)) {
        const subPath = join(dir, sub.name);
        const files = (await readDir(subPath)).filter((e) => !e.isDirectory && MIME[ext(e.name)]);
        if (!files.length) continue;
        groups.set(sub.name, files.map((f) => ({
          name: f.name,
          read: async () => {
            const buf = await readFile(join(subPath, f.name));
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return `data:${MIME[ext(f.name)]};base64,${btoa(bin)}`;
          },
        })));
      }
      await importRefGroups(groups);
    } catch (e) {
      toast(`读取文件夹失败：${errMsg(e)}`, "err");
    }
  };

  /** 批量精炼：项目绑定 Skill 后可用 */
  const hasSkillBound = (project.skillBindings ?? []).some((b) => b.enabled);
  const doRefineAll = async () => {
    setRefineProg({ done: 0, total: segCount });
    try {
      const r = await refineSegmentPrompts(project.id, undefined, (done, total) => setRefineProg({ done, total }));
      if (!r.ok && !r.failed && r.skipped) {
        toast(
          `没有精炼任何片段：${r.skipped} 段均为成品直录（🔒 锁定）——提示词本身已是 H3 成品，无需精炼。如确要重炼，先在片段卡点「🔒 已锁定」解锁`,
          "info",
        );
      } else {
        toast(
          `精炼完成：成功 ${r.ok} 段${r.failed ? `，失败 ${r.failed} 段（详见报错中心）` : ""}${r.skipped ? `，跳过 ${r.skipped} 段（已锁定成品）` : ""}`,
          r.failed ? "info" : "ok",
        );
      }
    } catch (e) {
      toast(`精炼失败：${errMsg(e)}`, "err");
    } finally {
      setRefineProg(null);
    }
  };

  /** AI 精读分段：规则切段产物的片段（无镜头/对白结构）逐段调对话模型提取结构化内容 */
  const doReadAll = async () => {
    setReadProg({ done: 0, total: segCount });
    try {
      const r = await analyzeSegmentsWithLLM(project.id, undefined, (done, total) => setReadProg({ done, total }));
      if (!r.ok && !r.failed) toast(`没有需要精读的片段（${r.skipped} 段已有内容或已锁定）`, "info");
      else toast(`精读完成：成功 ${r.ok} 段${r.failed ? `，失败 ${r.failed} 段` : ""}${r.skipped ? `，跳过 ${r.skipped} 段` : ""}`, r.failed ? "info" : "ok");
    } catch (e) {
      toast(`精读失败：${errMsg(e)}`, "err");
    } finally {
      setReadProg(null);
    }
  };

  /** 全部交给生成：缺失片段按段配方顺序串行跑（本地 ComfyUI 并发 1） */
  const doGenerate = async (op: "missing" | "failed") => {
    setGenProg({ done: 0, total: 0, name: "" });
    try {
      const r = await runBatch(project.id, op, undefined, (d, t, name) => setGenProg({ done: d, total: t, name }));
      if (!r.done && !r.failed && !r.cancelled) toast(op === "missing" ? "没有缺失片段需要生成" : "没有失败任务需要重试", "info");
      else toast(`生成结束：完成 ${r.done}${r.failed ? ` · 失败 ${r.failed}` : ""}${r.cancelled ? ` · 取消 ${r.cancelled}` : ""}`, r.failed ? "info" : "ok");
    } finally {
      setGenProg(null);
    }
  };

  if (!project.scenes.length) {
    return (
      <div className="ds-page">
        <div className="ds-card">
          <div className="ds-empty">
            <span className="ds-card-ic">
              <IcClapper size={20} />
            </span>
            <div className="ds-empty-title">还没有分镜</div>
            <div className="ds-empty-desc">先到「剧本」页粘贴剧本并点击「AI 拆分剧本」，这里会自动生成分镜表。</div>
          </div>
        </div>
      </div>
    );
  }

  // 概览统计（只读，从 project.scenes 派生）
  const segCount = project.scenes.reduce((n, s) => n + s.segments.length, 0);
  const shotCount = project.scenes.reduce((n, s) => n + s.segments.reduce((m, seg) => m + seg.shots.length, 0), 0);
  const approvedCount = project.scenes.reduce((n, s) => n + s.segments.filter(hasApprovedTake).length, 0);

  return (
    <div className="ds-page">
      <div className="ds-stats">
        <div className="ds-stat">
          <b>{project.scenes.length}</b>
          <span>场景</span>
        </div>
        <div className="ds-stat">
          <b>{segCount}</b>
          <span>片段</span>
        </div>
        <div className="ds-stat accent">
          <b>{shotCount}</b>
          <span>镜头</span>
        </div>
        <div className="ds-stat ok">
          <b>{approvedCount}</b>
          <span>已采用片段</span>
        </div>
      </div>

      {/* 批量工具条：配方 / 精炼 / 生成 */}
      <div className="ds-card ds-batchbar">
        <div className="ds-batchbar-row">
          <span className="ds-ref-zone-label">项目默认配方</span>
          <RecipeSelect project={project} target="project" className="ds-batch-recipe" />
          <button className="btn sm" title="把当前默认配方刷到全部片段（片段级覆盖）" onClick={applyRecipeAll} disabled={!!genProg}>
            应用到全部
          </button>
          {!project.recipes.length ? (
            <span className="ds-opt-hint">可直接从「项目默认配方」选 ComfyUI 模板（自动建配方）</span>
          ) : null}
          <input
            ref={dirRef}
            type="file"
            multiple
            style={{ display: "none" }}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => {
              if (e.target.files?.length) void importRefFolderInput(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="btn sm"
            title="智能导入参考图文件夹：一个分段一个子文件夹。子文件夹名以序号开头（01_xxx / H3-01 / 第1段）优先按序号对位，否则按名称排序依次对应片段（名字中间的数字如「3岁」不作序号）；子文件夹内图片按文件名顺序填入该段参考图格"
            disabled={folderBusy || !!genProg || !segCount}
            onClick={() => void pickRefFolder()}
          >
            {folderBusy ? <IcLoading size={13} /> : <IcFolder size={13} />}
            {folderBusy ? " 导入中…" : " 参考图文件夹"}
          </button>
          <span className="spacer" />
          <button
            className="btn sm"
            title="对规则切段产生的片段，用对话模型逐段提取摘要/时长/对白/镜头（已有内容或锁定的段自动跳过）"
            disabled={!!readProg || !!refineProg || !!genProg}
            onClick={() => void doReadAll()}
          >
            {readProg ? <IcLoading size={13} /> : <IcBrain size={13} />}
            {readProg ? ` 精读中 ${readProg.done}/${readProg.total}` : " AI 精读分段"}
          </button>
          <button
            className="btn sm"
            title={hasSkillBound ? "用项目绑定的 Skill 逐段精炼 H3 提示词" : "先到「剧本」页勾选项目级 Skill"}
            disabled={!hasSkillBound || !!refineProg || !!genProg || !!readProg}
            onClick={() => void doRefineAll()}
          >
            {refineProg ? <IcLoading size={13} /> : <IcSparkles size={13} />}
            {refineProg ? ` 精炼中 ${refineProg.done}/${refineProg.total}` : " 批量精炼提示词"}
          </button>
          {genProg ? (
            <button className="btn sm ghost" onClick={cancelBatch}>
              取消生成
            </button>
          ) : null}
          <button className="btn sm primary" disabled={!!genProg} onClick={() => void doGenerate("missing")}>
            {genProg ? <IcLoading size={13} /> : <IcPlay size={13} />}
            {genProg ? ` 生成中 ${genProg.done}/${genProg.total} ${genProg.name}` : " 全部交给生成"}
          </button>
          <button className="btn sm" disabled={!!genProg} onClick={() => void doGenerate("failed")}>
            重试失败
          </button>
          <label
            className="ds-opt"
            title="每段生成结束后调用 ComfyUI /free 卸载模型并释放显存；H3 等大工作流防显存堆积，代价是下一段重新加载模型"
          >
            <input
              type="checkbox"
              className="nodrag"
              checked={!!project.freeMemBetween}
              onChange={(e) => updateProject(project.id, { freeMemBetween: e.target.checked })}
            />
            <span className="ds-opt-hint">每段后清显存</span>
          </label>
          <label
            className="ds-opt"
            title="批量生成连贯性：上一段生成完成后自动抽取其尾帧，作为下一段的首帧/首张参考图（本段显式首帧优先），与本段参考图一起投喂，保证跨段画面衔接；关闭则各段独立生成"
          >
            <input
              type="checkbox"
              className="nodrag"
              checked={!!project.tailFrameRelay}
              onChange={(e) => updateProject(project.id, { tailFrameRelay: e.target.checked })}
            />
            <span className="ds-opt-hint">尾帧接力</span>
          </label>
        </div>
      </div>

      {project.scenes.map((scene) => (
        <SceneCard
          key={scene.id}
          scene={scene}
          expanded={expanded.has(scene.id)}
          onToggle={() => toggle(scene.id)}
          project={project}
          templates={templates}
          onPatchSegment={patchSegment}
        />
      ))}
    </div>
  );
}

function SceneCard({
  scene,
  expanded,
  onToggle,
  project,
  templates,
  onPatchSegment,
}: {
  scene: DirectorScene;
  expanded: boolean;
  onToggle: () => void;
  project: DirectorProject;
  templates: ComfyTplLike[];
  onPatchSegment: (id: string, patch: Partial<DirectorSegment>) => void;
}) {
  const segCount = scene.segments.length;
  const durationSec = scene.segments.reduce((n, s) => n + s.durationSec, 0);
  const approvedCount = scene.segments.filter(hasApprovedTake).length;

  return (
    <div className="ds-card">
      <button
        type="button"
        className={`ds-card-head ds-scene-toggle ${expanded ? "open" : "collapsed"}`}
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? "收起场景" : "展开场景"}
      >
        <span className="ds-card-ic">
          <IcClapper size={16} />
        </span>
        <span className="ds-scene-toggle-main">
          <span className="ds-card-title">{scene.location}</span>
          <span className="ds-card-desc">{segCount} 个片段 · 共 {durationSec}s</span>
        </span>
        <span className="ds-card-acts">
          {segCount > 0 && approvedCount >= segCount ? (
            <span className="ds-badge ok">已完成</span>
          ) : approvedCount > 0 ? (
            <span className="ds-badge">已采用 {approvedCount}/{segCount}</span>
          ) : (
            <span className="ds-badge warn">待制作</span>
          )}
          <IcChevronD size={14} className="ds-chev" />
        </span>
      </button>
      {expanded ? (
        <div className="ds-card-body ds-seggrid">
          {scene.segments.map((seg, i) => (
            <SegmentCard
              key={seg.id}
              segment={seg}
              index={i}
              project={project}
              templates={templates}
              onPatch={onPatchSegment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SegmentCard({
  segment,
  index,
  project,
  templates,
  onPatch,
}: {
  segment: DirectorSegment;
  index: number;
  project: DirectorProject;
  templates: ComfyTplLike[];
  onPatch: (id: string, patch: Partial<DirectorSegment>) => void;
}) {
  const approved = segment.takes?.find((t) => t.id === segment.approvedTakeId && t.status === "done");
  const recipe = project.recipes.find((r) => r.id === segment.recipeId);
  const av = recipeAvSupport(templates, recipe);
  const h3Ready = !!segment.promptOverride && isH3ReadyPrompt(segment.promptOverride);
  const h3 = h3Ready ? parseH3Prompt(segment.promptOverride!) : null;
  const [refining, setRefining] = useState(false);
  const [genning, setGenning] = useState(false);
  const [h3Open, setH3Open] = useState(false);
  const [editRaw, setEditRaw] = useState(false);
  // 最终提示词预览：与生成时实际发送的文本完全同构（参考说明 + 风格 + Skill 栈 + 负向）
  const [pvOpen, setPvOpen] = useState(false);
  const [pvText, setPvText] = useState("");
  const pvBusy = useRef(false);
  const pvAnchor = useRef<HTMLButtonElement>(null);
  const previewFinal = async () => {
    if (pvBusy.current) return;
    pvBusy.current = true;
    try {
      setPvText(await previewSegmentPrompt(project, segment));
      setPvOpen(true);
    } catch (e) {
      toast(`预览失败：${errMsg(e)}`, "err");
    } finally {
      pvBusy.current = false;
    }
  };
  const h3Anchor = useRef<HTMLButtonElement>(null);
  // 生成中状态以 store 里 Take 的真实状态为准（切页回来不丢）；本地 genning 只做点击瞬间的兜底
  const running = (segment.takes ?? []).some((t) => t.status === "running" || t.status === "queued");
  const genBusy = genning || running;

  /** 单段精炼：用项目 Skill 把本段重写成 H3 成品提示词（锁定段=成品直录，不覆盖） */
  const refineOne = async () => {
    if (segment.locked) {
      toast("该片段已锁定（成品直录），不会被精炼覆盖；点片段头的「🔒 已锁定」解锁后可重炼", "info");
      return;
    }
    setRefining(true);
    try {
      const r = await refineSegmentPrompts(project.id, [segment.id]);
      if (r.failed) toast("本段精炼失败，详见报错中心", "err");
      else toast("本段提示词已精炼", "ok");
    } catch (e) {
      toast(`精炼失败：${errMsg(e)}`, "err");
    } finally {
      setRefining(false);
    }
  };

  /** 单段生成：走批量队列（串行），按本段配方执行 */
  const genOne = async () => {
    setGenning(true);
    try {
      await runBatch(project.id, "selected", [segment.id]);
    } finally {
      setGenning(false);
    }
  };

  return (
    <div className={`ds-seg ${approved ? "approved" : ""}`}>
      <div className="ds-seg-head">
        <b>片段 {index + 1}</b>
        <input
          className="input sm nodrag ds-seg-dur"
          type="number"
          min={2}
          max={60}
          title="本片段时长（秒）：生成时自动写入工作流的时长槽位（如 H3 的「时长（秒）」节点）"
          value={segment.durationSec}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            if (!Number.isFinite(v)) return;
            onPatch(segment.id, { durationSec: Math.min(60, Math.max(2, v)) });
          }}
        />
        <span className="ds-card-desc">秒</span>
        {running ? <span className="ds-badge">生成中…</span> : approved ? <span className="ds-badge ok">已采用</span> : segment.takes?.length ? <span className="ds-badge">待选片</span> : <span className="ds-badge warn">缺片</span>}
        {segment.locked ? (
          <button
            className="ds-badge ds-lockbtn"
            title="成品直录锁定：精炼与重新拆分都不会覆盖本段提示词；点击解锁后可重新精炼"
            onClick={() => onPatch(segment.id, { locked: false })}
          >
            🔒 已锁定
          </button>
        ) : null}
        {h3Ready ? <span className="ds-badge ok">H3 提示词</span> : null}
        {segment.promptFinalOverride?.trim() ? (
          <span className="ds-badge warn" title="本段使用手工编辑的最终提示词（在「预览最终提示词」里保存的），风格/Skill/负向的自动拼接已停用">
            最终稿
          </span>
        ) : null}
        <span className="spacer" />
        <RecipeSelect project={project} target="segment" segmentId={segment.id} className="nodrag ds-seg-recipe" />
        {h3 ? (
          <button
            ref={h3Anchor}
            className="icon-btn"
            title="查看 H3 成品提示词（弹窗；点别处自动收起，内可编辑原文）"
            onClick={() => setH3Open((v) => !v)}
          >
            <IcText size={13} />
          </button>
        ) : null}
        <button
          ref={pvAnchor}
          className="btn sm ghost ds-seg-promptbtn nodrag"
          title="分段提示词：与生成时实际发送的文本完全一致（参考素材说明 + 风格锚定 + Skill 指令 + 负向规则），可直接修改并保存为本段最终稿"
          onClick={() => void previewFinal()}
        >
          <IcText size={13} /> 分段提示词
        </button>
        <button
          className="icon-btn"
          title="用项目 Skill 重新精炼本段提示词"
          disabled={refining || genBusy}
          onClick={() => void refineOne()}
        >
          {refining ? <IcLoading size={13} /> : <IcSparkles size={13} />}
        </button>
        <button className="icon-btn" title="立即生成本段" disabled={refining || genBusy} onClick={() => void genOne()}>
          {genBusy ? <IcLoading size={13} /> : <IcPlay size={13} />}
        </button>
        {pvOpen ? (
          <PopLayer anchorRef={pvAnchor} onClose={() => setPvOpen(false)} className="ds-pv-pop">
            <div className="ds-pv-head">
              <b>分段提示词</b>
              {segment.promptFinalOverride?.trim() ? <span className="ds-badge warn">最终稿生效中</span> : null}
              <span className="spacer" />
              {segment.promptFinalOverride?.trim() ? (
                <button
                  className="btn sm ghost"
                  title="清除手工修改的最终稿，恢复自动拼接（覆盖 + 风格锚定 + Skill + 负向）"
                  onClick={() => onPatch(segment.id, { promptFinalOverride: undefined })}
                >
                  恢复自动拼接
                </button>
              ) : null}
              <button
                className="btn sm primary"
                onClick={() => {
                  onPatch(segment.id, { promptFinalOverride: pvText });
                  setPvOpen(false);
                }}
              >
                保存为最终稿
              </button>
            </div>
            <textarea
              className="textarea nodrag nowheel ds-pv-edit"
              rows={16}
              value={pvText}
              onChange={(e) => setPvText(e.target.value)}
            />
          </PopLayer>
        ) : null}
        {h3 && h3Open ? (
          <PopLayer anchorRef={h3Anchor} onClose={() => setH3Open(false)} className="ds-h3-pop">
            <div className="ds-h3-pop-head">
              <b className="ds-h3-code">{h3.code || "H3"}</b>
              <span className="ds-h3-pop-title" title={h3.title}>{h3.title || segment.summary.slice(0, 16)}</span>
              {h3.duration ? <span className="ds-h3-dur">{h3.duration}</span> : null}
              <span className="spacer" />
              <button
                className="btn sm ghost"
                title={editRaw ? "收起原文，回到框格视图" : "编辑提示词原文（H3 格式）"}
                onClick={() => setEditRaw((v) => !v)}
              >
                {editRaw ? "框格视图" : "编辑原文"}
              </button>
            </div>
            {editRaw ? (
              <textarea
                className="input ds-h3-pop-edit"
                rows={14}
                value={segment.promptOverride ?? ""}
                onChange={(e) => onPatch(segment.id, { promptOverride: e.target.value })}
              />
            ) : (
              <div className="ds-h3-pop-body">
                <div className="ds-h3">
                  {h3.meta.length ? (
                    <div className="ds-h3-meta">
                      {h3.meta.map((m) => (
                        <div key={m.label} className="ds-h3-field" title={m.value}>
                          <label>{H3_META_LABELS[m.label] ?? m.label}</label>
                          <div>{m.value || "—"}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {h3.sections.map((s) => (
                    <div key={s.name} className="ds-h3-sec">
                      <label>{H3_SECTION_LABELS[s.name] ?? s.name}</label>
                      <pre>{s.text}</pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </PopLayer>
        ) : null}
      </div>
      <div className="ds-seg-summary">{segment.summary}</div>
      {segment.dialogue.length ? (
        <div className="ds-dialogue">
          {segment.dialogue.map((d, i) => (
            <div key={i} className="ds-dline">{d}</div>
          ))}
        </div>
      ) : null}
      {segment.shots.length ? (
        <div className="ds-shots">
          {segment.shots.map((sh, i) => (
            <div key={sh.id} className="ds-shot">
              <span className="ds-shot-n">镜{i + 1}</span>
              <span className="ds-shot-time">{sh.startSec}-{sh.endSec}s</span>
              <span className="ds-shot-size">{sh.shotSize}</span>
              <span className="ds-shot-cam">{sh.camera}</span>
              <span className="ds-shot-act">{sh.action}</span>
              {sh.audio ? <span className="ds-shot-audio ds-card-desc">🔊 {sh.audio}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {segment.continuityIn ? <div className="ds-cont">承接：{segment.continuityIn}</div> : null}
      {segment.continuityOut ? <div className="ds-cont">结束：{segment.continuityOut}</div> : null}
      {/* 分段提示词按钮已上移片段头（与最终提示词合并为一个弹窗）；H3 段另有结构化弹窗 */}
      {/* 参考槽：固定格子（首帧/尾帧 1 格、参考图 6 格、视频/音频各 2 格），卡片高度一致 */}
      <SegmentRefEditor project={project} segment={segment} allowVideo={av.video} allowAudio={av.audio} />
    </div>
  );
}
