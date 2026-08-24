/**
 * 导演台全屏工作台 — 顶部项目栏 + 左侧流程导航 + 内容区
 *
 * 方案 §6.2/§6.3：剧本 / 分镜 / 生成 / 成片检查 / 3D 导演台是流水线关系，
 * 纵向侧边导航表达「从上到下的工作流」，顶部栏只留项目信息（名称/画幅/时长/进度）。
 * 每个页签是独立子组件，DirectorStudio 只做框架 + 路由。
 */
import { lazy, Suspense, useEffect, useState } from "react";
import "./director.css";
import { useUi } from "../../core/stores/uiStore";
import { useDirector } from "../../core/stores/directorStore";
import { useAssets } from "../../core/stores/assetStore";
import { projectProgress, mpToSize } from "../../core/directorEngine";
import { IcClose, IcText, IcClapper, IcSparkles, IcFilmCut, IcFilmFrame, IcGallery } from "../../ui/icons";
import { ScriptPage } from "./ScriptPage";
import { StoryboardPage } from "./StoryboardPage";
import { GenerationPage } from "./GenerationPage";
import { EditingPage } from "./EditingPage";
import { RecipeSelect } from "./RecipeSelect";
// three.js 体积大，3D 导演台按需懒加载（点开页签才下载/编译）
const ThreeDPage = lazy(() => import("./ThreeDPage").then((m) => ({ default: m.ThreeDPage })));
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import type { DirectorProject } from "../../core/types";

type Tab = "script" | "storyboard" | "generation" | "editing" | "threeD";

const TABS: { key: Tab; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
  { key: "script", label: "剧本", icon: <IcText size={26} /> },
  { key: "storyboard", label: "分镜", icon: <IcClapper size={26} /> },
  { key: "generation", label: "生成", icon: <IcSparkles size={26} /> },
  { key: "editing", label: "成片检查", icon: <IcFilmCut size={26} /> },
  { key: "threeD", label: "3D 导演台", icon: <IcFilmFrame size={26} /> },
];

/** 画幅选项：glyph 用真实比例的小矩形，一眼认出版式 */
const ASPECTS: { value: string; label: string; w: number; h: number }[] = [
  { value: "16:9", label: "16:9 横屏", w: 18, h: 10 },
  { value: "9:16", label: "9:16 竖屏", w: 7, h: 12 },
  { value: "1:1", label: "1:1 方形", w: 11, h: 11 },
  { value: "4:3", label: "4:3 标准", w: 14, h: 10.5 },
  { value: "21:9", label: "21:9 宽幅", w: 21, h: 9 },
];

