/**
 * 导演台·生成页 — 配方配置 + Take 多版本管理
 *
 * 方案 §7.2/§7.5/§7.9：分镜静帧/首尾帧/视频片段的生成与多版本挑片。
 *
 * 本轮实现：
 *  - 配方列表（从项目 recipes 读取，可新增空配方）
 *  - Take 列表（浏览/采用/备注/星标）
 *  - 手动导入结果文件绑定到 Take（实际生成队列在阶段 11 实现）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDirector } from "../../core/stores/directorStore";
import { useComfy } from "../../core/stores/comfyStore";
import { useSettings } from "../../core/stores/settingsStore";
import { useAssets } from "../../core/stores/assetStore";
import { toast } from "../../core/stores/uiStore";
import { approveTake, createTake, projectProgress } from "../../core/directorEngine";
import { runBatch, collectBatchTasks, cancelBatch, type BatchOp } from "../../core/directorQueue";
import { assetUrl } from "../../core/services/assetFiles";
import { RefSlotsCard } from "./RefSlotsCard";
import { uid } from "../../core/utils";
import { IcStar, IcCheck, IcUpload, IcLoading, IcZap, IcFilmFrame, IcWand, IcClapper, IcPlus } from "../../ui/icons";
import type { DirectorProject, DirectorSegment, DirectorTake, DirectorRecipe } from "../../core/types";

/** 配方模式徽章文案 */
const MODE_LABEL: Record<DirectorRecipe["mode"], string> = {
  t2v: "文生视频",
  i2v: "图生视频",
  fl2v: "首尾帧",
  r2v: "多参考",
  v2v: "视频重绘",
  t2i: "文生图",
  i2i: "图生图",
};

