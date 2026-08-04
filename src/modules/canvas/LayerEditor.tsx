import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { pushError, toast, useUi } from "../../core/stores/uiStore";
import { analyzeLayers, completeBackgroundWithModel, exportLayeredPsd, exportLayeredTiff, exportLayerPng, type LayerDocument } from "../../core/layering";
import { nodeMainImage } from "../../core/nodeEdit";
import { Thumb } from "../../ui/Thumb";
import { IcCheck, IcClose, IcDownload, IcEyeOff, IcLayers, IcLoading, IcRefresh } from "../../ui/icons";
import { errMsg } from "../../core/utils";

const ROLE_LABEL = { background: "背景", title: "标题", subtitle: "副标题", subject: "主体", element: "元素" } as const;

export function LayerEditor() {
  const nodeId = useUi((s) => s.layerEditorNodeId);
  const close = useUi((s) => s.setLayerEditorNodeId);
  const src = useBoard((s) => nodeMainImage(s.nodes.find((n) => n.id === nodeId)));
  const [doc, setDoc] = useState<LayerDocument | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState({ message: "", pct: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dpi, setDpi] = useState(300);
  const dialogRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async () => {
    if (!src) return;
    setBusy(true);
    setError(null);
    setDoc(null);
    setSelected(null);
    try {
      // 让加载状态先完成一次绘制，再进入像素分析。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = await analyzeLayers(src, (message, pct) => setProgress({ message, pct }));
      setDoc(result);
      setSelected(result.layers.find((layer) => layer.role !== "background")?.id ?? result.layers[0]?.id ?? null);
    } catch (e) {
      const message = errMsg(e);
      setError(message);
      pushError("智能分层", message);
    } finally {
      setBusy(false);
    }
  }, [src]);

  useEffect(() => {
    if (!nodeId || !src) return;
    void run();
  }, [nodeId, src, run]);

  // 对话框焦点管理：Esc 关闭、Tab 留在工作台内，关闭后由原按钮自然恢复焦点。
  useEffect(() => {
    if (!nodeId) return;
    const root = dialogRef.current;
    root?.querySelector<HTMLElement>("button, input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nodeId, close]);

  const active = useMemo(() => doc?.layers.find((layer) => layer.id === selected) ?? null, [doc, selected]);

  if (!nodeId) return null;

  const patchLayer = (id: string, patch: Partial<LayerDocument["layers"][number]>) => {
    setDoc((current) => current ? { ...current, layers: current.layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer) } : current);
  };

  const exportFile = async (format: "psd" | "tiff" | "png") => {
    if (!doc || (format === "png" && !active)) return;
    setBusy(true);
    try {
      const path = format === "psd" ? await exportLayeredPsd(doc, dpi) : format === "tiff" ? await exportLayeredTiff(doc, dpi) : await exportLayerPng(active!);
      toast(`${format === "png" ? "图层" : "分层文件"}已导出 → ${path}`, "ok");
    } catch (e) {
      if (errMsg(e) !== "已取消导出") pushError("分层导出", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const modelComplete = async () => {
    if (!doc) return;
    setBusy(true);
    setProgress({ message: "生成模型正在补全遮挡背景…", pct: 56 });
    try {
      const next = await completeBackgroundWithModel(doc);
      setDoc(next);
      setSelected(next.layers.find((layer) => layer.role === "background")?.id ?? selected);
      toast("背景遮挡区已由生成模型补全；未遮挡像素保持原图", "ok");
    } catch (e) {
      pushError("背景模型补全", errMsg(e));
    } finally {
      setBusy(false);
      setProgress({ message: "", pct: 100 });
    }
  };

  return (
    <div className="le-overlay" role="presentation" onPointerDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div ref={dialogRef} className="le-dialog" role="dialog" aria-modal="true" aria-labelledby="le-title">
        <header className="le-head">
          <div>
            <h2 id="le-title"><IcLayers size={18} /> 智能分层</h2>
            <p>语义识别、边缘细化与背景遮挡补全；不创建新节点 · 视觉识别会使用已配置模型并可能计费</p>
          </div>
          <button className="icon-btn" aria-label="关闭智能分层" title="关闭（Esc）" onClick={() => close(null)}><IcClose size={16} /></button>
        </header>

        <div className="le-main">
          <section className="le-preview" aria-label="图层预览">
            <div className="le-stage">
              {active ? <Thumb src={active.src} alt={`${active.name}图层预览`} /> : src ? <Thumb src={src} alt="原图预览" /> : null}
              {active ? <span className="le-stage-label">{active.name}</span> : null}
            </div>
            {busy ? (
              <div className="le-progress" aria-live="polite" aria-atomic="true">
                <IcLoading size={20} />
                <strong>{progress.message || "正在处理…"}</strong>
                <div><i style={{ width: `${progress.pct}%` }} /></div>
                <span>{progress.pct}%</span>
              </div>
            ) : null}
            {error ? <div className="le-error" role="alert">{error}<button className="btn" onClick={() => void run()}><IcRefresh size={13} /> 重试</button></div> : null}
          </section>

          <aside className="le-side">
            <div className="le-side-title">
              <span>图层</span>
              <b>{doc?.layers.length ?? 0}</b>
            </div>
            <div className="le-list">
              {doc?.layers.map((layer) => (
                <div
                  key={layer.id}
                  role="button"
                  tabIndex={0}
                  className={`le-layer ${selected === layer.id ? "on" : ""}`}
                  aria-pressed={selected === layer.id}
                  onClick={() => setSelected(layer.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(layer.id);
                    }
                  }}
                >
                  <span className="le-thumb"><Thumb src={layer.src} alt="" /></span>
                  <span className="le-layer-text">
                    <input
                      aria-label={`${ROLE_LABEL[layer.role]}图层名称`}
                      value={layer.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patchLayer(layer.id, { name: e.target.value })}
                    />
                    <small>{ROLE_LABEL[layer.role]} · 置信度 {Math.round(layer.confidence * 100)}%{layer.completed ? " · 已补全" : ""}</small>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className={`le-eye ${layer.visible ? "on" : ""}`}
                    aria-label={layer.visible ? `隐藏${layer.name}` : `显示${layer.name}`}
                    onClick={(e) => { e.stopPropagation(); patchLayer(layer.id, { visible: !layer.visible }); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); patchLayer(layer.id, { visible: !layer.visible }); } }}
                  >
                    {layer.visible ? <IcCheck size={13} /> : <IcEyeOff size={13} />}
                  </span>
                </div>
              ))}
            </div>
            {doc ? <div className="le-report">{doc.report.map((line) => <p key={line}>{line}</p>)}</div> : null}
          </aside>
        </div>

        <footer className="le-foot">
          <label>DPI <input type="number" min={72} max={1200} step={1} value={dpi} onChange={(e) => setDpi(Math.max(72, Math.min(1200, Number(e.target.value) || 300)))} /></label>
          <button className="btn" disabled={busy || !doc} onClick={() => void run()}><IcRefresh size={13} /> 重新识别</button>
          <button className="btn" disabled={busy || !doc} title="调用默认图像生成模型，可能产生模型费用" onClick={() => void modelComplete()}><IcLayers size={13} /> 模型补全背景</button>
          <span className="le-spacer" />
          <button className="btn" disabled={busy || !active} onClick={() => void exportFile("png")}><IcDownload size={13} /> 提取 PNG</button>
          <button className="btn" disabled={busy || !doc} onClick={() => void exportFile("tiff")}><IcDownload size={13} /> 分层 TIFF</button>
          <button className="btn primary" disabled={busy || !doc} onClick={() => void exportFile("psd")}><IcDownload size={13} /> 导出 PSD</button>
        </footer>
      </div>
    </div>
  );
}
