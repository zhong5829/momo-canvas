/**
 * 悬浮工具条「编辑」— 全部直接作用于当前节点，不再派生下游处理节点：
 *   聚焦裁剪：进入图上框选（EditSurface），本胶囊变为比例/确认条，确认后裁出局部生成新图片节点；
 *   局部重绘：进入图上蒙版涂抹，本胶囊变为工具条（工具/笔刷/提示词/通道/运行），结果就地写回；
 *   高清增强 / 扩图 / 尺寸调整：弹卡内调参运行，结果就地写回（可 Ctrl+Z 撤销）；
 *   视频节点：视频配音（产物是新音轨视频，仍派生下游节点）。
 */
import { useEffect, useRef, useState } from "react";
import { outPortType, useBoard } from "../../core/stores/boardStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { applyCropToNewNode, applyEnhance, applyInpaint, applyMark, applyOutpaint, applyResize, nodeMainImage } from "../../core/nodeEdit";
import { imageDims } from "../../core/imageInfo";
import { PopLayer, PopSelect } from "../../ui/PopSelect";
import { NumInput } from "../../ui/kit";
import {
  IcArrowL, IcBrush, IcCheck, IcChevronD, IcClose, IcCrop, IcDub, IcEnhance, IcExpand, IcLayers, IcLoading, IcResize, IcTag, IcTrash, IcUndo, IcUpscale, IcVector, IcWand,
} from "../../ui/icons";
import type { EditChannel, NodeKind, OutpaintPads, ResizeParams } from "../../core/types";

/* ================= 主入口：按会话/输出类型决定渲染什么 ================= */

export function NodeEditMenu({ id }: { id: string }) {
  const me = useUi((s) => (s.mediaEdit?.nodeId === id ? s.mediaEdit : null));
  const out = useBoard((s) => {
    const n = s.nodes.find((x) => x.id === id);
    return n ? outPortType(n.type as NodeKind, n.data as Record<string, unknown>) : null;
  });
  const hasImage = useBoard((s) => !!nodeMainImage(s.nodes.find((n) => n.id === id)));

  if (me?.mode === "crop") return <CropBar id={id} />;
  if (me?.mode === "inpaint") return <InpaintBar id={id} />;
  if (me?.mode === "mark") return <MarkBar id={id} />;
  if (out === "video") return <VideoDubButton id={id} />;
  if (out === "image" && hasImage) return <EditMenuButton id={id} />;
  return null;
}

/* ================= 视频：视频配音（派生下游节点，唯一保留的派生动作） ================= */

function VideoDubButton({ id }: { id: string }) {
  const spawn = () => {
    const s = useBoard.getState();
    const exist = s.edges.find((e) => e.source === id && s.nodes.find((n) => n.id === e.target)?.type === "videoDub");
    if (exist) {
      s.onNodesChange([{ type: "select", id: exist.target, selected: true }]);
      toast("画布上已有该处理节点，已为你选中", "ok");
      return;
    }
    s.spawnEdit(id, "videoDub");
  };
  return (
    <button className="nt-btn" title="视频配音：在下游新建配音节点（翻译/换音轨）" onClick={spawn}>
      <IcDub size={14} /> 视频配音
    </button>
  );
}

/* ================= 图片：编辑菜单 + 参数卡 ================= */

type View = "menu" | "enhance" | "outpaint" | "resize";

function EditMenuButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const wrapRef = useRef<HTMLDivElement>(null);
  const openMediaEdit = useUi((s) => s.openMediaEdit);
  const close = () => {
    setOpen(false);
    setView("menu");
  };
  return (
    <div ref={wrapRef} className="pop-wrap">
      <button className={`nt-btn ${open ? "on" : ""}`} title="直接编辑这张图片（标记/裁剪/重绘/扩图/尺寸/增强）" onClick={() => setOpen((v) => !v)}>
        <IcWand size={14} />
        编辑
        <IcChevronD size={12} className="chev" />
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={close} className={view === "menu" ? "ne-menu-pop" : "ne-pop"}>
          {view === "menu" ? (
            <div className="pop-list ne-menu2">
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "crop"); }}>
                <span className="pi-icon"><IcCrop size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">聚焦裁剪</span>
                  <span className="pi-desc">在图上框选局部，裁出为新节点</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "inpaint"); }}>
                <span className="pi-icon"><IcBrush size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">局部重绘</span>
                  <span className="pi-desc">在图上涂抹蒙版，只重画选区</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "mark"); }}>
                <span className="pi-icon"><IcTag size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">标记</span>
                  <span className="pi-desc">画笔、点位与框选标记，合成后就地写回</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); useUi.getState().setLayerEditorNodeId(id); }}>
                <span className="pi-icon"><IcLayers size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">智能分层</span>
                  <span className="pi-desc">识别标题、主体与背景，导出 PSD / 分层 TIFF</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => setView("enhance")}>
                <span className="pi-icon"><IcEnhance size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">高清增强</span>
                  <span className="pi-desc">云端重绘式放大提清，就地写回</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); useBoard.getState().spawnEdit(id, "enhanceLocal"); }}>
                <span className="pi-icon"><IcUpscale size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">超清放大</span>
                  <span className="pi-desc">本地 GPU 多模型超分 4K/8K，非破坏（新建节点，结果入资产库）</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); useBoard.getState().spawnEdit(id, "vectorize"); }}>
                <span className="pi-icon"><IcVector size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">智能矢量</span>
                  <span className="pi-desc">本地 VTracer 位图转 SVG（Logo/打卡框/文化墙），可导出 AI/CDR</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => setView("outpaint")}>
                <span className="pi-icon"><IcExpand size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">扩图</span>
                  <span className="pi-desc">向四周延展画面，就地写回</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => setView("resize")}>
                <span className="pi-icon"><IcResize size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">尺寸调整</span>
                  <span className="pi-desc">本地重采样像素，就地写回</span>
                </span>
              </button>
            </div>
          ) : view === "enhance" ? (
            <EnhanceCard id={id} onBack={() => setView("menu")} onDone={close} />
          ) : view === "outpaint" ? (
            <OutpaintCard id={id} onBack={() => setView("menu")} onDone={close} />
          ) : (
            <ResizeCard id={id} onBack={() => setView("menu")} onDone={close} />
          )}
        </PopLayer>
      ) : null}
    </div>
  );
}

/** 参数卡头部：返回箭头 + 标题 */
function CardHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="pop-title gd-more-head">
      <button className="icon-btn" title="返回" onClick={onBack}>
        <IcArrowL size={13} />
      </button>
      {title}
    </div>
  );
}

/** 运行按钮（带 running 态） */
function RunBtn({ id, label, onRun }: { id: string; label: string; onRun: () => void }) {
  const running = useBoard((s) => s.nodes.find((n) => n.id === id)?.data.status === "running");
  return (
    <button className="btn primary" disabled={!!running} style={{ opacity: running ? 0.6 : 1 }} onClick={onRun}>
      {running ? <IcLoading size={15} /> : <IcCheck size={15} />}
      {running ? "处理中…" : label}
    </button>
  );
}

/* ---------- 高清增强 ---------- */
function EnhanceCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [factor, setFactor] = useState(2);
  const [focus, setFocus] = useState<"detail" | "face" | "none">("detail");
  return (
    <>
      <CardHead title="高清增强" onBack={onBack} />
      <div className="gp-sec-title">放大倍率</div>
      <div className="gp-seg">
        {[2, 4].map((f) => (
          <button key={f} className={factor === f ? "on" : ""} onClick={() => setFactor(f)}>
            {f}×
          </button>
        ))}
      </div>
      <div className="gp-sec-title">
        增强侧重<span className="gp-hint">重绘式增强（绘画模型）；更专业的放大可接 ComfyUI 节点</span>
      </div>
      <div className="gp-seg">
        {([["detail", "细节纹理"], ["face", "人物面部"], ["none", "纯放大"]] as const).map(([v, lab]) => (
          <button key={v} className={focus === v ? "on" : ""} onClick={() => setFocus(v)}>
            {lab}
          </button>
        ))}
      </div>
      <RunBtn
        id={id}
        label={`增强并写回（${factor}×）`}
        onRun={() => {
          onDone();
          void applyEnhance(id, { factor, focus });
        }}
      />
    </>
  );
}

