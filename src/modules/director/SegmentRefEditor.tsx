/**
 * 分镜参考槽编辑器 — 固定格子布局（标题在上、方格在下，所有片段卡高度一致）
 *
 *  - 格位：首帧/尾帧 1 格；参考图 6 格；视频参考 2 格；音频参考 2 格（素材超出时自动扩格）
 *  - 批量拖入：多选文件拖到任意空格，按拾取顺序依次入区；上传完成后一次性写回
 *    （旧版逐个写回时闭包里的旧槽位互相覆盖，导致只留最后 1 张——已修复）
 *  - 长按拖动：同区拖到某格前 = 重排；跨区拖 = 移动（同类型才允许）；
 *    Alt+拖到其他片段卡 = 复制（源卡不动，目标卡追加）
 *  - 片段级槽位一律 auto:false（手动添加，上游同步对账时不会被清掉）
 *  - 槽序即编号序：图片对应 <Picture N>，视频/音频同理 <Video N>/<Audio N>
 *  - 配方不支持视/音参考时对应区整体置灰（无接口）
 */
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAssets } from "../../core/stores/assetStore";
import { useDirector } from "../../core/stores/directorStore";
import { toast } from "../../core/stores/uiStore";
import { assetUrl, assetToBlobUrl } from "../../core/services/assetFiles";
import { errMsg, fileToDataUrl } from "../../core/utils";
import { IcClose, IcPlus } from "../../ui/icons";
import type { AssetItem, ComfySemantic, DirectorProject, DirectorSegment, DirectorSlotValue } from "../../core/types";

type Zone = {
  semantic: ComfySemantic;
  label: string;
  kind: "image" | "video" | "audio";
  /** 单例区（首帧/尾帧）：只保留一张 */
  single?: boolean;
  accept: string;
  /** 编号提示（H3 标签体系） */
  tag: string;
};

const ZONES: Zone[] = [
  { semantic: "firstFrame", label: "首帧", kind: "image", single: true, accept: "image/*", tag: "FL2VA 的 <Picture 1>" },
  { semantic: "lastFrame", label: "尾帧", kind: "image", single: true, accept: "image/*", tag: "FL2VA 的 <Picture 2>" },
  { semantic: "referenceImage", label: "参考图", kind: "image", accept: "image/*", tag: "按序对应 <Picture N>" },
  { semantic: "referenceVideo", label: "视频参考", kind: "video", accept: "video/*", tag: "按序对应 <Video N>" },
  { semantic: "referenceAudio", label: "音频参考", kind: "audio", accept: "audio/*", tag: "按序对应 <Audio N>" },
];

/** 固定格位：没有素材也占位，保证卡片高度一致（参考图 9 格对应 H3 REF2VA 上限，视频/音频 3 格对应其 3 视 3 音接口） */
const CAPACITY: Record<string, number> = {
  firstFrame: 1,
  lastFrame: 1,
  referenceImage: 9,
  referenceVideo: 3,
  referenceAudio: 3,
};

const KIND_NAME: Record<Zone["kind"], string> = { image: "图片", video: "视频", audio: "音频" };

/** 拖拽负载（模块级：dragover 阶段读不到 dataTransfer.getData） */
let dragChip: { semantic: ComfySemantic; assetId: string; segmentId: string } | null = null;

/** 取某语义区的有序资产 id（片段槽内该语义的第一个槽承载整组顺序） */
function zoneIds(segment: DirectorSegment, semantic: ComfySemantic): string[] {
  const slot = (segment.slots ?? []).find((s) => s.semantic === semantic);
  return slot?.assetIds ?? [];
}

