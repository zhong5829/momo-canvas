/**
 * 导演台·参考图卡 — 上游参考图的顺序与接入点管理（方案 §7.7 素材槽）
 *
 *  - 参考图来自画布上游（图片节点连进导演台节点），打开本页/上游变化时自动同步进 globalSlots
 *  - 全局槽保序：数组顺序 = 喂给模型的顺序，可上下移动调整
 *  - 每张图可选接入点（首帧/尾帧/参考图/姿势/布局）与作用域（全局 / 仅指定片段）
 *  - 片段专属图在生成该片段时追加在全局图之后；首帧/尾帧是单例语义，片段级可覆盖全局
 *  - 「排除」把图移出槽位并加入 refExcluded（不再自动同步回来），可随时恢复
 */
import { useEffect, useMemo, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { useDirector } from "../../core/stores/directorStore";
import { useAssets } from "../../core/stores/assetStore";
import { collectUpstream } from "../../core/runner";
import { syncRefSlots, hashDataUrl, REF_SEMANTICS } from "../../core/directorRefs";
import { assetUrl } from "../../core/services/assetFiles";
import { IcImage, IcChevronD, IcClose } from "../../ui/icons";
import { PopSelect } from "../../ui/PopSelect";
import type { ComfySemantic, DirectorProject, DirectorSlotValue } from "../../core/types";

type Row = {
  assetId: string;
  semantic: ComfySemantic;
  scope: "global" | "segments";
  segmentIds: string[];
  thumb: string;
};

export function RefSlotsCard({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const assets = useAssets((s) => s.items);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const [scopeOpenFor, setScopeOpenFor] = useState<string | null>(null);

  // 同步上游 → 槽位（节点上另有一份同步 effect；这里是 studio 打开期间的双保险）
  // 注意：节点不在当前活动画布时（studio 开着切了画布）collectUpstream 返回空，
  // 此时绝不能同步——会把用户配好的槽位当「上游全断开」清空
  const nodeExists = useMemo(() => nodes.some((n) => n.id === project.nodeId), [nodes, project.nodeId]);
  const upstreamImgs = useMemo(
    () => (nodeExists ? collectUpstream(project.nodeId).images : []),
    [project.nodeId, nodeExists, nodes, edges],
  );
  // 内容指纹签名：collectUpstream 每次返回新数组引用，必须按内容比较才不空转
  const upstreamSig = useMemo(() => upstreamImgs.map(hashDataUrl).join("|"), [upstreamImgs]);
  useEffect(() => {
    if (nodeExists) void syncRefSlots(project.id, upstreamImgs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, upstreamSig, nodeExists]);

  const allSegs = useMemo(
    () => project.scenes.flatMap((s) => s.segments.map((seg) => ({ seg, scene: s }))),
    [project.scenes],
  );

  // 行视图：全局槽保序在前；片段槽按 assetId+semantic 聚合成行在后
  const { globalRows, segRows } = useMemo(() => {
    const thumbOf = (aid: string) => {
      const a = assets.find((x) => x.id === aid);
      return a ? assetUrl(a.thumb || a.path) : "";
    };
    const g: Row[] = [];
    for (const s of project.globalSlots ?? [])
      for (const aid of s.assetIds)
        g.push({ assetId: aid, semantic: s.semantic, scope: "global", segmentIds: [], thumb: thumbOf(aid) });
    const segMap = new Map<string, Row>();
    for (const { seg } of allSegs)
      for (const s of seg.slots ?? [])
        for (const aid of s.assetIds) {
          const key = `${aid}|${s.semantic}`;
          const hit = segMap.get(key);
          if (hit) hit.segmentIds.push(seg.id);
          else segMap.set(key, { assetId: aid, semantic: s.semantic, scope: "segments", segmentIds: [seg.id], thumb: thumbOf(aid) });
        }
    return { globalRows: g, segRows: [...segMap.values()] };
  }, [project.globalSlots, allSegs, assets]);

  /** 当前片段槽的可变副本（segId → slots） */
  const currentSegSlots = () => {
    const m = new Map<string, DirectorSlotValue[]>();
    for (const sc of project.scenes)
      for (const seg of sc.segments) if (seg.slots) m.set(seg.id, seg.slots.map((s) => ({ ...s })));
    return m;
  };

  /** 统一写回：全局槽 + 片段槽（+ 额外字段） */
  const write = (
    globalSlots: DirectorSlotValue[],
    segSlots: Map<string, DirectorSlotValue[]>,
    extra?: Partial<DirectorProject>,
  ) => {
    const scenes = project.scenes.map((sc) => ({
      ...sc,
      segments: sc.segments.map((seg) => (segSlots.has(seg.id) ? { ...seg, slots: segSlots.get(seg.id) } : seg)),
    }));
    updateProject(project.id, { globalSlots, scenes, ...extra });
  };

  /** 全局槽内上下移动（顺序 = 喂图顺序） */
  const moveGlobal = (assetId: string, dir: -1 | 1) => {
    // 先拍平多资产 slot 为单资产槽：移动粒度与显示行一致（正常同步产物本就是一行一槽）
    const slots = (project.globalSlots ?? []).flatMap((s) =>
      s.assetIds.length > 1 ? s.assetIds.map((id) => ({ semantic: s.semantic, assetIds: [id] })) : [{ ...s }],
    );
    const i = slots.findIndex((s) => s.assetIds.includes(assetId));
    const j = i + dir;
    if (i < 0 || j < 0 || j >= slots.length) return;
    [slots[i], slots[j]] = [slots[j], slots[i]];
    write(slots, currentSegSlots());
  };

  /** 改接入点（语义槽） */
  const setSemantic = (row: Row, sem: ComfySemantic) => {
    if (row.scope === "global") {
      const slots = (project.globalSlots ?? []).map((s) =>
        s.assetIds.includes(row.assetId) ? { ...s, semantic: sem } : s,
      );
      write(slots, currentSegSlots());
    } else {
      const m = currentSegSlots();
      for (const segId of row.segmentIds) {
        m.set(
          segId,
          (m.get(segId) ?? []).map((s) =>
            s.assetIds.includes(row.assetId) && s.semantic === row.semantic ? { ...s, semantic: sem } : s,
          ),
        );
      }
      write([...(project.globalSlots ?? [])], m);
    }
  };

  /**
   * 勾选/取消片段绑定：
   *  - 全局行勾选片段 → 迁移为片段专属（从全局槽移除）
   *  - 片段行取消全部勾选 → 回落为全局（追加全局槽尾部，图不丢）
   */
  const toggleSegment = (row: Row, segId: string, on: boolean) => {
    const m = currentSegSlots();
    let globals = (project.globalSlots ?? []).map((s) => ({ ...s }));
    if (on) {
      if (row.scope === "global") globals = globals.filter((s) => !s.assetIds.includes(row.assetId));
      const list = m.get(segId) ?? [];
      if (!list.some((s) => s.assetIds.includes(row.assetId) && s.semantic === row.semantic))
        m.set(segId, [...list, { semantic: row.semantic, assetIds: [row.assetId] }]);
    } else {
      m.set(
        segId,
        (m.get(segId) ?? []).filter((s) => !(s.assetIds.includes(row.assetId) && s.semantic === row.semantic)),
      );
      const stillSomewhere = [...m.values()].some((list) => list.some((s) => s.assetIds.includes(row.assetId)));
      if (!stillSomewhere && row.scope === "segments") {
        globals = [...globals.filter((s) => !s.assetIds.includes(row.assetId)), { semantic: row.semantic, assetIds: [row.assetId] }];
      }
    }
    write(globals, m);
  };

  /** 排除：移出所有槽位并记入 refExcluded（同步不再自动加回） */
  const exclude = (row: Row) => {
    const globals = (project.globalSlots ?? []).filter((s) => !s.assetIds.includes(row.assetId));
    const m = currentSegSlots();
    for (const [k, list] of m) m.set(k, list.filter((s) => !s.assetIds.includes(row.assetId)));
    write(globals, m, { refExcluded: [...(project.refExcluded ?? []), row.assetId] });
  };

  /** 恢复全部排除：清空 refExcluded 后立即重新同步 */
  const restoreExcluded = () => {
    updateProject(project.id, { refExcluded: [] });
    void syncRefSlots(project.id, upstreamImgs);
  };

  const excludedCount = project.refExcluded?.length ?? 0;
  const total = globalRows.length + segRows.length;

  const renderRow = (row: Row, order: number | null, isFirst: boolean, isLast: boolean) => {
    const open = scopeOpenFor === row.assetId;
    return (
      <div key={`${row.assetId}|${row.semantic}|${row.scope}`} className="ds-ref-item">
        <div className="ds-ref-row">
          <span className="ds-ref-n" title={`顺序 ${order ?? "·"}`}>{order ?? "·"}</span>
          {row.thumb ? (
            <img className="ds-ref-thumb" src={row.thumb} alt="" loading="lazy" />
          ) : (
            <span className="ds-ref-thumb ds-ref-missing">失效</span>
          )}
          <PopSelect
            className="nodrag ds-ref-sem"
            title="接入点（这张图在生成里扮演什么角色）"
            value={row.semantic}
            options={REF_SEMANTICS.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(v) => setSemantic(row, v as ComfySemantic)}
          />
          <span className="spacer" />
          <button
            className={`icon-btn ds-ref-scopebtn ${row.scope === "segments" ? "on" : ""}`}
            title="作用域：全局 = 所有片段都用；也可以限定只用于勾选的片段"
            onClick={() => setScopeOpenFor(open ? null : row.assetId)}
          >
            {row.scope === "global" ? <IcImage size={14} /> : <span className="ds-ref-scopecnt">{row.segmentIds.length}</span>}
          </button>
          {row.scope === "global" ? (
            <>
              <button
                className="icon-btn"
                title="上移（顺序提前）"
                aria-label="上移"
                disabled={!!isFirst}
                onClick={() => moveGlobal(row.assetId, -1)}
              >
                <IcChevronD size={13} style={{ transform: "rotate(180deg)" }} />
              </button>
              <button
                className="icon-btn"
                title="下移（顺序靠后）"
                aria-label="下移"
                disabled={!!isLast}
                onClick={() => moveGlobal(row.assetId, 1)}
              >
                <IcChevronD size={13} />
              </button>
            </>
          ) : null}
          <button className="icon-btn danger" title="不接入此图（可从下方恢复）" aria-label="排除" onClick={() => exclude(row)}>
            <IcClose size={13} />
          </button>
        </div>
        {open ? (
          <div className="ds-ref-segpick">
            <div className="ds-card-desc">限定只用于勾选的片段；取消全部勾选会回落为全局生效</div>
            {allSegs.map(({ seg, scene }, i) => (
              <label key={seg.id} className="ds-ref-segitem">
                <input
                  type="checkbox"
                  className="nodrag"
                  checked={row.scope === "segments" && row.segmentIds.includes(seg.id)}
                  onChange={(e) => toggleSegment(row, seg.id, e.target.checked)}
                />
                <span>
                  {i + 1}. {scene.location} · {seg.summary.slice(0, 18)}
                </span>
              </label>
            ))}
            {!allSegs.length ? <div className="ds-card-desc">还没有片段，先到「剧本」页拆分。</div> : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="ds-card">
      <div className="ds-card-head">
        <span className="ds-card-ic">
          <IcImage size={16} />
        </span>
        <div>
          <div className="ds-card-title">参考图</div>
          <div className="ds-card-desc">
            来自画布上游，共 {total} 张；序号即喂给模型的顺序，可为每张选接入点（首帧/尾帧/参考图）或限定只用于某些片段
          </div>
        </div>
      </div>
      <div className="ds-card-body">
        {total ? (
          <div className="ds-refs">
            {globalRows.map((row, i) => renderRow(row, i + 1, i === 0, i === globalRows.length - 1))}
            {segRows.length ? <div className="ds-refs-sect">片段专属（生成对应片段时追加在全局图之后）</div> : null}
            {segRows.map((row) => renderRow(row, null, true, true))}
          </div>
        ) : (
          <div className="ds-empty">
            <div className="ds-empty-title">还没有接入参考图</div>
            <div className="ds-empty-desc">
              在画布上把图片节点连到导演台节点的输入口，图片会自动出现在这里；顺序与接入点（首帧/尾帧/参考图）都可以在调整后直接生效。
            </div>
          </div>
        )}
        {excludedCount ? (
          <div className="ds-refs-excluded">
            已排除 {excludedCount} 张上游图
            <button className="btn sm" onClick={restoreExcluded}>
              恢复
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