/* ---------- 扩图 ---------- */
const OP_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

function OutpaintCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [pads, setPads] = useState<OutpaintPads>({ left: 0.25, right: 0.25, up: 0, down: 0 });
  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState<EditChannel>("auto");
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let on = true;
    const src = nodeMainImage(useBoard.getState().nodes.find((n) => n.id === id));
    if (src) void imageDims(src).then((d) => on && d && setDims(d));
    return () => {
      on = false;
    };
  }, [id]);

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const round2 = (v: number) => Math.round(v * 100) / 100;
  /** 按目标比例居中外扩（只扩不裁） */
  const applyRatio = (r: string) => {
    if (!dims) return;
    const [a, b] = r.split(":").map(Number);
    const target = a / b;
    const cur = dims.w / dims.h;
    if (target > cur * 1.001) {
      const pad = clamp((dims.h * target - dims.w) / 2 / dims.w);
      setPads({ left: round2(pad), right: round2(pad), up: 0, down: 0 });
    } else if (target < cur * 0.999) {
      const pad = clamp((dims.w / target - dims.h) / 2 / dims.h);
      setPads({ up: round2(pad), down: round2(pad), left: 0, right: 0 });
    } else {
      setPads({ left: 0, right: 0, up: 0, down: 0 });
    }
  };
  const outW = dims ? Math.round(dims.w * (1 + pads.left + pads.right)) : 0;
  const outH = dims ? Math.round(dims.h * (1 + pads.up + pads.down)) : 0;
  const changed = pads.left + pads.right + pads.up + pads.down > 0;

  return (
    <>
      <CardHead title="扩图" onBack={onBack} />
      <div className="gp-sec-title">
        快捷比例<span className="gp-hint">按目标比例居中外扩（只扩不裁）</span>
      </div>
      <div className="gp-seg">
        {OP_RATIOS.map((r) => (
          <button key={r} title={`居中外扩到 ${r}`} onClick={() => applyRatio(r)}>
            {r}
          </button>
        ))}
      </div>
      <div className="gp-sec-title">
        各边幅度<span className="gp-hint">{dims ? `输出 ${outW} × ${outH}` : "读取原图尺寸中…"}</span>
      </div>
      {([["left", "左"], ["right", "右"], ["up", "上"], ["down", "下"]] as const).map(([side, lab]) => (
        <label key={side} className="ne-slider nodrag">
          <span>{lab}</span>
          <input
            type="range"
            className="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(pads[side] * 100)}
            onChange={(e) => setPads((p) => ({ ...p, [side]: Number(e.target.value) / 100 }))}
          />
          <b>{Math.round(pads[side] * 100)}%</b>
        </label>
      ))}
      <input
        className="input nodrag"
        placeholder="扩展区域想要什么（留空 = 自然延伸）"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <PopSelect
        title="模型通道"
        value={channel}
        options={[
          { value: "auto", label: "自动", desc: "GPT 系走真蒙版，其余走指令式" },
          { value: "mask", label: "真蒙版", desc: "images/edits mask 参数，需中转站如实转发" },
          { value: "instruct", label: "指令式", desc: "原图 + 红色标注图，兼容性最好" },
        ]}
        onChange={(v) => setChannel(v as EditChannel)}
      />
      <RunBtn
        id={id}
        label="扩图并写回"
        onRun={() => {
          if (!changed) {
            toast("请先选择扩展方向与幅度（至少一边大于 0）", "err");
            return;
          }
          onDone();
          void applyOutpaint(id, pads, prompt, channel);
        }}
      />
    </>
  );
}

