/**
 * 节点图片直接编辑层 —— 包在节点主图（Thumb）外面：
 *  mediaEdit 会话命中本节点时，在图片上叠加交互层（crop 框选 / inpaint 蒙版 / mark 彩色标记），否则零开销直通。
 *  工具按钮都在悬浮工具条（NodeEditMenu 的会话条），本层只管指针交互与可视化。
 *  蒙版约定（与 maskCanvas.ts 一致）：与原图同尺寸的 PNG，标注处不透明白色，其余全透明。
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { useUi } from "../../core/stores/uiStore";
import { imageDims } from "../../core/imageInfo";

type Rect01 = { x: number; y: number; w: number; h: number };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function EditSurface({ id, src, children }: { id: string; src: string; children: ReactNode }) {
  const mode = useUi((s) => (s.mediaEdit?.nodeId === id ? s.mediaEdit.mode : null));

  // Esc 退出；编辑期间 Ctrl/Cmd+Z 优先撤销图上一步，避免误触画布级撤销。
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useUi.getState().closeMediaEdit();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && mode !== "crop") {
        e.preventDefault();
        e.stopPropagation();
        const me = useUi.getState().mediaEdit;
        if (me) useUi.getState().patchMediaEdit({ undoTick: me.undoTick + 1 });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode]);

  if (!mode) return <>{children}</>;
  return (
    <div className="es-wrap">
      {children}
      {mode === "crop" ? <CropOverlay key={src} /> : mode === "mark" ? <MarkOverlay key={src} src={src} /> : <MaskOverlay key={src} src={src} />}
    </div>
  );
}

/* ================= 标记：彩色画笔 / 点位 / 框 / 圆角框 ================= */