export function GenerationPage({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const templates = useComfy((s) => s.templates);
  // 审核看板：片段列表带最新 Take 缩略图（资产库里的封面）
  const assets = useAssets((s) => s.items);
  // 订阅稳定引用 + useMemo 派生：此前 selector 内 map 出新对象数组，useShallow 比较项引用永远失败，
  // getSnapshot 每次调用都返回新引用 → React 判定快照未缓存 → 无限重渲染（Maximum update depth exceeded）
  const providers = useSettings((s) => s.settings.models.providers);
  const videoModels = useMemo(
    () =>
      providers.flatMap((p) =>
        (p.models.video?.models ?? []).map((m) => ({ key: `${p.id}::${m}`, label: `${p.name} · ${m}` })),
      ),
    [providers],
  );
  const allSegs = project.scenes.flatMap((s) => s.segments.map((seg) => ({ seg, scene: s })));
  const [selSegId, setSelSegId] = useState<string | null>(allSegs[0]?.seg.id ?? null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const [batchDone, setBatchDone] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchOp, setBatchOp] = useState<BatchOp>("missing");

  // B2 修复：selSegId 失效（重新拆分后旧 id 找不到）时回落到首个
  useEffect(() => {
    if (selSegId && !allSegs.some((x) => x.seg.id === selSegId)) {
      setSelSegId(allSegs[0]?.seg.id ?? null);
    } else if (!selSegId && allSegs.length) {
      setSelSegId(allSegs[0].seg.id);
    }
  }, [project.scenes]);

  const sel = allSegs.find((x) => x.seg.id === selSegId);

  // 概览统计（只读派生：scenes → segments → takes）
  const progress = projectProgress(project);
  const failedCount = allSegs.reduce((n, x) => n + (x.seg.takes ?? []).filter((t) => t.status === "error").length, 0);

  const addRecipe = () => {
    const recipe: DirectorRecipe = {
      id: uid(6),
      name: "新配方",
      engine: "comfy",
      output: "video",
      mode: "i2v",
      defaultParams: {},
    };
    updateProject(project.id, { recipes: [...project.recipes, recipe] });
  };
  const updateRecipe = (id: string, patch: Partial<DirectorRecipe>) => {
    updateProject(project.id, {
      recipes: project.recipes.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  };
  const removeRecipe = (id: string) => {
    updateProject(project.id, { recipes: project.recipes.filter((r) => r.id !== id) });
  };

  const doBatch = async (op: BatchOp) => {
    const selectedIds = op === "selected" && selSegId ? [selSegId] : undefined;
    const tasks = collectBatchTasks(project, op, selectedIds);
    if (!tasks.length) {
      toast(op === "missing" ? "没有缺失的片段" : op === "failed" ? "没有失败的任务" : op === "modified" ? "没有已修改的片段" : "请先选中要生成的片段", "info");
      return;
    }
    if (!confirm(`即将生成 ${tasks.length} 个视频片段（本地 ComfyUI 串行，不产生 API 费用；若配方使用远程计费接口则按其计费）。确认开始？`)) return;
    setBatchBusy(true);
    setBatchDone(0);
    setBatchTotal(tasks.length);
    try {
      const { done, failed, cancelled } = await runBatch(project.id, op, selectedIds, (d, t, name) => {
        setBatchDone(d + 1);
        setBatchTotal(t);
        setBatchProgress(name ? `(${d + 1}/${t}) ${name}` : "");
      });
      const msg = cancelled
        ? `批量已取消：成功 ${done}，失败 ${failed}，已取消 ${cancelled}`
        : `批量完成：成功 ${done}，失败 ${failed}`;
      toast(msg, failed ? "err" : "ok");
    } catch (e) {
      toast(`批量生成出错：${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBatchBusy(false);
      setBatchProgress("");
    }
  };

  if (!allSegs.length) {
    return (
      <div className="ds-page">
        {/* 没有片段时也可以先配参考图（片段拆分后自动生效） */}
        <RefSlotsCard project={project} />
        <div className="ds-empty">
          <span className="ds-card-ic">
            <IcFilmFrame size={18} />
          </span>
          <div className="ds-empty-title">还没有片段</div>
          <div className="ds-empty-desc">请先到「脚本」页拆分剧本，拆出的片段会出现在这里。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      {/* 概览统计 */}
      <div className="ds-stats">
        <div className="ds-stat">
          <b>{progress.total}</b>
          <span>片段总数</span>
        </div>
        <div className="ds-stat ok">
          <b>{progress.approved}</b>
          <span>已采用</span>
        </div>
        <div className="ds-stat warn">
          <b>{progress.missing}</b>
          <span>缺片</span>
        </div>
        <div className="ds-stat danger">
          <b>{failedCount}</b>
          <span>失败 Take</span>
        </div>
      </div>

      {/* 参考图卡：上游图片的顺序与接入点（方案 §7.7 素材槽） */}
      <RefSlotsCard project={project} />

      {/* 批量生成卡 */}
      <div className="ds-card">
        <div className="ds-card-head">
          <span className="ds-card-ic">
            <IcZap size={16} />
          </span>
          <div>
            <div className="ds-card-title">批量生成</div>
            <div className="ds-card-desc">本地串行生成视频片段，缺片/失败可一键补齐</div>
          </div>
        </div>
        <div className="ds-card-body">
          {batchBusy ? (
            <div className="dsg-batch-busy">
              <div className="dsg-batch-row">
                <span className="ds-card-desc dsg-batch-progress">
                  <IcLoading size={13} /> {batchProgress}
                </span>
                <button className="btn sm danger" onClick={() => { cancelBatch(); }}>
                  取消批量
                </button>
              </div>
              {/* 队列进度条：批量任务的可视化状态 */}
              <div className="progress-bar" title={`队列进度 ${batchDone}/${batchTotal}`}>
                <i style={{ width: `${batchTotal ? Math.round((batchDone / batchTotal) * 100) : 0}%` }} />
              </div>
              <div className="ds-card-desc" style={{ marginTop: 4 }}>
                队列：{batchDone}/{batchTotal} 个片段 · 本地串行生成中
              </div>
            </div>
          ) : (
            <div className="dsg-batch-row">
              <select
                className="input sm nodrag dsg-batch-scope"
                value={batchOp}
                onChange={(e) => setBatchOp(e.target.value as BatchOp)}
              >
                <option value="missing">缺失片段</option>
                <option value="modified">已修改片段</option>
                <option value="failed">失败任务</option>
                <option value="selected">当前选中片段</option>
              </select>
              <button className="btn sm primary" onClick={() => doBatch(batchOp)}>
                <IcZap size={14} /> 开始批量生成
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="dsg-cols">
        {/* 左：片段列表卡 */}
        <div className="ds-card">
          <div className="ds-card-head">
            <span className="ds-card-ic">
              <IcFilmFrame size={16} />
            </span>
            <div>
              <div className="ds-card-title">片段</div>
              <div className="ds-card-desc">共 {allSegs.length} 个片段，点击选择</div>
            </div>
          </div>
          <div className="dsg-seg-list">
            {allSegs.map(({ seg, scene }, i) => {
              const approved = seg.takes?.find((t) => t.id === seg.approvedTakeId && t.status === "done");
              // 看板缩略图：最新完成的 Take 封面（从资产库解析）
              const latestDone = [...(seg.takes ?? [])].reverse().find((t) => t.status === "done" && t.assetId);
              const thumb = latestDone ? assets.find((a) => a.id === latestDone.assetId)?.thumb : undefined;
              return (
                <button
                  key={seg.id}
                  className={`ds-seg-pick ${selSegId === seg.id ? "on" : ""}`}
                  onClick={() => setSelSegId(seg.id)}
                >
                  <span className="ds-seg-pick-n">{i + 1}</span>
                  {thumb ? (
                    <img className="ds-seg-thumb" src={assetUrl(thumb)} alt="" loading="lazy" />
                  ) : (
                    <span className="ds-seg-thumb empty">
                      <IcFilmFrame size={16} />
                    </span>
                  )}
                  <span className="ds-seg-pick-name">{scene.location} · {seg.summary.slice(0, 20)}</span>
                  {approved ? <span className="ds-badge ok">✓</span> : seg.takes?.length ? <span className="ds-badge">{seg.takes.length}</span> : <span className="ds-badge warn">缺</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* 右：Take 卡 + 配方卡 */}
        <div className="ds-side">
          {sel ? (
            <TakeManager project={project} segment={sel.seg} />
          ) : (
            <div className="ds-card">
              <div className="ds-empty">
                <div className="ds-empty-title">选择一个片段</div>
                <div className="ds-empty-desc">从左侧片段列表中选择要管理版本的片段。</div>
              </div>
            </div>
          )}

          {/* 配方卡（默认折叠，点击展开编辑） */}
          <div className="ds-card">
            <div className="ds-card-head">
              <span className="ds-card-ic">
                <IcWand size={16} />
              </span>
              <div>
                <div className="ds-card-title">生成配方</div>
                <div className="ds-card-desc">把「想做什么」与「具体怎么调用」隔离，点击展开编辑</div>
              </div>
              <div className="ds-card-acts">
                <button className="btn sm" onClick={addRecipe}>
                  <IcPlus size={13} /> 新增配方
                </button>
              </div>
            </div>
            <div className="ds-card-body">
              {project.recipes.length ? (
                project.recipes.map((r) => (
                  <details key={r.id} className="ds-recipe">
                    <summary className="ds-recipe-summary">
                      <b>{r.name}</b>
                      <span className="dsg-recipe-badges">
                        <span className="ds-badge">{r.engine === "comfy" ? "本地 ComfyUI" : "远程 API"}</span>
                        <span className="ds-badge">{r.output === "video" ? "视频" : "图片"}</span>
                        <span className="ds-badge">{MODE_LABEL[r.mode]}</span>
                      </span>
                    </summary>
                    <div className="ds-recipe-edit nodrag">
                      <label className="ds-threed-field">
                        名称
                        <input className="input sm" value={r.name} onChange={(e) => updateRecipe(r.id, { name: e.target.value })} />
                      </label>
                      <label className="ds-threed-field">
                        引擎
                        <select className="input sm" value={r.engine} onChange={(e) => updateRecipe(r.id, { engine: e.target.value as "comfy" | "provider" })}>
                          <option value="comfy">本地 ComfyUI</option>
                          <option value="provider">远程 API</option>
                        </select>
                      </label>
                      <label className="ds-threed-field">
                        输出
                        <select className="input sm" value={r.output} onChange={(e) => updateRecipe(r.id, { output: e.target.value as "image" | "video" })}>
                          <option value="image">图片</option>
                          <option value="video">视频</option>
                        </select>
                      </label>
                      <label className="ds-threed-field">
                        模式
                        <select className="input sm" value={r.mode} onChange={(e) => updateRecipe(r.id, { mode: e.target.value as DirectorRecipe["mode"] })}>
                          <option value="t2v">文生视频</option>
                          <option value="i2v">图生视频</option>
                          <option value="fl2v">首尾帧视频</option>
                          <option value="r2v">多参考视频</option>
                          <option value="t2i">文生图</option>
                          <option value="i2i">图生图</option>
                        </select>
                      </label>
                      {r.engine === "comfy" ? (
                        <label className="ds-threed-field">
                          ComfyUI 模板
                          <select className="input sm" value={r.templateId ?? ""} onChange={(e) => updateRecipe(r.id, { templateId: e.target.value || undefined })}>
                            <option value="">（选择模板）</option>
                            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </label>
                      ) : (
                        <label className="ds-threed-field">
                          远程视频模型
                          <select className="input sm" value={r.providerModelKey ?? ""} onChange={(e) => updateRecipe(r.id, { providerModelKey: e.target.value || undefined })}>
                            <option value="">（选择模型）</option>
                            {videoModels.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                          </select>
                        </label>
                      )}
                      <button className="btn sm danger" onClick={() => removeRecipe(r.id)}>删除配方</button>
                    </div>
                  </details>
                ))
              ) : (
                <div className="ds-empty">
                  <div className="ds-empty-title">还没有配方</div>
                  <div className="ds-empty-desc">配方把「用户想做什么」与「具体怎么调用」隔离（方案 §7.5），点右上角「新增配方」创建。</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TakeManager({ project, segment }: { project: DirectorProject; segment: DirectorSegment }) {
  const updateProject = useDirector((s) => s.updateProject);
  const collect = useAssets((s) => s.collect);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const takes = segment.takes ?? [];
  const approved = segment.approvedTakeId;

  const importResult = async (kind: "image" | "video", files: FileList) => {
    setImporting(true);
    try {
      for (const f of Array.from(files)) {
        const dataUrl = await fileToDataUrl(f);
        const take = createTake(segment.id, kind, kind === "image" ? "firstFrame" : "clip", segment.promptOverride ?? "");
        take.status = "done";
        const asset = await collect({ src: dataUrl, kind, prompt: segment.summary, model: "手动导入" });
        if (asset) take.assetId = asset.id;
        // 每轮从 store 重读最新项目（多文件导入时前一轮的 takes 会被覆盖，P1-3 修复）
        const cur = useDirector.getState().getById(project.id);
        if (!cur) break;
        const scenes = cur.scenes.map((s) => ({
          ...s,
          segments: s.segments.map((seg) =>
            seg.id === segment.id ? { ...seg, takes: [...(seg.takes ?? []), take] } : seg,
          ),
        }));
        updateProject(project.id, { scenes });
      }
      toast(`已导入 ${files.length} 个结果到「${segment.summary.slice(0, 16)}」`, "ok");
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setImporting(false);
    }
  };

  const setApproved = (takeId: string) => approveTake(project.id, segment.id, takeId);
  const toggleStar = (takeId: string) => {
    const scenes = project.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) =>
        seg.id === segment.id
          ? { ...seg, takes: (seg.takes ?? []).map((t) => (t.id === takeId ? { ...t, starred: !t.starred } : t)) }
          : seg,
      ),
    }));
    updateProject(project.id, { scenes });
  };
  const removeTake = (takeId: string) => {
    if (!confirm("删除这个版本？（已采用的需先取消采用）")) return;
    const scenes = project.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) =>
        seg.id === segment.id
          ? {
              ...seg,
              takes: (seg.takes ?? []).filter((t) => t.id !== takeId),
              approvedTakeId: seg.approvedTakeId === takeId ? null : seg.approvedTakeId,
            }
          : seg,
      ),
    }));
    updateProject(project.id, { scenes });
  };

  return (
    <div className="ds-card">
      <div className="ds-card-head">
        <span className="ds-card-ic">
          <IcClapper size={16} />
        </span>
        <div>
          <div className="ds-card-title">版本 Takes</div>
          <div className="ds-card-desc">{segment.summary.slice(0, 30)} · {segment.durationSec}s · {takes.length} 个版本</div>
        </div>
      </div>
      <div className="ds-card-body">
        {/* 片段级配方选择（P0-3 修复） */}
        <label className="ds-threed-field nodrag">
          本片段使用的配方
          <select
            className="input sm"
            value={segment.recipeId ?? ""}
            onChange={(e) => {
              const scenes = project.scenes.map((s) => ({
                ...s,
                segments: s.segments.map((seg) => (seg.id === segment.id ? { ...seg, recipeId: e.target.value || undefined } : seg)),
              }));
              useDirector.getState().updateProject(project.id, { scenes });
            }}
          >
            <option value="">（项目默认 / 无配方）</option>
            {project.recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        {takes.length ? (
          <div className="ds-takes">
            {takes.map((t) => (
              <TakeCard key={t.id} take={t} approved={approved === t.id} onApprove={() => setApproved(t.id)} onStar={() => toggleStar(t.id)} onRemove={() => removeTake(t.id)} />
            ))}
          </div>
        ) : (
          <div className="ds-empty">
            <div className="ds-empty-title">还没有版本</div>
            <div className="ds-empty-desc">用上方「批量生成」跑一遍，或手动导入外部生成结果。</div>
          </div>
        )}
      </div>
      <div className="ds-card-foot">
        <input ref={fileRef} type="file" accept="image/*" multiple className="dsg-file" onChange={(e) => e.target.files && importResult("image", e.target.files)} />
        <button className="btn sm" disabled={importing} onClick={() => fileRef.current?.click()}>
          <IcUpload size={14} /> 导入图片结果
        </button>
        <button className="btn sm" disabled={importing} onClick={() => {
          const inp = document.createElement("input");
          inp.type = "file";
          inp.accept = "video/*";
          inp.multiple = true;
          inp.onchange = () => inp.files && importResult("video", inp.files);
          inp.click();
        }}>
          <IcUpload size={14} /> 导入视频结果
        </button>
        <span className="spacer" />
        <span className="ds-card-desc">生成队列后续版本接入，当前可手动导入</span>
      </div>
    </div>
  );
}

function TakeCard({ take, approved, onApprove, onStar, onRemove }: {
  take: DirectorTake;
  approved: boolean;
  onApprove: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`ds-take ${approved ? "approved" : ""}`}>
      <div className="ds-take-head">
        <span className="ds-badge">{take.kind === "video" ? "视频" : "图片"} · {take.target}</span>
        {take.status === "done" ? <span className="ds-badge ok">成功</span> : <span className="ds-badge warn">{take.status}</span>}
        {approved ? <span className="ds-badge ok">✓ 采用</span> : null}
      </div>
      {take.error ? <div className="ds-card-desc dsg-err">{take.error}</div> : null}
      {take.note ? <div className="ds-card-desc">{take.note}</div> : null}
      <div className="ds-take-actions-row">
        <button className={`icon-btn dsg-star ${take.starred ? "on" : ""}`} aria-label="星标" title="星标" onClick={onStar}>
          <IcStar size={14} />
        </button>
        {!approved && take.status === "done" ? (
          <button className="btn sm primary" onClick={onApprove}>
            <IcCheck size={14} /> 采用
          </button>
        ) : null}
        <button className="icon-btn danger" aria-label="删除" title="删除" onClick={onRemove}>✕</button>
      </div>
    </div>
  );
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
