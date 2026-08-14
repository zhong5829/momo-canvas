/**
 * 导演台·分镜页 — 场景/片段/镜头结构表
 *
 * 方案 §6.2：左侧结构树 + 中央分镜卡 + 右侧检查器。
 * 本轮简化为：场景卡片列表，每场可折叠展开片段卡片，片段内显示镜头明细。
 */
import { useEffect, useState } from "react";
import { useDirector } from "../../core/stores/directorStore";
import { segmentShotContexts, compilePrompt } from "../../core/directorPrompt";
import { IcChevronD, IcClapper } from "../../ui/icons";
import type { DirectorProject, DirectorScene, DirectorSegment } from "../../core/types";

/** 片段是否已有被采用的成片 take（只读统计用） */
const hasApprovedTake = (seg: DirectorSegment) =>
  !!seg.takes?.some((t) => t.id === seg.approvedTakeId && t.status === "done");

export function StoryboardPage({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(project.scenes[0] ? [project.scenes[0].id] : []));
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

      {project.scenes.map((scene) => (
        <SceneCard
          key={scene.id}
          scene={scene}
          expanded={expanded.has(scene.id)}
          onToggle={() => toggle(scene.id)}
          project={project}
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
  onPatchSegment,
}: {
  scene: DirectorScene;
  expanded: boolean;
  onToggle: () => void;
  project: DirectorProject;
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
        <div className="ds-card-body">
          {scene.segments.map((seg, i) => (
            <SegmentCard key={seg.id} segment={seg} index={i} project={project} onPatch={onPatchSegment} />
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
  onPatch,
}: {
  segment: DirectorSegment;
  index: number;
  project: DirectorProject;
  onPatch: (id: string, patch: Partial<DirectorSegment>) => void;
}) {
  const approved = segment.takes?.find((t) => t.id === segment.approvedTakeId && t.status === "done");
  const ctxs = segmentShotContexts(project, segment);

  return (
    <div className={`ds-seg ${approved ? "approved" : ""}`}>
      <div className="ds-seg-head">
        <b>片段 {index + 1}</b>
        <span className="ds-card-desc">{segment.durationSec}s</span>
        {approved ? <span className="ds-badge ok">已采用</span> : segment.takes?.length ? <span className="ds-badge">待选片</span> : <span className="ds-badge warn">缺片</span>}
        {segment.locked ? <span className="ds-badge">🔒 已锁定</span> : null}
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
      {/* 编译后的提示词预览 */}
      {ctxs.length ? (
        <details className="ds-prompt-preview">
          <summary className="ds-card-desc">编译后提示词预览（第 1 镜）</summary>
          <pre>{compilePrompt(ctxs[0], "video-i2v")}</pre>
        </details>
      ) : null}
      {/* 片段提示词覆盖 */}
      <input
        className="input sm nodrag ds-seg-override"
        placeholder="本片段提示词覆盖（留空用编译结果）"
        value={segment.promptOverride ?? ""}
        onChange={(e) => onPatch(segment.id, { promptOverride: e.target.value })}
      />
    </div>
  );
}