export function SegmentRefEditor({
  project,
  segment,
  allowVideo,
  allowAudio,
}: {
  project: DirectorProject;
  segment: DirectorSegment;
  /** 配方是否支持视频/音频参考（REF2VA 有 LoadVideo/LoadAudio 接口才为 true） */
  allowVideo: boolean;
  allowAudio: boolean;
}) {
  const updateProject = useDirector((s) => s.updateProject);
  const collect = useAssets((s) => s.collect);
  const assets = useAssets((s) => s.items);
  const [pickZone, setPickZone] = useState<ComfySemantic | null>(null);
  const [pendingZone, setPendingZone] = useState<Zone | null>(null);
  /** 拖拽悬停指示：`semantic`（追加到空格）或 `semantic|assetId`（插到该格前） */
  const [dragHint, setDragHint] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // —— 悬停预览：图放大、视频自动播放（静音+控件）、音频悬停即播 ——
  const [hoverPrev, setHoverPrev] = useState<{ kind: Zone["kind"]; asset: AssetItem; x: number; y: number; url?: string } | null>(null);
  const hoverTimer = useRef<number>(0);
  /** 视频/音频要 blob URL（WebView2 的 asset:// 不支持流式播放）；按资产 id 缓存避免反复生成 */
  const mediaUrlCache = useRef(new Map<string, string>());
  const mediaUrlOf = async (a: AssetItem): Promise<string | undefined> => {
    const hit = mediaUrlCache.current.get(a.id);
    if (hit) return hit;
    try {
      const u = await assetToBlobUrl(a.path, a.mime);
      mediaUrlCache.current.set(a.id, u);
      return u;
    } catch {
      return assetUrl(a.path) || undefined;
    }
  };
  const onChipEnter = (zone: Zone, a: AssetItem | undefined, e: React.MouseEvent) => {
    if (!a) return;
    window.clearTimeout(closeTimer.current);
    const { clientX: x, clientY: y } = e;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(async () => {
      const url = zone.kind === "image" ? undefined : await mediaUrlOf(a);
      setHoverPrev({ kind: zone.kind, asset: a, x, y, url });
    }, 220);
  };
  const onChipMove = (e: React.MouseEvent) => {
    setHoverPrev((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h));
  };
  /** 离开素材格不立即关：鼠标移进浮层本体（点播放/暂停）时接力保活 */
  const closeTimer = useRef<number>(0);
  const onChipLeave = () => {
    window.clearTimeout(hoverTimer.current);
    closeTimer.current = window.setTimeout(() => setHoverPrev(null), 140);
  };
  const onPrevEnter = () => window.clearTimeout(closeTimer.current);
  const onPrevLeave = () => setHoverPrev(null);
  const hoverAsset = hoverPrev?.asset;

  /** 从 store 读某片段的最新槽位副本（上传/跨卡操作耗时后闭包里的 segment 已过期） */
  const liveSlots = (segId: string): DirectorSlotValue[] => {
    const cur = useDirector.getState().getById(project.id);
    const g = cur?.scenes.flatMap((s) => s.segments).find((x) => x.id === segId);
    return (g?.slots ?? []).map((s) => ({ ...s, assetIds: [...s.assetIds] }));
  };

  /** 把一组资产写进某片段某区，返回整份新槽位（single 替换 / 去重追加） */
  const applyToZone = (segId: string, zone: Zone, ids: string[]): DirectorSlotValue[] => {
    const slots = liveSlots(segId);
    let idx = slots.findIndex((s) => s.semantic === zone.semantic);
    if (idx < 0) {
      slots.push({ semantic: zone.semantic, assetIds: [], auto: false });
      idx = slots.length - 1;
    }
    if (zone.single) {
      slots[idx].assetIds = [ids[0]];
    } else {
      for (const id of ids) if (!slots[idx].assetIds.includes(id)) slots[idx].assetIds.push(id);
    }
    return slots;
  };

  /** 写回某片段槽位（读最新项目，防覆盖并发改动） */
  const writeSegSlots = (segId: string, slots: DirectorSlotValue[]) => {
    const cur = useDirector.getState().getById(project.id);
    if (!cur) return;
    updateProject(project.id, {
      scenes: cur.scenes.map((s) => ({
        ...s,
        segments: s.segments.map((g) => (g.id === segId ? { ...g, slots } : g)),
      })),
    });
  };

  const addToZone = (zone: Zone, assetId: string) => writeSegSlots(segment.id, applyToZone(segment.id, zone, [assetId]));

  const removeFromZone = (zone: Zone, assetId: string) => {
    const slots = liveSlots(segment.id)
      .map((s) => (s.semantic === zone.semantic ? { ...s, assetIds: s.assetIds.filter((id) => id !== assetId) } : s))
      .filter((s) => s.assetIds.length > 0);
    writeSegSlots(segment.id, slots);
  };

  /** 拖放落格：同区重排（插到目标格前）；跨区 = 移动；Alt+跨卡 = 复制 */
  const dropChip = (targetZone: Zone, beforeAssetId: string | undefined, altKey: boolean) => {
    const src = dragChip;
    dragChip = null;
    setDragHint(null);
    if (!src) return;
    if (src.semantic === targetZone.semantic && src.segmentId === segment.id && beforeAssetId === src.assetId) return;
    const srcZone = ZONES.find((z) => z.semantic === src.semantic);
    if (!srcZone) return;
    if (srcZone.kind !== targetZone.kind) {
      toast(`类型不符：${KIND_NAME[srcZone.kind]}不能放进「${targetZone.label}」（${KIND_NAME[targetZone.kind]}区）`, "err");
      return;
    }
    // 跨卡片：Alt = 复制（源卡不动）；默认 = 移动（源卡摘除后写入目标卡）
    if (src.segmentId !== segment.id) {
      if (altKey) {
        writeSegSlots(segment.id, applyToZone(segment.id, targetZone, [src.assetId]));
        return;
      }
      const srcSlots = liveSlots(src.segmentId)
        .map((s) =>
          s.semantic === src.semantic ? { ...s, assetIds: s.assetIds.filter((id) => id !== src.assetId) } : s,
        )
        .filter((s) => s.assetIds.length > 0);
      writeSegSlots(src.segmentId, srcSlots);
      writeSegSlots(segment.id, applyToZone(segment.id, targetZone, [src.assetId]));
      return;
    }
    // 同卡片：摘出源格 → 插入目标格前 / 尾部追加（单例区直接替换）
    const slots = liveSlots(segment.id);
    const srcSlot = slots.find((s) => s.semantic === src.semantic);
    if (srcSlot) srcSlot.assetIds = srcSlot.assetIds.filter((id) => id !== src.assetId);
    let dst = slots.find((s) => s.semantic === targetZone.semantic);
    if (!dst) {
      dst = { semantic: targetZone.semantic, assetIds: [], auto: false };
      slots.push(dst);
    }
    if (targetZone.single) {
      dst.assetIds = [src.assetId];
    } else {
      const at = beforeAssetId ? dst.assetIds.indexOf(beforeAssetId) : -1;
      if (at >= 0) dst.assetIds.splice(at, 0, src.assetId);
      else dst.assetIds.push(src.assetId);
    }
    writeSegSlots(segment.id, slots.filter((s) => s.assetIds.length > 0));
  };

  /** 格子落点：文件拖放（多选一次写回）与素材拖动共用 */
  const onZoneDrop = (zone: Zone, e: React.DragEvent, beforeAssetId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragHint(null);
    if (e.dataTransfer.files?.length) {
      void onFiles(zone, e.dataTransfer.files);
      return;
    }
    dropChip(zone, beforeAssetId, e.altKey);
  };

  /** 本地上传：全部收录资产库后一次性写回（逐个写会互相覆盖，只剩 1 张的 bug 已修复） */
  const onFiles = async (zone: Zone, files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith(`${zone.kind}/`));
    if (!list.length) {
      toast(`文件类型不符：「${zone.label}」需要${KIND_NAME[zone.kind]}文件`, "err");
      return;
    }
    try {
      const ids: string[] = [];
      for (const f of list) {
        const dataUrl = await fileToDataUrl(f);
        const asset = await collect({
          src: dataUrl,
          kind: zone.kind,
          name: f.name.replace(/\.[^.]+$/, ""),
          director: { projectId: project.id, segmentId: segment.id, role: "reference" },
        });
        if (asset) ids.push(asset.id);
      }
      if (ids.length) writeSegSlots(segment.id, applyToZone(segment.id, zone, ids));
    } catch (e) {
      toast(`参考素材导入失败：${errMsg(e)}`, "err");
    }
  };

  /** 资产库挑选面板的候选（按区类型过滤，标出已在区内的） */
  const pickItems = useMemo(() => {
    if (!pickZone) return [];
    const zone = ZONES.find((z) => z.semantic === pickZone)!;
    return assets.filter((a) => a.kind === zone.kind);
  }, [pickZone, assets]);

  /** 点击空格上传：记住目标区后开文件框（可多选，按顺序入区） */
  const clickUpload = (zone: Zone) => {
    setPendingZone(zone);
    requestAnimationFrame(() => fileRef.current?.click());
  };

  /** 素材格：编号角标 + 悬停预览/操作；长按拖动重排 / 跨区移动 / Alt 跨卡复制 */
  const renderChip = (zone: Zone, _ids: string[], aid: string, i: number, disabled: boolean) => {
    const a = assets.find((x) => x.id === aid);
    const hintKey = `${zone.semantic}|${aid}`;
    return (
      <span
        key={aid}
        className={`ds-ref-block${dragHint === hintKey ? " drop" : ""}`}
        title={a?.name ?? "资产缺失"}
        onMouseEnter={(e) => onChipEnter(zone, a, e)}
        onMouseMove={onChipMove}
        onMouseLeave={onChipLeave}
        draggable={!disabled}
        onDragStart={() => {
          dragChip = { semantic: zone.semantic, assetId: aid, segmentId: segment.id };
          setDragHint(null);
        }}
        onDragEnd={() => {
          dragChip = null;
          setDragHint(null);
        }}
        onDragOver={(e) => {
          if (dragChip && !disabled) {
            e.preventDefault();
            e.stopPropagation();
            setDragHint(hintKey);
          }
        }}
        onDrop={(e) => {
          if (disabled) return;
          onZoneDrop(zone, e, aid);
        }}
      >
        {a?.thumb || (a && a.kind === "image") ? (
          <img src={assetUrl(a!.thumb || a!.path)} alt="" loading="lazy" />
        ) : (
          <i className="ds-ref-chip-kind">{zone.label.slice(0, 1)}</i>
        )}
        <em>{i + 1}</em>
        {!disabled ? (
          <span className="ds-ref-block-acts">
            <button className="icon-btn mini danger" title="移出本段参考" onClick={() => removeFromZone(zone, aid)}>
              <IcClose size={11} />
            </button>
          </span>
        ) : null}
      </span>
    );
  };

  /** 资产库挑选面板 */
  const renderPicker = (zone: Zone, ids: string[]) =>
    pickZone === zone.semantic ? (
      <div className="ds-ref-pick">
        {pickItems.length ? (
          pickItems.slice(0, 24).map((a) => {
            const on = ids.includes(a.id);
            return (
              <button
                key={a.id}
                className={`ds-ref-pick-item${on ? " on" : ""}`}
                title={a.name}
                onClick={() => {
                  if (on) removeFromZone(zone, a.id);
                  else addToZone(zone, a.id);
                  if (zone.single) setPickZone(null);
                }}
              >
                {a.thumb || a.kind === "image" ? (
                  <img src={assetUrl(a.thumb || a.path)} alt="" loading="lazy" />
                ) : (
                  <span>{a.name.slice(0, 8)}</span>
                )}
              </button>
            );
          })
        ) : (
          <div className="ds-card-desc">资产库里还没有{zone.label}素材，点空格上传本地文件</div>
        )}
      </div>
    ) : null;

  return (
    <div className="ds-ref-editor">
      {/* 悬停预览浮层（Portal 到 body，不被卡片裁切）：图放大 / 视频自动播放 / 音频悬停即播 */}
      {hoverPrev && hoverAsset
        ? createPortal(
            <div
              className="ds-ref-preview"
              style={{
                left: Math.min(hoverPrev.x + 14, window.innerWidth - 350),
                top: Math.min(hoverPrev.y + 14, window.innerHeight - 300),
              }}
              onMouseEnter={onPrevEnter}
              onMouseLeave={onPrevLeave}
            >
              <div className="ds-ref-preview-name" title={hoverAsset.name}>
                {hoverAsset.name}
              </div>
              {hoverPrev.kind === "image" ? (
                <img src={assetUrl(hoverAsset.path)} alt="" />
              ) : hoverPrev.kind === "video" ? (
                hoverPrev.url ? <video src={hoverPrev.url} autoPlay muted loop controls /> : <span className="ds-card-desc">视频载入中…</span>
              ) : hoverPrev.url ? (
                <audio src={hoverPrev.url} autoPlay controls />
              ) : (
                <span className="ds-card-desc">音频载入中…</span>
              )}
            </div>,
            document.body,
          )
        : null}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={pendingZone?.accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const z = pendingZone;
          if (z && e.target.files?.length) void onFiles(z, e.target.files);
          e.target.value = "";
        }}
      />
      {ZONES.map((zone) => {
        const disabled = (zone.kind === "video" && !allowVideo) || (zone.kind === "audio" && !allowAudio);
        const ids = zoneIds(segment, zone.semantic);
        const capacity = Math.max(CAPACITY[zone.semantic], ids.length);
        const empties = Math.max(0, capacity - ids.length);
        return (
          <div key={zone.semantic} className={`ds-ref-zone${disabled ? " disabled" : ""}`} title={`${zone.label}（${zone.tag}）`}>
            <div className="ds-ref-zone-head">
              <span className="ds-ref-zone-label">{zone.label}</span>
              {!disabled ? (
                <button
                  className="ds-ref-libbtn"
                  title={`从资产库选择已有${zone.label}`}
                  onClick={() => setPickZone(pickZone === zone.semantic ? null : zone.semantic)}
                >
                  库
                </button>
              ) : null}
            </div>
            <div className="ds-ref-slots">
              {ids.map((aid, i) => renderChip(zone, ids, aid, i, disabled))}
              {!disabled
                ? Array.from({ length: empties }).map((_, k) => (
                    <button
                      type="button"
                      key={`empty-${k}`}
                      className={`ds-ref-slot${dragHint === zone.semantic ? " drop" : ""}`}
                      title={`${zone.label}：点击选择文件（可多选，按顺序入区），或把文件/素材拖进本格；Alt+拖入其他片段卡的素材 = 复制`}
                      onClick={() => clickUpload(zone)}
                      onDragOver={(e) => {
                        if (dragChip || e.dataTransfer.types.includes("Files")) {
                          e.preventDefault();
                          setDragHint(zone.semantic);
                        }
                      }}
                      onDragLeave={() => setDragHint((h) => (h === zone.semantic ? null : h))}
                      onDrop={(e) => onZoneDrop(zone, e)}
                    >
                      <IcPlus size={12} />
                    </button>
                  ))
                : Array.from({ length: empties }).map((_, k) => (
                    <span key={`off-${k}`} className="ds-ref-slot off" title="当前配方无此接口" />
                  ))}
            </div>
            {renderPicker(zone, ids)}
          </div>
        );
      })}
    </div>
  );
}
