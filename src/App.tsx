import { useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { LayerEditor } from "./modules/canvas/LayerEditor";
import { Titlebar } from "./modules/shell/Titlebar";
import { SmartCanvas } from "./modules/canvas/SmartCanvas";
import { AgentPanel } from "./modules/agent/AgentPanel";
import { GalleryDock } from "./modules/shell/GalleryDock";
import { SettingsDialog } from "./modules/settings/SettingsDialog";
import { TemplateManager } from "./modules/comfy/TemplateManager";
import { AssetLibrary } from "./modules/assets/AssetLibrary";
import { CharLibrary } from "./modules/charlib/CharLibrary";
import { SkillManager } from "./modules/skills/SkillManager";
import { DirectorStudio } from "./modules/director/DirectorStudio";
import { GgufImportDialog } from "./modules/settings/GgufImportDialog";
import { LocalLlmSetup } from "./modules/settings/LocalLlmSetup";
import { useSettings } from "./core/stores/settingsStore";
import { useBoard } from "./core/stores/boardStore";
import { useComfy } from "./core/stores/comfyStore";
import { useAssets } from "./core/stores/assetStore";
import { useDirector } from "./core/stores/directorStore";
import { useSkills } from "./core/stores/skillStore";
import { useLocalGguf } from "./core/stores/localGgufStore";
import { recoverInterruptedTasks } from "./core/directorQueue";
import { useTemplates } from "./core/stores/templateStore";
import { useAgent } from "./core/stores/agentStore";
import { useGenPref } from "./core/stores/genPrefStore";
import { useUsage } from "./core/stores/usageStore";
import { toast, useUi } from "./core/stores/uiStore";
import { autoCheckOnStart, isPortable } from "./core/services/updater";
import { isTauri } from "./core/utils";
import { IcLogo, IcMin, IcPlus } from "./ui/icons";

function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const setErrlogOpen = useUi((s) => s.setErrlogOpen);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type === "err" ? "err" : t.type === "ok" ? "ok" : ""}`}
          title={t.type === "err" ? "点击查看报错历史" : undefined}
          onClick={t.type === "err" ? () => setErrlogOpen(true) : undefined}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

/** 前后对比：拖动分割线擦看原图 ↔ 结果 */
function CompareWipe({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      className="cmp-wipe"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = e.currentTarget.getBoundingClientRect();
        setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
      }}
      onPointerMove={move}
    >
      <img src={after} alt="" draggable={false} />
      <img src={before} alt="" draggable={false} className="cw-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="cw-bar" style={{ left: `${pos}%` }}>
        <i>⟷</i>
      </div>
      <span className="cw-tag l">原图</span>
      <span className="cw-tag r">结果</span>
    </div>
  );
}

/**
 * 灯箱（全屏预览）— 普通图片支持滚轮缩放（0.5~10 倍，以指针为中心）、放大后拖动平移、
 * 双击 3 倍/复位、Esc 关闭、0 复位、右下角工具条；有「原图」时仍可切换前后对比滑块（对比模式不缩放）。
 */
function Lightbox() {
  const src = useUi((s) => s.lightbox);
  const before = useUi((s) => s.lightboxBefore);
  const kind = useUi((s) => s.lightboxKind);
  const set = useUi((s) => s.setLightbox);
  const list = useUi((s) => s.lightboxList);
  const setList = useUi((s) => s.setLightboxList);
  const [comparing, setComparing] = useState(false);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  useEffect(() => {
    setComparing(false);
    setScale(1);
    setTx(0);
    setTy(0);
  }, [src]);

  // Esc 关闭；0 复位缩放
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        set(null);
        setList(null);
      }
      if (e.key === "0") {
        setScale(1);
        setTx(0);
        setTy(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, set, setList]);

  if (!src) return null;
  if (list) {
    // 对比视图：同节点多张结果并排（点某张切到单图放大模式；Esc/点背景关闭）
    return (
      <div className="lightbox" onClick={() => setList(null)}>
        <div className="lb-grid" onClick={(e) => e.stopPropagation()}>
          <div className="lb-grid-title">对比视图 · {list.length} 张（点图放大查看 · Esc 关闭）</div>
          <div className="lb-grid-body">
            {list.map((s, i) => (
              <img
                key={i}
                src={s}
                alt=""
                onClick={() => {
                  setList(null);
                  set(s);
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="lightbox" onClick={() => set(null)}>
        <video src={src} controls autoPlay onClick={(e) => e.stopPropagation()} />
      </div>
    );
  }

  const zoomed = scale !== 1;
  const clampScale = (v: number) => Math.min(10, Math.max(0.5, v));
  /** 平移钳制：图片放大后不允许被拖出视野（offsetWidth 是布局宽，乘 scale 才是视觉宽） */
  const clampT = (x: number, y: number) => {
    const el = imgRef.current;
    const r = stageRef.current;
    if (!el || !r) return { x, y };
    const maxX = Math.max(0, (el.offsetWidth * scale - r.clientWidth) / 2);
    const maxY = Math.max(0, (el.offsetHeight * scale - r.clientHeight) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };
  const setPos = (x: number, y: number) => {
    const c = clampT(x, y);
    setTx(c.x);
    setTy(c.y);
  };

  /** 滚轮缩放：以指针位置为中心（指针下的画面内容保持不动） */
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    const ns = clampScale(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    const px = e.clientX - r.left - tx;
    const py = e.clientY - r.top - ty;
    setScale(ns);
    setPos(e.clientX - r.left - px * (ns / scale), e.clientY - r.top - py * (ns / scale));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomed) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos(d.tx + e.clientX - d.x, d.ty + e.clientY - d.y);
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  /** 双击：未放大 → 3 倍（指针为中心）；已放大 → 复位 */
  const onDblClick = (e: React.MouseEvent) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    if (zoomed) {
      setScale(1);
      setTx(0);
      setTy(0);
      return;
    }
    const ns = 3;
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    setScale(ns);
    setPos(px - px * ns, py - py * ns);
  };

  /** 工具条 +/−：以视口中心为锚缩放 */
  const zoomBy = (f: number) => {
    const r = stageRef.current?.getBoundingClientRect();
    const cx = r ? r.width / 2 : window.innerWidth / 2;
    const cy = r ? r.height / 2 : window.innerHeight / 2;
    const ns = clampScale(scale * f);
    const px = cx - tx;
    const py = cy - ty;
    setScale(ns);
    setPos(cx - px * (ns / scale), cy - py * (ns / scale));
  };

  return (
    <div className="lightbox" onClick={() => set(null)}>
      {before && comparing ? (
        <CompareWipe before={before} after={src} />
      ) : (
        <div
          ref={stageRef}
          className="lb-stage"
          onClick={(e) => e.stopPropagation()}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, cursor: zoomed ? "grab" : "zoom-in" }}
            onClick={() => {
              // 已放大时单击图片不关（拖动结束的 click 会误关）；未放大保持「单击关闭」
              if (!zoomed) set(null);
            }}
            onDoubleClick={onDblClick}
          />
        </div>
      )}
      {/* 缩放工具条（右下角；对比模式不显示） */}
      {!(before && comparing) ? (
        <div className="lb-zoom glass" onClick={(e) => e.stopPropagation()}>
          <button className="btn sm" title="缩小" onClick={() => zoomBy(1 / 1.2)}>
            <IcMin size={14} />
          </button>
          <span title="当前缩放">{Math.round(scale * 100)}%</span>
          <button className="btn sm" title="放大" onClick={() => zoomBy(1.2)}>
            <IcPlus size={14} />
          </button>
          <span className="lb-zoom-sep" />
          <button
            className="btn sm"
            title="适应窗口（Esc 关闭 · 数字 0 复位）"
            onClick={() => {
              setScale(1);
              setTx(0);
              setTy(0);
            }}
          >
            适应
          </button>
        </div>
      ) : null}
      {before ? (
        <button
          className="btn lb-cmp"
          onClick={(e) => {
            e.stopPropagation();
            setComparing(!comparing);
          }}
        >
          {comparing ? "退出对比" : "⟷ 对比原图"}
        </button>
      ) : null}
    </div>
  );
}

/** 顺序预览播放器：时间线粗剪「预览成片」——按片段顺序自动连播，拼接前先看效果 */
function SeqPlayer() {
  const urls = useUi((s) => s.seqPreview);
  const set = useUi((s) => s.setSeqPreview);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [urls]);
  if (!urls?.length) return null;
  const idx = Math.min(i, urls.length - 1);
  return (
    <div className="lightbox" onClick={() => set(null)}>
      <div className="seq-wrap" onClick={(e) => e.stopPropagation()}>
        <video
          key={idx}
          src={urls[idx]}
          controls
          autoPlay
          onEnded={() => {
            if (idx < urls.length - 1) setI(idx + 1);
          }}
        />
        <div className="seq-bar glass">
          <button className="btn sm" disabled={idx === 0} style={{ opacity: idx === 0 ? 0.4 : 1 }} onClick={() => setI(idx - 1)}>
            上一段
          </button>
          <span>
            第 {idx + 1} / {urls.length} 段 · 播完自动接下一段
          </span>
          <button
            className="btn sm"
            disabled={idx === urls.length - 1}
            style={{ opacity: idx === urls.length - 1 ? 0.4 : 1 }}
            onClick={() => setI(idx + 1)}
          >
            下一段
          </button>
          <button className="btn sm" onClick={() => set(null)}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const agentOpen = useUi((s) => s.agentOpen);

  useEffect(() => {
    void Promise.all([
      useSettings.getState().init(),
      // 本地 GGUF 模型注册表：必须在 settingsStore.init 之后（resolveModelCard 注入虚拟服务商时读取它）
      // 但 settingsStore.init 内部已 fire-and-forget 调了 useLocalGguf.init()，
      // 这里显式再调一次保证 loaded（initOnce 幂等，不会重复加载）
      useLocalGguf.getState().init(),
      useBoard.getState().init(),
      useComfy.getState().init(),
      useAssets.getState().init(),
      useTemplates.getState().init(),
      useAgent.getState().initPrefs(),
      useGenPref.getState().init(),
      useUsage.getState().init(),
      useDirector.getState().init(),
      useSkills.getState().init(),
    ]).then(() => {
      // 导演台：恢复上次中断的任务（运行中的标中断，不静默重置）
      const n = recoverInterruptedTasks();
      if (n) toast(`导演台：上次有 ${n} 个任务被中断，请到导演台查看`, "info");
      setReady(true);
    });
    // 便携版首次启动：在桌面创建快捷方式（安装版由安装器负责，跳过）
    // localStorage 标记 + Rust 端「.lnk 存在即跳过」双保险；失败不写标记，下次启动再试
    void (async () => {
      try {
        if (!isTauri || localStorage.getItem("momo:desktop-shortcut")) return;
        if (!(await isPortable())) return;
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<{ created: boolean }>("create_desktop_shortcut", {
          name: "MOMO 智能画布",
        });
        localStorage.setItem("momo:desktop-shortcut", "1");
        if (r.created) toast("已为便携版创建桌面快捷方式", "ok");
      } catch {
        /* 创建失败不打扰用户（可能被安全软件拦截），下次启动重试 */
      }
    })();
    // 启动 5 秒后静默检查一次更新（失败不打扰）
    const t = setTimeout(() => {
      void autoCheckOnStart((info) => {
        toast(`发现新版本 v${info.version} —— 到「设置 → 关于与更新」一键升级`, "info");
      });
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  /* 屏蔽 webview 默认右键菜单（右键用于平移画布）与 Ctrl+滚轮页面缩放 */
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  if (!ready) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IcLogo size={56} />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <Titlebar />
      <SmartCanvas />
      {agentOpen ? <AgentPanel /> : null}
      <GalleryDock />
      <SettingsDialog />
      <TemplateManager />
      <AssetLibrary />
      <CharLibrary />
      <SkillManager />
      <DirectorStudio />
      <GgufImportDialog />
      <LocalLlmSetup />
      <Lightbox />
      <SeqPlayer />
      <LayerEditor />
      <Toasts />
    </ReactFlowProvider>
  );
}