function MarkOverlay({ src }: { src: string }) {
  const viewRef = useRef<HTMLCanvasElement>(null);
  const markRef = useRef<HTMLCanvasElement | null>(null);
  const undoStack = useRef<Array<{ image: ImageData; pointNext: number }>>([]);
  const pointNextRef = useRef(1);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const shapeStart = useRef<{ x: number; y: number } | null>(null);
  const shapeCur = useRef<{ x: number; y: number } | null>(null);
  const dimsRef = useRef({ w: 1, h: 1 });
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [pointNext, setPointNext] = useState(1);
  const tool = useUi((s) => s.mediaEdit?.markTool ?? "brush");
  const brush = useUi((s) => s.mediaEdit?.brush ?? 64);
  const color = useUi((s) => s.mediaEdit?.markColor ?? "#ff3158");
  const opacity = useUi((s) => s.mediaEdit?.markOpacity ?? 0.92);
  const undoTick = useUi((s) => s.mediaEdit?.undoTick ?? 0);
  const clearTick = useUi((s) => s.mediaEdit?.clearTick ?? 0);
  const prevUndo = useRef(0);
  const prevClear = useRef(0);

  const pathRoundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
    const radius = Math.max(4, Math.min(Math.abs(w), Math.abs(h), brush * 2) * 0.2);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
  };

  const drawShape = (ctx: CanvasRenderingContext2D, start: { x: number; y: number }, end: { x: number; y: number }, pointNo?: number) => {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "point") {
      const r = Math.max(9, brush * 0.72);
      ctx.beginPath();
      ctx.arc(end.x, end.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = Math.min(1, opacity + 0.08);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(2, brush * 0.12);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${Math.max(11, r * 1.08)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(pointNo ?? pointNextRef.current), end.x, end.y + r * 0.035);
    } else if (tool === "roundRect") {
      pathRoundRect(ctx, x, y, w, h);
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  };

  const repaint = () => {
    const view = viewRef.current;
    const mark = markRef.current;
    if (!view || !mark) return;
    const ctx = view.getContext("2d")!;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(mark, 0, 0);
    if (shapeStart.current && shapeCur.current && (tool === "rect" || tool === "roundRect")) {
      drawShape(ctx, shapeStart.current, shapeCur.current);
    }
  };

  const commitMark = () => {
    const mark = markRef.current;
    if (!mark) return;
    const data = mark.getContext("2d")!.getImageData(0, 0, mark.width, mark.height).data;
    let empty = true;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 0) {
        empty = false;
        break;
      }
    }
    useUi.getState().patchMediaEdit({ mark: empty ? undefined : mark.toDataURL("image/png") });
  };

  const pushUndo = () => {
    const mark = markRef.current;
    if (!mark) return;
    undoStack.current.push({
      image: mark.getContext("2d")!.getImageData(0, 0, mark.width, mark.height),
      pointNext: pointNextRef.current,
    });
    if (undoStack.current.length > 32) undoStack.current.shift();
  };

  useEffect(() => {
    let alive = true;
    void imageDims(src).then((d) => {
      if (!alive || !d) return;
      dimsRef.current = d;
      const mark = document.createElement("canvas");
      mark.width = d.w;
      mark.height = d.h;
      markRef.current = mark;
      if (viewRef.current) {
        viewRef.current.width = d.w;
        viewRef.current.height = d.h;
      }
      const existing = useUi.getState().mediaEdit?.mark;
      if (existing) {
        const image = new Image();
        image.onload = () => {
          if (!alive) return;
          mark.getContext("2d")!.drawImage(image, 0, 0, d.w, d.h);
          repaint();
        };
        image.src = existing;
      }
      setReady(true);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (undoTick <= prevUndo.current) {
      prevUndo.current = undoTick;
      return;
    }
    prevUndo.current = undoTick;
    const mark = markRef.current;
    if (!mark) return;
    const ctx = mark.getContext("2d")!;
    const prev = undoStack.current.pop();
    if (prev) {
      ctx.putImageData(prev.image, 0, 0);
      pointNextRef.current = prev.pointNext;
      setPointNext(prev.pointNext);
    } else {
      ctx.clearRect(0, 0, mark.width, mark.height);
      pointNextRef.current = 1;
      setPointNext(1);
    }
    commitMark();
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoTick]);

  useEffect(() => {
    if (clearTick <= prevClear.current) {
      prevClear.current = clearTick;
      return;
    }
    prevClear.current = clearTick;
    const mark = markRef.current;
    if (!mark) return;
    pushUndo();
    mark.getContext("2d")!.clearRect(0, 0, mark.width, mark.height);
    pointNextRef.current = 1;
    setPointNext(1);
    commitMark();
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTick]);

  useEffect(() => { repaint(); }, [color, opacity, brush, tool]);

  const toNatural = (e: RPointerEvent) => {
    const rect = viewRef.current!.getBoundingClientRect();
    const { w, h } = dimsRef.current;
    return { x: ((e.clientX - rect.left) / rect.width) * w, y: ((e.clientY - rect.top) / rect.height) * h };
  };

  const strokeTo = (point: { x: number; y: number }) => {
    const mark = markRef.current;
    const from = lastPt.current;
    if (!mark || !from) return;
    const ctx = mark.getContext("2d")!;
    ctx.save();
    ctx.globalAlpha = opacity;
    if (tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.restore();
    lastPt.current = point;
  };

  const down = (e: RPointerEvent) => {
    if (!ready || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    viewRef.current?.setPointerCapture(e.pointerId);
    pushUndo();
    drawing.current = true;
    const p = toNatural(e);
    if (tool === "rect" || tool === "roundRect") {
      shapeStart.current = p;
      shapeCur.current = p;
    } else if (tool === "point") {
      drawShape(markRef.current!.getContext("2d")!, p, p, pointNextRef.current);
      pointNextRef.current += 1;
      setPointNext(pointNextRef.current);
    } else {
      lastPt.current = p;
      strokeTo({ x: p.x + 0.01, y: p.y });
    }
    repaint();
  };

  const move = (e: RPointerEvent) => {
    const rect = viewRef.current?.getBoundingClientRect();
    if (rect) setCursor({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
    if (!drawing.current) return;
    const p = toNatural(e);
    if (tool === "rect" || tool === "roundRect") shapeCur.current = p;
    else if (tool !== "point") strokeTo(p);
    repaint();
  };

  const up = (e: RPointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    if ((tool === "rect" || tool === "roundRect") && shapeStart.current) {
      const end = toNatural(e);
      drawShape(markRef.current!.getContext("2d")!, shapeStart.current, end);
    }
    shapeStart.current = null;
    shapeCur.current = null;
    lastPt.current = null;
    commitMark();
    repaint();
  };

  const brushW = (brush / dimsRef.current.w) * 100;
  const brushH = (brush / dimsRef.current.h) * 100;
  const showCursor = cursor && ready && (tool === "brush" || tool === "eraser" || tool === "point");

  return (
    <div className="es-ov nodrag nowheel" style={{ cursor: tool === "rect" || tool === "roundRect" ? "crosshair" : "none" }}>
      <canvas
        ref={viewRef}
        className="es-mask es-mark"
        aria-label="图片标记画布"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => setCursor(null)}
      />
      {showCursor ? (
        <div
          className={`es-brush ${tool === "eraser" ? "eraser" : ""} ${tool === "point" ? "point" : ""}`}
          style={{
            left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, width: `${brushW}%`, height: `${brushH}%`,
            transform: "translate(-50%, -50%)", borderColor: tool === "eraser" ? "#fff" : color,
          }}
        >{tool === "point" ? <span aria-hidden="true">{pointNext}</span> : null}</div>
      ) : null}
    </div>
  );
}

/* ================= 聚焦裁剪：拖拽框选 ================= */

function CropOverlay() {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x0: number; y0: number; q: number } | null>(null);
  const [live, setLive] = useState<Rect01 | null>(null);
  const aspect = useUi((s) => s.mediaEdit?.aspect ?? "free");
  const committed = useUi((s) => s.mediaEdit?.rect ?? null);
  const rect = live ?? committed;

  const toNorm = (e: RPointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height), q: r.width / r.height };
  };

  /** 起止点 → 归一化矩形；带比例约束时按「宽推高，超高回退」保持像素比 */
  const build = (ax: number, ay: number, bx: number, by: number, q: number): Rect01 => {
    const sx = bx >= ax ? 1 : -1;
    const sy = by >= ay ? 1 : -1;
    let w = Math.abs(bx - ax);
    let h = Math.abs(by - ay);
    if (aspect !== "free") {
      const [aw, ah] = aspect.split(":").map(Number);
      // (w·W) / (h·H) = aw/ah → h = w · (W/H) · ah/aw
      h = (w * q * ah) / aw;
      const y = sy > 0 ? ay : ay - h;
      if (y < 0 || y + h > 1) {
        h = sy > 0 ? 1 - ay : ay;
        w = (h * aw) / (q * ah);
      }
    }
    return { x: clamp01(sx > 0 ? ax : ax - w), y: clamp01(sy > 0 ? ay : ay - h), w: clamp01(w), h: clamp01(h) };
  };

  const down = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    boxRef.current?.setPointerCapture(e.pointerId);
    const p = toNorm(e);
    dragRef.current = { x0: p.x, y0: p.y, q: p.q };
    setLive({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const move = (e: RPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toNorm(e);
    setLive(build(d.x0, d.y0, p.x, p.y, d.q));
  };
  const up = (e: RPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const p = toNorm(e);
    const r = build(d.x0, d.y0, p.x, p.y, d.q);
    setLive(null);
    useUi.getState().patchMediaEdit({ rect: r.w > 0.02 && r.h > 0.02 ? r : undefined });
  };

  return (
    <div ref={boxRef} className="es-ov nodrag nowheel" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {rect && rect.w > 0.001 && rect.h > 0.001 ? (
        <div
          className="es-rect"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
        />
      ) : null}
    </div>
  );
}

/* ================= 局部重绘：蒙版涂抹 ================= */

function MaskOverlay({ src }: { src: string }) {
  const viewRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const undoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const rectStart = useRef<{ x: number; y: number } | null>(null);
  const rectCur = useRef<{ x: number; y: number } | null>(null);
  const dimsRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const tool = useUi((s) => s.mediaEdit?.tool ?? "brush");
  const brush = useUi((s) => s.mediaEdit?.brush ?? 64);
  const undoTick = useUi((s) => s.mediaEdit?.undoTick ?? 0);
  const clearTick = useUi((s) => s.mediaEdit?.clearTick ?? 0);
  const prevUndo = useRef(0);
  const prevClear = useRef(0);

  /** 显示层重绘：蒙版 → 半透明红，外加框选预览虚线 */
  const repaint = () => {
    const view = viewRef.current;
    const mask = maskRef.current;
    if (!view || !mask) return;
    const ctx = view.getContext("2d")!;
    const { w, h } = dimsRef.current;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(mask, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#ff3355";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    if (rectStart.current && rectCur.current) {
      const x = Math.min(rectStart.current.x, rectCur.current.x);
      const y = Math.min(rectStart.current.y, rectCur.current.y);
      const rw = Math.abs(rectCur.current.x - rectStart.current.x);
      const rh = Math.abs(rectCur.current.y - rectStart.current.y);
      ctx.strokeStyle = "#ff3355";
      ctx.lineWidth = Math.max(2, w / 400);
      ctx.setLineDash([w / 120, w / 160]);
      ctx.strokeRect(x, y, rw, rh);
      ctx.setLineDash([]);
    }
  };

  /** 蒙版 → 会话（空蒙版置 undefined，工具条据此禁用运行） */
  const commitMask = () => {
    const mask = maskRef.current;
    if (!mask) return;
    const data = mask.getContext("2d")!.getImageData(0, 0, mask.width, mask.height).data;
    let empty = true;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 0) {
        empty = false;
        break;
      }
    }
    useUi.getState().patchMediaEdit({ mask: empty ? undefined : mask.toDataURL("image/png") });
  };

  // 初始化：按原图自然尺寸建离屏蒙版；失败重试进会话时恢复上次蒙版
  useEffect(() => {
    let alive = true;
    void imageDims(src).then((d) => {
      if (!alive || !d) return;
      dimsRef.current = d;
      const mask = document.createElement("canvas");
      mask.width = d.w;
      mask.height = d.h;
      maskRef.current = mask;
      const view = viewRef.current;
      if (view) {
        view.width = d.w;
        view.height = d.h;
      }
      const existing = useUi.getState().mediaEdit?.mask;
      if (existing) {
        const img = new Image();
        img.onload = () => {
          if (!alive) return;
          mask.getContext("2d")!.drawImage(img, 0, 0, d.w, d.h);
          repaint();
        };
        img.src = existing;
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // 工具条「撤销一步」信号
  useEffect(() => {
    if (undoTick <= prevUndo.current) {
      prevUndo.current = undoTick;
      return;
    }
    prevUndo.current = undoTick;
    const mask = maskRef.current;
    if (!mask) return;
    const ctx = mask.getContext("2d")!;
    const prev = undoStack.current.pop();
    if (prev) ctx.putImageData(prev, 0, 0);
    else ctx.clearRect(0, 0, mask.width, mask.height);
    commitMask();
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoTick]);

  // 工具条「清空蒙版」信号
  useEffect(() => {
    if (clearTick <= prevClear.current) {
      prevClear.current = clearTick;
      return;
    }
    prevClear.current = clearTick;
    const mask = maskRef.current;
    if (!mask) return;
    pushUndo();
    mask.getContext("2d")!.clearRect(0, 0, mask.width, mask.height);
    commitMask();
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTick]);

  const pushUndo = () => {
    const mask = maskRef.current;
    if (!mask) return;
    undoStack.current.push(mask.getContext("2d")!.getImageData(0, 0, mask.width, mask.height));
    if (undoStack.current.length > 24) undoStack.current.shift();
  };

  const toNatural = (e: RPointerEvent) => {
    const r = viewRef.current!.getBoundingClientRect();
    const { w, h } = dimsRef.current;
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h };
  };

  const strokeTo = (p: { x: number; y: number }) => {
    const mask = maskRef.current;
    const from = lastPt.current;
    if (!mask || !from) return;
    const ctx = mask.getContext("2d")!;
    ctx.save();
    if (tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#fff";
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
    lastPt.current = p;
  };

  const down = (e: RPointerEvent) => {
    if (!ready || e.button !== 0) return;
    e.stopPropagation();
    viewRef.current?.setPointerCapture(e.pointerId);
    pushUndo();
    drawing.current = true;
    const p = toNatural(e);
    if (tool === "rect") {
      rectStart.current = p;
      rectCur.current = p;
    } else {
      lastPt.current = p;
      strokeTo({ x: p.x + 0.01, y: p.y }); // 单击也是一个圆点
    }
    repaint();
  };
  const move = (e: RPointerEvent) => {
    const r = viewRef.current?.getBoundingClientRect();
    // 光标存「相对画板的比例 0..1」：es-brush 在 React Flow 缩放容器内，若存视口像素会被 zoom 二次放大导致偏移
    if (r) setCursor({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    if (!drawing.current) return;
    const p = toNatural(e);
    if (tool === "rect") {
      rectCur.current = p;
      repaint();
    } else {
      strokeTo(p);
      repaint();
    }
  };
  const up = (e: RPointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    if (tool === "rect" && rectStart.current) {
      const p = toNatural(e);
      const mask = maskRef.current;
      if (mask) {
        const x = Math.min(rectStart.current.x, p.x);
        const y = Math.min(rectStart.current.y, p.y);
        const w = Math.abs(p.x - rectStart.current.x);
        const h = Math.abs(p.y - rectStart.current.y);
        if (w > 2 && h > 2) {
          const ctx = mask.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(x, y, w, h);
        }
      }
      rectStart.current = null;
      rectCur.current = null;
    }
    lastPt.current = null;
    commitMask();
    repaint();
  };

  // es-brush 全部用百分比（相对 .es-ov 局部坐标）：跟随 React Flow 一起被缩放，正好抵消，
  // 任意 zoom 下光圈中心恒定贴在鼠标上、光圈直径恒等于蒙版笔触直径
  const brushW = (brush / dimsRef.current.w) * 100;
  const brushH = (brush / dimsRef.current.h) * 100;

  return (
    <div className="es-ov nodrag nowheel" style={{ cursor: tool === "rect" ? "crosshair" : "none" }}>
      <canvas
        ref={viewRef}
        className="es-mask"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => setCursor(null)}
      />
      {tool !== "rect" && cursor && ready ? (
        <div
          className="es-brush"
          style={{
            left: `${cursor.x * 100}%`,
            top: `${cursor.y * 100}%`,
            width: `${brushW}%`,
            height: `${brushH}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
      ) : null}
    </div>
  );
}
