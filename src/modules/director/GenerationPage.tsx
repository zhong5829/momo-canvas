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
import { useEffect, useRef, useState } from "react";
import { useDirector } from "../../core/stores/directorStore";
import { useAssets } from "../../core/stores/assetStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { approveTake, createTake, projectProgress } from "../../core/directorEngine";
import { runBatch, collectBatchTasks, cancelBatch, stopBatchHard, type BatchOp } from "../../core/directorQueue";
import { assetUrl, assetToBlobUrl } from "../../core/services/assetFiles";
import { extractAudioWav } from "../../core/videoEdit";
import { RecipeSelect } from "./RecipeSelect";
import { BatchSwitches } from "./BatchSwitches";
import { AskCard } from "./AskCard";
import { PopSelect, PopLayer } from "../../ui/PopSelect";
import { Thumb } from "../../ui/Thumb";
import { ScrubVideoThumb, fmtDur } from "../../ui/VideoThumb";
import { IcStar, IcCheck, IcUpload, IcLoading, IcZap, IcFilmFrame, IcClapper, IcRefresh, IcClose, IcMic, IcTimer, IcStop } from "../../ui/icons";
import type { DirectorProject, DirectorSegment, DirectorTake } from "../../core/types";

export function GenerationPage({ project }: { project: DirectorProject }) {
  // 审核看板：片段列表带最新 Take 缩略图（资产库里的封面）
  const assets = useAssets((s) => s.items);
  const allSegs = project.scenes.flatMap((s) => s.segments.map((seg) => ({ seg, scene: s })));
  const [selSegId, setSelSegId] = useState<string | null>(allSegs[0]?.seg.id ?? null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const [batchDone, setBatchDone] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  // 当前片段细粒度进度：ComfyUI 报节点/步数百分比（pct），远程任务为流动动画（pct 无值）
  const [batchPct, setBatchPct] = useState<number | undefined>();
  const [batchMsg, setBatchMsg] = useState("");
  const [batchOp, setBatchOp] = useState<BatchOp>("missing");
  // 「停止」按钮防连点
  const [stopping, setStopping] = useState(false);
  // 片段多选勾选：批量范围「勾选的片段」一起重新生成（无勾选时退回当前点选片段）
  const [checked, setChecked] = useState<Set<string>>(new Set());

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

  // 应用内确认卡片（替代 window.confirm——WebView2 的原生确认框会掉到窗口后面，难关）
  const [ask, setAsk] = useState<{ text: string; onOk: () => void } | null>(null);
  const askDialog = (text: string, onOk: () => void) => setAsk({ text, onOk });

  const doBatch = (op: BatchOp) => {
    const selectedIds =
      op === "selected" ? (checked.size ? [...checked] : selSegId ? [selSegId] : undefined) : undefined;
    const tasks = collectBatchTasks(project, op, selectedIds);
    if (!tasks.length) {
      toast(op === "missing" ? "没有缺失的片段" : op === "failed" ? "没有失败的任务" : op === "modified" ? "没有已修改的片段" : "请先选中要生成的片段", "info");
      return;
    }
    askDialog(
      `即将生成 ${tasks.length} 个视频片段（本地 ComfyUI 串行，不产生 API 费用；若配方使用远程计费接口则按其计费）。` +
        (project.tailFrameRelay ? "已开启空间接力：每段会读取紧邻上一段的采用/最新成功版本，自动保存稳定桥接帧；配方支持时同时保存末尾 2 秒动作参考。" : "") +
        "确认开始？",
      () => void executeBatch(op, selectedIds),
    );
  };

  const executeBatch = async (op: BatchOp, selectedIds?: string[]) => {
    setBatchBusy(true);
    setBatchDone(0);
    const n = collectBatchTasks(project, op, selectedIds).length;
    setBatchTotal(n);
    try {
      const { done, failed, cancelled } = await runBatch(project.id, op, selectedIds, (d, t, name, detail) => {
        setBatchDone(d + 1);
        setBatchTotal(t);
        setBatchProgress(name ? `(${d + 1}/${t}) ${name}` : "");
        setBatchPct(detail?.pct);
        setBatchMsg(detail?.msg ?? "");
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
      setBatchPct(undefined);
      setBatchMsg("");
    }
  };

  /** 「停止」按钮：立即中断在途生成 + 强停 ComfyUI + 清空显存内存（区别于「取消批量」跑完当前段才停） */
  const doHardStop = async () => {
    setStopping(true);
    try {
      toast(await stopBatchHard(), "ok");
    } finally {
      setStopping(false);
    }
  };

  if (!allSegs.length) {
    return (
      <div className="ds-page">
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

      {/* 批量生成：单行工具条（选项少，不占纵向空间） */}
      <div className="ds-card ds-batchbar">
        <div className="ds-batchbar-row">
          {batchBusy ? (
            <div className="dsg-batch-live nodrag">
              <div className="dsg-batch-live-head">
                <span className="ds-card-desc dsg-batch-progress">
                  <IcLoading size={13} /> {batchProgress || "生成中"}
                </span>
                <span className="ds-opt-hint">
                  总进度 {batchDone}/{batchTotal}
                  {batchPct !== undefined ? ` · 当前片段 ${batchPct}%` : ""}
                </span>
                <span className="spacer" />
                <button className="btn sm danger" onClick={() => cancelBatch()}>
                  取消批量
                </button>
                <button
                  className="btn sm danger"
                  disabled={stopping}
                  title="立即停止当前生成：中断 ComfyUI 执行并清空排队任务、清空显存内存；远程计费任务已提交的部分无法撤销"
                  onClick={() => void doHardStop()}
                >
                  {stopping ? <IcLoading size={13} /> : <IcStop size={13} />}
                  {stopping ? " 停止中…" : " 停止"}
                </button>
              </div>
              <div className="dsg-bar" title={`批量总进度 ${batchDone}/${batchTotal}`}>
                <i style={{ width: `${batchTotal ? Math.round((batchDone / batchTotal) * 100) : 0}%` }} />
              </div>
              <div
                className={`dsg-bar sub${batchPct === undefined ? " indet" : ""}`}
                title={batchMsg || "当前片段进度（ComfyUI 报节点/步数百分比；远程任务为不确定进度）"}
              >
                <i style={batchPct !== undefined ? { width: `${batchPct}%` } : undefined} />
              </div>
              <div className="dsg-sub-msg" title={batchMsg}>
                {batchMsg || "当前片段生成中…"}
              </div>
            </div>
          ) : (
            <>
              <PopSelect
                className="dsg-batch-scope"
                title="批量范围"
                value={batchOp}
                triggerIcon
                options={[
                  { value: "missing", label: "缺失片段", icon: <IcFilmFrame size={14} /> },
                  { value: "modified", label: "已修改片段", icon: <IcRefresh size={14} /> },
                  { value: "failed", label: "失败任务", icon: <IcClose size={14} /> },
                  { value: "selected", label: checked.size ? `勾选的片段（${checked.size}）` : "勾选/当前选中片段", icon: <IcCheck size={14} /> },
                ]}
                onChange={(v) => setBatchOp(v as BatchOp)}
              />
              <button className="btn sm primary" onClick={() => doBatch(batchOp)}>
                <IcZap size={14} /> 开始批量生成
              </button>
              <BatchSwitches project={project} />
            </>
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
              const on = checked.has(seg.id);
              return (
                <div
                  key={seg.id}
                  role="button"
                  tabIndex={0}
                  className={`ds-seg-pick ${selSegId === seg.id ? "on" : ""}`}
                  onClick={() => setSelSegId(seg.id)}
                  onKeyDown={(e) => e.key === "Enter" && setSelSegId(seg.id)}
                >
                  <input
                    type="checkbox"
                    className="nodrag ds-seg-check"
                    title="勾选后可用批量范围「勾选的片段」一起重新生成"
                    checked={on}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(seg.id);
                        else next.delete(seg.id);
                        return next;
                      })
                    }
                  />
                  <span className="ds-seg-pick-n">{i + 1}</span>
                  {thumb ? (
                    <img className="ds-seg-thumb" src={assetUrl(thumb)} alt="" loading="lazy" />
                  ) : (
                    <span className="ds-seg-thumb empty">
                      <IcFilmFrame size={16} />
                    </span>
                  )}
                  <span className="ds-seg-pick-name">{scene.location} · {seg.summary.slice(0, 20)}</span>
                  {approved ? <span className="ds-badge ok"><IcCheck size={12} /></span> : seg.takes?.length ? <span className="ds-badge">{seg.takes.length}</span> : <span className="ds-badge warn">缺</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* 右：Take 卡（配方管理已收进配方下拉的「管理配方…」弹窗） */}
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
  
      {ask ? (
        <AskCard
          text={ask.text}
          okText="确认开始"
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            const f = ask.onOk;
            setAsk(null);
            f();
          }}
        />
      ) : null}
      </div>
      </div>
    </div>
  );
}

function TakeManager({ project, segment }: { project: DirectorProject; segment: DirectorSegment }) {
  const updateProject = useDirector((s) => s.updateProject);
  const collect = useAssets((s) => s.collect);
  const assets = useAssets((s) => s.items);
  const fileRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  const takes = segment.takes ?? [];
  const approved = segment.approvedTakeId;
  // 正在生成：以 store 里 Take 的真实状态为准（切页不丢）
  const running = takes.some((t) => t.status === "running" || t.status === "queued");

  /** 按当前提示词与参考素材重新生成本段（产出一个新版本 Take） */
  const regen = async () => {
    setRegenBusy(true);
    try {
      const r = await runBatch(project.id, "selected", [segment.id]);
      if (r.done || r.failed) toast(`生成结束：完成 ${r.done}${r.failed ? ` · 失败 ${r.failed}` : ""}`, r.failed ? "info" : "ok");
    } finally {
      setRegenBusy(false);
    }
  };

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
  /** 取消采用：清掉采用标记回到未选片状态（版本保留，可重新采用别的） */
  const unsetApproved = () => {
    const scenes = project.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) =>
        seg.id === segment.id
          ? { ...seg, approvedTakeId: null, takes: (seg.takes ?? []).map((t) => ({ ...t, approved: false })) }
          : seg,
      ),
    }));
    updateProject(project.id, { scenes });
  };
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
  const [askDel, setAskDel] = useState<string | null>(null);
  const removeTake = (takeId: string) => {
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
        <span className="ds-card-acts">
          <button
            className="btn sm primary"
            title="按当前提示词与参考素材重新生成本段（产出一个新版本）"
            disabled={running || regenBusy}
            onClick={() => void regen()}
          >
            {running || regenBusy ? <IcLoading size={13} /> : <IcRefresh size={13} />} 重新生成
          </button>
        </span>
      </div>
      <div className="ds-card-body">
        {/* 片段级配方选择：模板直选自动建配方 */}
        <div className="dsg-take-recipe nodrag">
          <span className="ds-card-desc">本片段配方</span>
          <RecipeSelect project={project} target="segment" segmentId={segment.id} />
        </div>
        {takes.length ? (
          <div className="ds-takes">
            {takes.map((t) => {
              const asset = t.assetId ? assets.find((a) => a.id === t.assetId) : undefined;
              return (
                <TakeCard
                  key={t.id}
                  take={t}
                  projectId={project.id}
                  segmentId={segment.id}
                  segmentName={segment.summary}
                  assetKind={asset?.kind}
                  assetPath={asset?.path}
                  assetName={asset?.name}
                  approved={approved === t.id}
                  onApprove={() => setApproved(t.id)}
                  onUnapprove={unsetApproved}
                  onStar={() => toggleStar(t.id)}
                  onRemove={() => setAskDel(t.id)}
                />
              );
            })}
          </div>
        ) : (
          <div className="ds-empty">
            <div className="ds-empty-title">还没有版本</div>
            <div className="ds-empty-desc">用上方「开始批量生成」跑一遍，或手动导入外部生成结果。</div>
          </div>
        )}
      </div>
      <div className="ds-card-foot">
        <input ref={fileRef} type="file" hidden accept="image/*" multiple onChange={(e) => e.target.files && importResult("image", e.target.files)} />
        <input ref={vidRef} type="file" hidden accept="video/*" multiple onChange={(e) => e.target.files && importResult("video", e.target.files)} />
        <button className="btn sm" disabled={importing} onClick={() => fileRef.current?.click()}>
          <IcUpload size={14} /> 导入图片结果
        </button>
        <button className="btn sm" disabled={importing} onClick={() => vidRef.current?.click()}>
          <IcUpload size={14} /> 导入视频结果
        </button>
        <span className="spacer" />
        <span className="ds-hint">生成队列后续版本接入，当前可手动导入</span>

      {askDel ? (
        <AskCard
          danger
          text="删除这个版本？（已采用的需先取消采用）"
          okText="删除"
          onCancel={() => setAskDel(null)}
          onConfirm={() => {
            removeTake(askDel);
            setAskDel(null);
          }}
        />
      ) : null}</div>
    </div>
  );
}