export function DirectorStudio() {
  const open = useUi((s) => s.directorOpen);
  const nodeId = useUi((s) => s.directorNodeId);
  const close = () => useUi.getState().setDirectorOpen(false);
  const loaded = useDirector((s) => s.loaded);
  const project = useDirector((s) => s.projects.find((p) => p.nodeId === nodeId));
  const updateProject = useDirector((s) => s.updateProject);
  const [tab, setTab] = useState<Tab>("script");
  // 百万像素输入：自由文本（不设最小值限制），合法数字即写回项目
  const [mpText, setMpText] = useState(String(project?.resolutionMP ?? 1));

  useEffect(() => {
    if (open) void useDirector.getState().init();
  }, [open]);

  // B10 修复：切换项目时重置 tab 到脚本页
  useEffect(() => {
    setTab("script");
    setMpText(String(useDirector.getState().projects.find((x) => x.nodeId === nodeId)?.resolutionMP ?? 1));
  }, [nodeId]);

  if (!open) return null;

  // store 未加载完或项目不存在时显示加载/错误态（不白屏）
  if (!loaded) {
    return (
      <div className="director-studio">
        <div className="ds-loading">正在加载导演台数据…</div>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="director-studio">
        <div className="ds-loading">
          <p>未找到导演台项目（节点可能已被删除或数据损坏）。</p>
          <button className="btn sm" onClick={close}>关闭</button>
        </div>
      </div>
    );
  }

  const patch = (p: Partial<DirectorProject>) => updateProject(project.id, p);
  const mpSize = project ? mpToSize(project.aspect, project.resolutionMP ?? 1) : mpToSize("16:9", 1);

  return (
    <div className="director-studio">
      {/* 顶部项目栏：项目名 + 画幅 + 目标时长 + 进度 + 关闭 */}
      <div className="ds-header">
        <div className="ds-title-wrap">
          <input
            className="ds-title-input nodrag"
            value={project.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="未命名项目"
          />
          {/* 画幅：真实比例小矩形 + 比率，替代原生下拉 */}
          <div className="ds-aspect-seg nodrag" role="radiogroup" aria-label="画幅">
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                role="radio"
                aria-checked={project.aspect === a.value}
                className={`ds-asp ${project.aspect === a.value ? "on" : ""}`}
                title={a.label}
                onClick={() => patch({ aspect: a.value })}
              >
                <i className="ds-asp-rect" style={{ width: a.w, height: a.h }} />
                {a.value}
              </button>
            ))}
          </div>
          <label className="ds-dur">
            目标时长
            <input
              className="input sm nodrag"
              type="number"
              min={10}
              max={600}
              value={project.targetDurationSec}
              onChange={(e) => patch({ targetDurationSec: Math.max(10, Number(e.target.value) || 120) })}
            />
            秒
          </label>
          {/* 目标像素（百万）：与画幅换算宽高，生成时写入工作流（megapixels/宽/高参数）；输入不限最小值，支持小数点后两位 */}
          <div className="ds-head-mp nodrag" title="目标像素（百万）：与左侧画幅自动换算宽高，生成时写入工作流的百万像素/宽/高参数（宽高对齐 16 的倍数）">
            <span className="ds-mp-label">像素</span>
            <input
              className="input sm ds-mp-input"
              type="text"
              inputMode="decimal"
              value={mpText}
              onChange={(e) => {
                // 只放行「数字 + 最多两位小数」的输入
                const raw = e.target.value;
                if (!/^\d*\.?\d{0,2}$/.test(raw)) return;
                setMpText(raw);
                const v = Number(raw);
                if (raw.trim() !== "" && Number.isFinite(v) && v > 0) patch({ resolutionMP: Math.round(v * 100) / 100 });
              }}
              onBlur={() => {
                // 失焦规范显示：合法值补足两位小数，非法回退 1.00
                const n = Number(mpText);
                setMpText(Number.isFinite(n) && n > 0 ? n.toFixed(2) : "1.00");
              }}
            />
            <span className="ds-mp-label">百万</span>
            <span className="ds-card-desc">{mpSize.width}×{mpSize.height}</span>
          </div>
          {/* 生成配方：远程模型或本地 ComfyUI 模板（直选模板自动建配方；分镜页可按片段覆盖） */}
          <div className="ds-head-recipe nodrag">
            生成配方
            <RecipeSelect project={project} target="project" />
          </div>
        </div>
        {/* 总体进度（方案 §6.4 项目栏） */}
        <HeadProgress project={project} />
        <button className="icon-btn ds-close" title="关闭导演台" aria-label="关闭导演台" onClick={close}>
          <IcClose size={20} />
        </button>
      </div>

      {/* 主体：左侧大图标竖排导航（垂直于界面高度的大按钮）+ 页签内容 */}
      <div className="ds-body">
        <nav className="ds-sidenav">
          <div className="ds-nav-main">
            {TABS.map((t, i) => (
              <button
                key={t.key}
                className={`ds-nav-item ${tab === t.key ? "on" : ""} ${t.disabled ? "disabled" : ""}`}
                disabled={t.disabled}
                title={t.disabled ? "后期阶段开放" : t.label}
                onClick={() => !t.disabled && setTab(t.key)}
              >
                <span className="ds-nav-idx">{i + 1}</span>
                {t.icon}
                {t.label}
                {t.disabled ? <span className="ds-soon">后续</span> : null}
              </button>
            ))}
          </div>
          {/* 底部：直接打开资产库，素材可拖入/右键使用（3D 导演台的参考图等都在库里） */}
          <button
            className="ds-nav-assets"
            title="打开资产库：导演台的参考图、生成结果都在资产库里，可直接拖入使用"
            onClick={() => useAssets.getState().setOpen(true)}
          >
            <IcGallery size={24} />
            资产库
          </button>
        </nav>

        {/* 页签内容（ErrorBoundary 兜住单页崩溃，避免整树卸载白屏）；3D 导演台需要全幅无内边距 */}
        <div className={`ds-content ${tab === "threeD" ? "flush" : ""}`}>
          <ErrorBoundary name="该页签">
            {tab === "script" ? <ScriptPage project={project} /> : null}
            {tab === "storyboard" ? <StoryboardPage project={project} /> : null}
            {tab === "generation" ? <GenerationPage project={project} /> : null}
            {tab === "editing" ? <EditingPage project={project} /> : null}
            {tab === "threeD" ? (
              <Suspense fallback={<div className="ds-loading">正在加载 3D 引擎…</div>}>
                <ThreeDPage project={project} />
              </Suspense>
            ) : null}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

/** 项目栏总体进度：采用/总片段 + 迷你进度条（方案 §6.4） */
function HeadProgress({ project }: { project: DirectorProject }) {
  const p = projectProgress(project);
  if (!p.total) return null;
  const pct = Math.round((p.approved / p.total) * 100);
  return (
    <div className="ds-head-progress" title={`已采用 ${p.approved}/${p.total} 个片段 · 缺片 ${p.missing}`}>
      <div className="ds-hp-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className="ds-hp-text">
        {p.approved}/{p.total} 采用{p.missing ? ` · 缺 ${p.missing}` : ""}
      </span>
    </div>
  );
}