/* ---------- 尺寸调整 ---------- */
function ResizeCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [params, setParams] = useState<ResizeParams>({ mode: "mp", mp: 1, sideRef: "long", sideLen: 1024, scalePct: 50 });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let on = true;
    const src = nodeMainImage(useBoard.getState().nodes.find((n) => n.id === id));
    if (src) void imageDims(src).then((d) => on && d && setDims(d));
    return () => {
      on = false;
    };
  }, [id]);
  const patch = (p: Partial<ResizeParams>) => setParams((v) => ({ ...v, ...p }));
  return (
    <>
      <CardHead title="尺寸调整" onBack={onBack} />
      <div className="gp-sec-title">
        方式<span className="gp-hint">{dims ? `原图 ${dims.w}×${dims.h}` : ""} · 本地重采样，不调模型</span>
      </div>
      <div className="gp-seg">
        {([["mp", "总像素"], ["side", "边长"], ["scale", "倍率"]] as const).map(([v, lab]) => (
          <button key={v} className={params.mode === v ? "on" : ""} onClick={() => patch({ mode: v })}>
            {lab}
          </button>
        ))}
      </div>
      {params.mode === "mp" ? (
        <label className="ne-slider nodrag" title="目标总像素（百万）">
          <span>像素</span>
          <input type="range" className="range" min={1} max={40} step={1} value={Math.round(params.mp * 10)} onChange={(e) => patch({ mp: Number(e.target.value) / 10 })} />
          <b>{params.mp.toFixed(1)}M</b>
        </label>
      ) : params.mode === "side" ? (
        <div className="ne-inline nodrag">
          <PopSelect
            value={params.sideRef}
            options={[
              { value: "long", label: "长边" },
              { value: "short", label: "短边" },
              { value: "width", label: "宽" },
              { value: "height", label: "高" },
            ]}
            onChange={(v) => patch({ sideRef: v as ResizeParams["sideRef"] })}
          />
          <NumInput className="input" min={16} max={8192} value={params.sideLen} onCommit={(n) => patch({ sideLen: n })} />
        </div>
      ) : (
        <label className="ne-slider nodrag" title="缩放百分比（100 = 原尺寸）">
          <span>倍率</span>
          <input type="range" className="range" min={10} max={400} step={5} value={params.scalePct} onChange={(e) => patch({ scalePct: Number(e.target.value) })} />
          <b>{params.scalePct}%</b>
        </label>
      )}
      <RunBtn
        id={id}
        label="重采样并写回"
        onRun={() => {
          onDone();
          void applyResize(id, params);
        }}
      />
    </>
  );
}

/* ================= 会话条：聚焦裁剪（图上框选时替换工具条内容） ================= */

const CROP_ASPECTS: [string, string][] = [
  ["free", "自由"],
  ["1:1", "1:1"],
  ["3:2", "3:2"],
  ["2:3", "2:3"],
  ["4:3", "4:3"],
  ["3:4", "3:4"],
  ["16:9", "16:9"],
  ["9:16", "9:16"],
];

function CropBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  if (!me) return null;
  return (
    <>
      <span className="nt-label">
        <IcCrop size={13} /> 框选裁剪
      </span>
      <PopSelect
        title="裁剪比例"
        value={me.aspect}
        options={CROP_ASPECTS.map(([v, lab]) => ({ value: v, label: lab }))}
        onChange={(v) => patch({ aspect: v, rect: undefined })}
      />
      <button className="nt-btn" title="清除当前框选，重新拖拽" disabled={!me.rect} style={{ opacity: me.rect ? 1 : 0.45 }} onClick={() => patch({ rect: undefined })}>
        <IcUndo size={13} /> 重选
      </button>
      <button className="nt-btn" title="退出裁剪（Esc）" onClick={close}>
        <IcClose size={13} /> 取消
      </button>
      <button
        className="nt-btn primary"
        title="把框选区域裁出为一个新的图片节点"
        disabled={!me.rect}
        style={{ opacity: me.rect ? 1 : 0.45 }}
        onClick={() => me.rect && void applyCropToNewNode(id, me.rect)}
      >
        <IcCheck size={14} /> 裁剪输出
      </button>
    </>
  );
}

/* ================= 会话条：局部重绘（图上涂抹时替换工具条内容） ================= */

function InpaintBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  const running = useBoard((s) => s.nodes.find((n) => n.id === id)?.data.status === "running");
  if (!me) return null;
  return (
    <>
      <span className="nt-label">
        <IcBrush size={13} /> 局部重绘
      </span>
      <span className="nt-seg">
        {([["brush", "涂抹"], ["rect", "框选"], ["eraser", "橡皮"]] as const).map(([v, lab]) => (
          <button key={v} className={me.tool === v ? "on" : ""} onClick={() => patch({ tool: v })}>
            {lab}
          </button>
        ))}
      </span>
      {me.tool !== "rect" ? (
        <span className="nt-brush" title="笔刷大小（原图像素）">
          <input type="range" className="range" min={8} max={180} step={4} value={me.brush} onChange={(e) => patch({ brush: Number(e.target.value) })} />
        </span>
      ) : null}
      <input
        className="input nt-prompt nodrag"
        placeholder="选区改成什么（留空 = 自然修复）"
        value={me.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />
      <PopSelect
        title="模型通道"
        value={me.channel}
        options={[
          { value: "auto", label: "自动", desc: "GPT 系走真蒙版，其余走指令式" },
          { value: "mask", label: "真蒙版", desc: "images/edits mask 参数" },
          { value: "instruct", label: "指令式", desc: "兼容性最好" },
        ]}
        onChange={(v) => patch({ channel: v as EditChannel })}
      />
      <button className="nt-btn" title="撤销一步涂抹" onClick={() => patch({ undoTick: me.undoTick + 1 })}>
        <IcUndo size={13} />
      </button>
      <button className="nt-btn" title="清空蒙版" onClick={() => patch({ clearTick: me.clearTick + 1 })}>
        <IcTrash size={13} />
      </button>
      <button className="nt-btn" title="退出重绘（Esc）" onClick={close}>
        <IcClose size={13} /> 取消
      </button>
      <button
        className="nt-btn primary"
        title="只重绘涂抹区域，结果写回本节点"
        disabled={!!running || !me.mask}
        style={{ opacity: running || !me.mask ? 0.5 : 1 }}
        onClick={() => void applyInpaint(id)}
      >
        {running ? <IcLoading size={13} /> : <IcCheck size={14} />}
        {running ? "重绘中" : "重绘"}
      </button>
    </>
  );
}

/* ================= 会话条：标记（图上彩色批注，确认后本地合成） ================= */

function MarkBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  const running = useBoard((s) => s.nodes.find((n) => n.id === id)?.data.status === "running");
  if (!me) return null;
  const tools = [
    ["brush", "画笔"], ["point", "点位"], ["rect", "框选"], ["roundRect", "圆角框"], ["eraser", "橡皮"],
  ] as const;
  return (
    <>
      <span className="nt-label"><IcTag size={13} /> 标记</span>
      <span className="nt-seg" role="group" aria-label="标记工具">
        {tools.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={me.markTool === value ? "on" : ""}
            aria-pressed={me.markTool === value}
            onClick={() => patch({ markTool: value })}
          >
            {label}
          </button>
        ))}
      </span>
      <label className="nt-color" title="标记颜色">
        <span className="sr-only">标记颜色</span>
        <input type="color" value={me.markColor} onChange={(e) => patch({ markColor: e.target.value })} />
      </label>
      <label className="nt-brush" title="线条或点位大小（原图像素）">
        <span className="sr-only">标记粗细</span>
        <input type="range" className="range" min={4} max={180} step={2} value={me.brush} onChange={(e) => patch({ brush: Number(e.target.value) })} />
      </label>
      <label className="nt-opacity" title="标记透明度">
        <span>透明度</span>
        <input type="range" className="range" min={20} max={100} step={5} value={Math.round(me.markOpacity * 100)} onChange={(e) => patch({ markOpacity: Number(e.target.value) / 100 })} />
      </label>
      <button className="nt-btn" aria-label="撤销一步标记" title="撤销一步（Ctrl+Z）" onClick={() => patch({ undoTick: me.undoTick + 1 })}><IcUndo size={13} /></button>
      <button className="nt-btn" aria-label="清空标记" title="清空所有标记" onClick={() => patch({ clearTick: me.clearTick + 1 })}><IcTrash size={13} /></button>
      <button className="nt-btn" title="退出标记（Esc）" onClick={close}><IcClose size={13} /> 取消</button>
      <button
        className="nt-btn primary"
        title="把标记层与原图合成为 PNG，并就地写回当前节点"
        disabled={!!running || !me.mark}
        style={{ opacity: running || !me.mark ? 0.5 : 1 }}
        onClick={() => void applyMark(id)}
      >
        {running ? <IcLoading size={13} /> : <IcCheck size={14} />}
        {running ? "合成中" : "合并标记"}
      </button>
    </>
  );
}