/** 资产路径 → 可播 URL：视频走 blob URL（WebView2 的 asset:// 不支持视频 Range 流式播放） */
function usePlayableUrl(path?: string): string | undefined {
  const [u, setU] = useState<string | undefined>(() =>
    path && !/^[a-z]+:/i.test(path) ? undefined : path,
  );
  useEffect(() => {
    let on = true;
    if (!path) {
      setU(undefined);
      return;
    }
    if (/^(blob:|data:|https?:)/i.test(path)) {
      setU(path);
      return;
    }
    void assetToBlobUrl(path)
      .then((x) => {
        if (on) setU(x);
      })
      .catch(() => setU(path)); // 转换失败退回 asset://（浏览器预览模式本来就能播）
    return () => {
      on = false;
    };
  }, [path]);
  return u;
}

function TakeCard({ take, projectId, segmentId, segmentName, assetKind, assetPath, assetName, approved, onApprove, onUnapprove, onStar, onRemove }: {
  take: DirectorTake;
  projectId: string;
  segmentId: string;
  segmentName: string;
  assetKind?: "image" | "video" | "audio" | "other" | "pdf" | "vector";
  assetPath?: string;
  assetName?: string;
  approved: boolean;
  onApprove: () => void;
  onUnapprove: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  const isVideo = take.kind === "video" || assetKind === "video";
  const playUrl = usePlayableUrl(isVideo ? assetPath : undefined);
  // 提取声音：区间弹窗（提取 WAV 入资产库，拖到其他片段的音频参考格统一声线）
  const [sndOpen, setSndOpen] = useState(false);
  const [sndBusy, setSndBusy] = useState(false);
  const [sndFrom, setSndFrom] = useState("0");
  const [sndTo, setSndTo] = useState("");
  const sndAnchor = useRef<HTMLButtonElement>(null);

  const extractVoice = async () => {
    if (!playUrl) return;
    const from = Number(sndFrom) || 0;
    const to = sndTo.trim() === "" ? undefined : Number(sndTo);
    if (to !== undefined && (!Number.isFinite(to) || to <= from)) {
      toast("结束秒需大于开始秒（留空 = 提取到片尾）", "err");
      return;
    }
    setSndBusy(true);
    try {
      const wav = await extractAudioWav(playUrl, from, to);
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(new Error("读取失败"));
        r.readAsDataURL(wav);
      });
      const asset = await useAssets.getState().collect({
        src: dataUrl,
        kind: "audio",
        name: `${segmentName.slice(0, 10)} 声线`,
        director: { projectId, segmentId, role: "reference" },
      });
      if (asset) toast(`声音已提取入库（${(wav.size / 1024).toFixed(0)}KB，在资产库 →「导演台参考」分类）——到分镜页把「${asset.name}」加进其他片段的音频参考格即可统一声线`, "ok");
      setSndOpen(false);
    } catch (e) {
      toast(`提取声音失败：${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setSndBusy(false);
    }
  };

  // 预览区：视频 = 悬停擦洗缩略图（blob URL 可播放，点击灯箱），图片 = 缩略图（点击灯箱放大）
  const preview =
    assetPath && take.status === "done" ? (
      isVideo ? (
        playUrl ? (
          <ScrubVideoThumb src={playUrl} className="ds-take-media" />
        ) : (
          <div className="ds-take-media empty">
            <IcLoading size={14} />
          </div>
        )
      ) : (
        <Thumb
          src={assetUrl(assetPath)}
          className="ds-take-media"
          title={`${assetName ?? "生成结果"}（点击放大）`}
          onClick={() => useUi.getState().setLightbox(assetUrl(assetPath), null, "image")}
        />
      )
    ) : (
      <div className="ds-take-media empty" title={take.error ?? undefined}>
        <span>{take.status === "running" ? "生成中…" : take.status === "queued" ? "排队中" : take.status === "error" ? "失败" : "无预览"}</span>
      </div>
    );
  // 真实生成耗时：优先 startedAt（不含排队等待）；旧数据无 startedAt 时退回 createdAt
  const genSec =
    take.finishedAt && take.finishedAt > (take.startedAt ?? take.createdAt)
      ? Math.round((take.finishedAt - (take.startedAt ?? take.createdAt)) / 1000)
      : 0;
  return (
    <div className={`ds-take ${approved ? "approved" : ""}`}>
      {/* 收藏星标：卡片左上角悬浮（不占底部操作行宽度） */}
      <button className={`icon-btn dsg-star ds-take-star ${take.starred ? "on" : ""}`} aria-label="星标" title="星标收藏" onClick={onStar}>
        <IcStar size={13} />
      </button>
      <div className="ds-take-thumb">{preview}</div>
      <div className="ds-take-head">
        <span className="ds-badge">{take.kind === "video" ? "视频" : "图片"}</span>
        {genSec > 0 ? (
          <span className="ds-badge" title={`生成耗时 ${genSec} 秒（不含排队等待）`}>
            <IcTimer size={12} /> {fmtDur(genSec)}
          </span>
        ) : null}
        {take.status === "done" ? (
          approved ? (
            <span className="ds-badge ok"><IcCheck size={12} /> 采用</span>
          ) : null
        ) : (
          <span className="ds-badge warn">{take.status === "running" ? "生成中" : take.status === "error" ? "失败" : take.status}</span>
        )}
      </div>
      {take.error ? (
        <div className="ds-card-desc dsg-err" title={take.error}>
          {take.error.slice(0, 60)}
        </div>
      ) : null}
      <div className="ds-take-actions-row">
        {isVideo && take.status === "done" && playUrl ? (
          <button ref={sndAnchor} className="icon-btn" title="提取人物声音（可选区间，入资产库后拖到其他片段的音频参考格）" onClick={() => setSndOpen((v) => !v)}>
            {sndBusy ? <IcLoading size={14} /> : <IcMic size={14} />}
          </button>
        ) : null}
        {take.status === "done" ? (
          approved ? (
            <button className="btn sm ghost" title="取消采用，回到未选片状态（版本保留）" onClick={onUnapprove}>
              取消采用
            </button>
          ) : (
            <button className="btn sm primary" onClick={onApprove}>
              <IcCheck size={14} /> 采用
            </button>
          )
        ) : null}
        <button className="icon-btn danger" aria-label="删除" title="删除" onClick={onRemove}><IcClose size={13} /></button>
      </div>
      {sndOpen ? (
        <PopLayer anchorRef={sndAnchor} onClose={() => setSndOpen(false)} className="ds-snd-pop">
          <div className="ds-snd-title">提取人物声音（统一声线用）</div>
          <div className="ds-snd-row nodrag">
            <label>
              开始秒
              <input className="input sm" value={sndFrom} onChange={(e) => setSndFrom(e.target.value)} placeholder="0" />
            </label>
            <label>
              结束秒
              <input className="input sm" value={sndTo} onChange={(e) => setSndTo(e.target.value)} placeholder="片尾" />
            </label>
          </div>
          <div className="ds-snd-hint">截取说话最清晰的一小段即可；提取后到分镜页，用片段「音频参考」格的挑选（或资产库 →「导演台参考」分类）把这条声音加进其他片段（REF2VA 的 Audio N），人物声线就跟这一段对齐。</div>
          <button className="btn sm primary" disabled={sndBusy} onClick={() => void extractVoice()}>
            {sndBusy ? <IcLoading size={13} /> : <IcMic size={13} />} 提取并入库
          </button>
        </PopLayer>
      ) : null}
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
