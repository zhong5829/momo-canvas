/**
 * 导演台·成片检查页 — 采用版本时间线 + 缺片检查 + 标准交付包
 *
 * 方案 §7.10：硬切连播只用于检查缺片/时长/剧情连续性，不发展为多轨剪辑器。
 * 方案 §23.6：标准交付包目录结构。
 */
import { projectProgress, deriveTimeline } from "../../core/directorEngine";
import { useBoard } from "../../core/stores/boardStore";
import { useDirector } from "../../core/stores/directorStore";
import { checkContinuity, type ContinuityIssue } from "../../core/directorAnalysis";
import { generatePremiereXml, createAudioTrack, generateAudioTrack, generateSrt, generateShotList, generateProjectManifest, dialogueFirstStrategy, videoFirstStrategy } from "../../core/directorExport";
import { toast, useUi } from "../../core/stores/uiStore";
import { useAssets } from "../../core/stores/assetStore";
import { assetUrl } from "../../core/services/assetFiles";
import { saveTextFile } from "../comfy/templateIO";
import { IcFilmCut, IcPlay, IcMusic, IcScan, IcClapper, IcActivity, IcDownload } from "../../ui/icons";
import { useState } from "react";
import type { DirectorProject, DirectorAudioKind } from "../../core/types";

export function EditingPage({ project }: { project: DirectorProject }) {
  const progress = projectProgress(project);
  const continuityIssues = project.scenes.length ? checkContinuity(project) : [];

  // 时间线：从 scenes + approvedTakeId 派生（P1-2 修复：不再依赖持久化的 project.timeline）
  const timeline = deriveTimeline(project).map((entry) => {
    const seg = project.scenes.flatMap((s) => s.segments).find((x) => x.id === entry.segmentId)!;
    const scene = project.scenes.find((s) => s.segments.some((x) => x.id === entry.segmentId))!;
    const take = seg?.takes?.find((t) => t.id === entry.takeId)!;
    return { seg, scene, take };
  }).filter((x) => x.seg && x.take);

  // 缺片列表
  const missing = project.scenes.flatMap((scene) =>
    scene.segments
      .filter((seg) => {
        const take = seg.takes?.find((t) => t.id === seg.approvedTakeId);
        return !take || take.status !== "done";
      })
      .map((seg) => ({ seg, scene })),
  );

  const totalSec = timeline.reduce((n, t) => n + t.seg.durationSec, 0);
  const durDiff = totalSec - project.targetDurationSec;
  const canPreview = timeline.length > 0;

  // 预览：按时间线顺序把采用版本的资产地址解析成可播放 URL，喂给 SeqPlayer 逐段硬切连播
  const doPreview = () => {
    const assets = useAssets.getState().items;
    const urls: string[] = [];
    for (const { take } of timeline) {
      if (take.kind !== "video" || !take.assetId) continue;
      const asset = assets.find((a) => a.id === take.assetId);
      if (!asset) continue;
      const url = assetUrl(asset.path);
      if (url) urls.push(url);
    }
    if (!urls.length) {
      toast("采用版本没有可播放的视频资产（可能是纯图片版本或资产未落盘）", "err");
      return;
    }
    useUi.getState().setSeqPreview(urls);
  };

  const doExport = async () => {
    if (missing.length) {
      toast(`还有 ${missing.length} 个片段缺片，无法导出完整成片`, "err");
      return;
    }
    // 收集采用版本的资产路径
    const assets = useAssets.getState().items;
    const assetPaths = new Map<string, string>();
    for (const { take } of timeline) {
      if (!take.assetId) continue;
      const asset = assets.find((a) => a.id === take.assetId);
      if (asset) assetPaths.set(take.assetId!, asset.path);
    }
    // 音频资产路径
    for (const track of project.audioTracks ?? []) {
      if (track.assetId) {
        const asset = assets.find((a) => a.id === track.assetId);
        if (asset) assetPaths.set(track.assetId, asset.path);
      }
    }
    try {
      const xml = generatePremiereXml(project, assetPaths);
      const ok = await saveTextFile(`${project.name.replace(/[^\w-]/g, "_")}_premiere.xml`, xml);
      if (ok) toast("Premiere XML 已导出（可导入 Premiere Pro / DaVinci Resolve / Final Cut Pro）", "ok");
    } catch (e) {
      toast(`XML 导出失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  const exportSrt = async () => {
    const srt = generateSrt(project);
    if (!srt.trim()) {
      toast("没有对白/旁白可生成字幕", "err");
      return;
    }
    const ok = await saveTextFile(`${project.name.replace(/[^\w-]/g, "_")}.srt`, srt);
    if (ok) toast("SRT 字幕已导出", "ok");
  };
  const exportShotList = async () => {
    const ok = await saveTextFile(`${project.name.replace(/[^\w-]/g, "_")}_镜头表.csv`, "\ufeff" + generateShotList(project));
    if (ok) toast("镜头清单已导出（CSV，Excel 可打开）", "ok");
  };
  const exportManifest = async () => {
    const ok = await saveTextFile(`${project.name.replace(/[^\w-]/g, "_")}_项目清单.json`, generateProjectManifest(project));
    if (ok) toast("项目清单已导出", "ok");
  };
  const doDialogueFirst = async () => {
    toast("正在按对白时长调整片段时长…", "info");
    try {
      const r = await dialogueFirstStrategy(project.id);
      toast(`对白优先：调整了 ${r.adjusted} 段，未调整 ${r.skipped} 段`, "ok");
    } catch (e) {
      toast(`对白优先失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };
  const doVideoFirst = async () => {
    try {
      const suggestions = await videoFirstStrategy(project.id);
      if (!suggestions.length) {
        toast("没有已生成对白的片段可分析", "err");
        return;
      }
      const detail = suggestions
        .map((s) => `对白 ${s.dialogueSec.toFixed(1)}s / 画面 ${s.videoSec}s，建议语速 ${s.suggestedSpeed.toFixed(2)}x`)
        .join("；");
      toast(`画面优先分析：${detail}`, "info");
    } catch (e) {
      toast(`画面优先分析失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  // 导出为节点成片：用 concatVideos 拼接时间线，结果写回 DirectorData.outputUrl
  const doExportToNode = async () => {
    if (missing.length) {
      toast(`还有 ${missing.length} 个片段缺片，无法导出成片`, "err");
      return;
    }
    const urls = timeline
      .filter((t) => t.take.kind === "video" && t.take.assetId)
      .map((t) => {
        const asset = useAssets.getState().items.find((a) => a.id === t.take.assetId);
        return asset ? assetUrl(asset.path) : null;
      })
      .filter((u): u is string => !!u);
    if (!urls.length) {
      toast("采用版本没有可拼接的视频资产", "err");
      return;
    }
    toast("正在拼接成片（实时录制，耗时约等于总时长）…", "info");
    try {
      const { concatVideos } = await import("../../core/videoEdit");
      const blobUrl = await concatVideos(urls);
      // 落资产库（blob URL 重启后失效，必须落盘换持久地址，P1-5 修复）
      const asset = await useAssets.getState().collect({
        src: blobUrl,
        kind: "video",
        prompt: `${project.name} 成片`,
        model: "MOMO 拼接导出",
        director: { projectId: project.id, role: "export" },
      });
      if (!asset) throw new Error("成片资产收录失败");
      const stableUrl = assetUrl(asset.path);
      // 写回节点 outputUrl（持久地址）+ 项目 exportAssetId
      useBoard.getState().updateData(project.nodeId, { outputUrl: stableUrl, cover: asset.thumb, status: "done" });
      useDirector.getState().updateProject(project.id, { exportAssetId: asset.id });
      toast("成片已导出到节点（视频输出口现在可用，重启不丢失）", "ok");
    } catch (e) {
      toast(`拼接失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  return (
    <div className="ds-page">
      {/* 完成度概览 */}
      <div className="ds-stats">
        <div className="ds-stat ok">
          <b>{progress.approved}/{progress.total}</b>
          <span>已采用片段</span>
        </div>
        <div className={`ds-stat ${Math.abs(durDiff) > 5 ? "warn" : "accent"}`}>
          <b>{totalSec}s</b>
          <span>总时长 / 目标 {project.targetDurationSec}s{Math.abs(durDiff) > 5 ? `（差 ${durDiff > 0 ? "+" : ""}${durDiff}s）` : ""}</span>
        </div>
        <div className="ds-stat warn">
          <b>{progress.missing}</b>
          <span>缺片</span>
        </div>
        <div className="ds-stat danger">
          <b>{continuityIssues.length}</b>
          <span>连续性问题</span>
        </div>
      </div>

      {/* 缺片检查卡 */}
      <div className="ds-card">
        <div className="ds-card-head">
          <span className="ds-card-ic">
            <IcScan size={16} />
          </span>
          <div>
            <div className="ds-card-title">缺片检查</div>
            <div className="ds-card-desc">所有片段都有已采用的完成版本，才能导出完整成片</div>
          </div>
        </div>
        <div className="ds-card-body">
          {missing.length ? (
            <div className="ds-missing">
              {missing.map(({ seg, scene }, i) => (
                <div key={seg.id} className="ds-miss-item">
                  <span className="ds-badge warn">{i + 1}</span>
                  <span>{scene.location} · {seg.summary.slice(0, 30)}</span>
                  <span className="ds-card-desc">{seg.durationSec}s</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-title">没有缺片</div>
              <div className="ds-empty-desc">
                {progress.total > 0 ? "全部片段都已采用完成版本。" : "还没有片段，请先到「脚本」页拆分剧本。"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 故事顺序/时间线卡 */}
      <div className="ds-card">
        <div className="ds-card-head">
          <span className="ds-card-ic">
            <IcClapper size={16} />
          </span>
          <div>
            <div className="ds-card-title">故事顺序</div>
            <div className="ds-card-desc">采用版本按故事顺序连成时间线，共 {timeline.length} 段 · {totalSec}s</div>
          </div>
        </div>
        <div className="ds-card-body">
          {timeline.length ? (
            <div className="ds-timeline">
              {timeline.map(({ seg, scene, take }, i) => (
                <div key={seg.id} className="ds-tl-item">
                  <span className="ds-tl-n">{i + 1}</span>
                  <span className="ds-tl-name">{scene.location} · {seg.summary.slice(0, 20)}</span>
                  <span className="ds-tl-dur">{seg.durationSec}s</span>
                  <span className="ds-badge">{take.kind}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-title">时间线为空</div>
              <div className="ds-empty-desc">到「生成」页采用片段后，采用版本会自动进入时间线。</div>
            </div>
          )}
        </div>
        <div className="ds-card-foot">
          <span className="ds-card-desc">硬切连播仅用于检查缺片/时长/剧情连续性</span>
          <span className="spacer" />
          <button className="btn sm" disabled={!canPreview} onClick={doPreview}>
            <IcPlay size={14} /> 顺序预演（硬切）
          </button>
        </div>
      </div>

      {/* 连续性问题卡 */}
      <div className="ds-card">
        <div className="ds-card-head">
          <span className="ds-card-ic">
            <IcActivity size={16} />
          </span>
          <div>
            <div className="ds-card-title">连续性问题</div>
            <div className="ds-card-desc">检查角色/场景/道具在相邻片段间的连续性</div>
          </div>
        </div>
        <div className="ds-card-body">
          {continuityIssues.length ? (
            <div className="ds-issues">
              {continuityIssues.map((iss: ContinuityIssue, i: number) => (
                <div key={i} className={`ds-issue ${iss.level}`}>
                  <span className="ds-badge">{iss.category}</span>
                  <span className="dse-pre">{iss.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-title">未发现连续性问题</div>
              <div className="ds-empty-desc">
                {progress.total > 0 ? "相邻片段的角色/场景连续性检查通过。" : "拆分剧本并生成片段后，这里会自动检查连续性。"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 音频导演台卡（方案 §23.5） */}
      <AudioSection project={project} />

      {/* 交付导出卡 */}
      <div className="ds-card">
        <div className="ds-card-head">
          <span className="ds-card-ic">
            <IcDownload size={16} />
          </span>
          <div>
            <div className="ds-card-title">交付导出</div>
            <div className="ds-card-desc">导出 Premiere 项目、节点成片、SRT 字幕、镜头表与项目清单</div>
          </div>
        </div>
        <div className="ds-card-body">
          <div className="dse-btn-row">
            <button className="btn sm primary" disabled={!!missing.length || !timeline.length} onClick={doExport}>
              <IcFilmCut size={14} /> 导出 Premiere 项目
            </button>
            <button className="btn sm" disabled={!!missing.length || !timeline.length} onClick={() => void doExportToNode()}>
              导出为节点成片
            </button>
            <button className="btn sm" onClick={exportSrt}>导出 SRT 字幕</button>
            <button className="btn sm" onClick={exportShotList}>导出镜头表</button>
            <button className="btn sm" onClick={exportManifest}>导出项目清单</button>
          </div>
          <details className="dse-deliver">
            <summary className="ds-card-desc">标准交付包目录结构（方案 §23.6）</summary>
            <pre className="ds-deliver-tree">{`01_已确认视频
02_对白
03_旁白
04_音效
05_环境音与音乐
06_字幕
07_镜头清单与项目清单
08_Premiere_XML
09_故事预演`}</pre>
          </details>
        </div>
        <div className="ds-card-foot">
          <span className="ds-card-desc">时长策略</span>
          <span className="spacer" />
          <button
            className="btn sm"
            onClick={doDialogueFirst}
            title="先生成对白 TTS，测真实时长后调整每段片段时长（画面迁就对白）"
          >
            对白优先
          </button>
          <button
            className="btn sm"
            onClick={doVideoFirst}
            title="画面时长锁定，分析对白应采用的语速（>1x 加快，<1x 放慢）"
          >
            画面优先
          </button>
        </div>
      </div>
    </div>
  );
}

/** 音频导演台卡：对白/旁白/音效/环境音/音乐的绑定与 TTS 生成 */
function AudioSection({ project }: { project: DirectorProject }) {
  const updateProject = (patch: Partial<DirectorProject>) => useDirector.getState().updateProject(project.id, patch);
  const [newKind, setNewKind] = useState<DirectorAudioKind>("dialogue");
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const tracks = project.audioTracks ?? [];

  const addTrack = () => {
    if (!newText.trim()) {
      toast("请输入音频文本（对白/旁白/音效描述）", "err");
      return;
    }
    createAudioTrack(project.id, newKind, newText.trim());
    setNewText("");
    toast("已添加音频轨道", "ok");
  };

  const genTts = async (trackId: string) => {
    setBusy(trackId);
    try {
      await generateAudioTrack(project.id, trackId);
      toast("音频已生成", "ok");
    } catch (e) {
      toast(`音频生成失败：${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBusy(null);
    }
  };

  const removeTrack = (trackId: string) => {
    updateProject({ audioTracks: tracks.filter((t) => t.id !== trackId) });
  };

  const KIND_LABEL: Record<DirectorAudioKind, string> = {
    dialogue: "对白",
    narration: "旁白",
    sfx: "音效",
    ambient: "环境音",
    music: "音乐",
  };

  return (
    <div className="ds-card">
      <div className="ds-card-head">
        <span className="ds-card-ic">
          <IcMusic size={16} />
        </span>
        <div>
          <div className="ds-card-title">音频导演台</div>
          <div className="ds-card-desc">对白/旁白可用 TTS 生成；环境音/音乐建议外部准备后导入资产库</div>
        </div>
      </div>
      <div className="ds-card-body">
        {/* 新建音频轨道 */}
        <div className="ds-audio-add">
          <select className="input sm nodrag" value={newKind} onChange={(e) => setNewKind(e.target.value as DirectorAudioKind)}>
            {(Object.keys(KIND_LABEL) as DirectorAudioKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
          <input
            className="input nodrag"
            placeholder="输入文本（对白/旁白/音效描述）…"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTrack()}
          />
          <button className="btn sm" onClick={addTrack}>添加</button>
        </div>

        {/* 轨道列表 */}
        {tracks.length ? (
          <div className="ds-audio-list">
            {tracks.map((t) => (
              <div key={t.id} className="ds-audio-item">
                <span className="ds-badge">{KIND_LABEL[t.kind]}</span>
                <span className="ds-audio-text">{t.text}</span>
                {t.assetId ? <span className="ds-badge ok">已生成</span> : null}
                {t.kind === "dialogue" || t.kind === "narration" ? (
                  <button
                    className="btn sm"
                    disabled={busy === t.id}
                    onClick={() => genTts(t.id)}
                    title="用 TTS 生成音频"
                  >
                    {busy === t.id ? "生成中…" : "TTS"}
                  </button>
                ) : null}
                <button className="icon-btn danger" aria-label="删除" title="删除" onClick={() => removeTrack(t.id)}>✕</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="ds-empty">
            <div className="ds-empty-title">还没有音频轨道</div>
            <div className="ds-empty-desc">在上方选择类型、输入文本后添加；对白/旁白可一键 TTS 生成。</div>
          </div>
        )}
      </div>
    </div>
  );
}
