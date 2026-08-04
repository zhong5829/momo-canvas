import { create } from "zustand";
import { uid } from "../utils";
import { humanizeError } from "../errorHelp";
import { notifyError } from "../sound";
import type { EditChannel, GalleryItem } from "../types";

export type Toast = { id: string; msg: string; type: "info" | "ok" | "err" };

/** 报错历史条目（报错中心） */
export type ErrLogItem = { id: string; time: number; source: string; message: string };

/** 节点图片直接编辑会话（悬浮工具条「编辑」进入）：crop=裁剪；inpaint=局部重绘；mark=标记并合成 */
export type MediaEditState = {
  nodeId: string;
  mode: "crop" | "inpaint" | "mark";
  /** inpaint：当前蒙版 dataURL（与原图同尺寸 PNG，白=重绘区），笔触松手时写回 */
  mask?: string;
  /** inpaint：涂抹工具（画笔/框选/橡皮） */
  tool: "brush" | "rect" | "eraser";
  /** inpaint：笔刷直径（原图像素） */
  brush: number;
  /** mark：彩色标记工具与当前合成层 */
  markTool: "brush" | "point" | "rect" | "roundRect" | "eraser";
  markColor: string;
  markOpacity: number;
  mark?: string;
  /** inpaint：「把选区改成什么」提示词 */
  prompt: string;
  /** inpaint：模型通道（默认 auto） */
  channel: EditChannel;
  /** crop：框选比例约束（free = 自由） */
  aspect: string;
  /** crop：当前框选（归一化 0-1），松手时写回 */
  rect?: { x: number; y: number; w: number; h: number };
  /** 工具条按钮 → EditSurface 的动作信号（+1 触发一次） */
  undoTick: number;
  clearTick: number;
};

export type AddMenuState = {
  /** 画布 flow 坐标（落点） */
  flowX: number;
  flowY: number;
  /** 屏幕坐标（菜单定位） */
  screenX: number;
  screenY: number;
  /** 从某个输出拖线松手时：来源节点，用于自动连线 */
  sourceNode?: string;
  sourcePort?: "text" | "image" | "video" | "audio";
} | null;

type UiState = {
  zen: boolean;
  /** Agent 模式：全屏对话式创作，覆盖画布 */
  agentOpen: boolean;
  galleryOpen: boolean;
  settingsOpen: boolean;
  settingsTab: string;
  /** 设置里的服务商编辑浮出面板是否打开（主窗口需要让位左移） */
  sideEditorOpen: boolean;
  templateMgrOpen: boolean;
  /** 打开模板管理器时要直接进入编辑的模板 id（设置页卡片「编辑」用） */
  templateMgrEdit: string | null;
  /** 角色库弹层（人物预设） */
  charLibOpen: boolean;
  lightbox: string | null;
  /** 灯箱对比模式的「原图」：非空时灯箱显示前后对比滑块 */
  lightboxBefore: string | null;
  /** 灯箱内容类型：video 时用 <video> 播放（节点上只显示封面帧，点开才真正播放） */
  lightboxKind: "image" | "video";
  /** 顺序预览播放列表（时间线粗剪「预览成片」）：非空时全屏播放器逐段自动连播 */
  seqPreview: string[] | null;
  addMenu: AddMenuState;
  gallery: GalleryItem[];
  toasts: Toast[];
  /** 报错历史（报错中心） */
  errlog: ErrLogItem[];
  errlogOpen: boolean;
  /** 运行日志面板开关（标题栏按钮与快捷键共用） */
  runLogOpen: boolean;
  setRunLogOpen: (v: boolean) => void;
  errlogUnread: number;
  /** 拖拽中将要自动连线的两个节点 id（高亮提示） */
  proxHint: string[] | null;
  /** 拖动吸附对齐的参考线（flow 坐标：x = 竖线，y = 横线；null = 不显示） */
  alignGuides: { x: number | null; y: number | null } | null;
  /** 当前工具：move = 移动工具（左键拖空白平移）；select = 框选模式 */
  tool: "move" | "select";
  /** 建组模式：在画布上框画区域成组 */
  groupDraw: boolean;
  /** 拖动节点后抑制生成设置面板（只有点击节点才重新显示） */
  genPanelSuppressed: boolean;
  /** 进行中的节点图片直接编辑会话（裁剪框选 / 蒙版涂抹）；同时只允许一个 */
  mediaEdit: MediaEditState | null;
  /** 全屏图片分层工作台当前来源节点；不创建处理节点 */
  layerEditorNodeId: string | null;
  /** 打开中的「上游传入」预览弹窗（节点 id 列表） */
  upPop: string[];
  /** 弹窗锁定：锁定后预览弹窗不因点击画布/其他节点而收起（全局生效） */
  popLock: boolean;
  /** 画布内搜索节点（Ctrl+F） */
  searchOpen: boolean;
  /** Spotlight 快速添加（Ctrl+K）：搜索节点/模板并添加到画布 */
  spotlightOpen: boolean;
  /** AI 布线助手：一句话生成工作流方案 */
  aiWireOpen: boolean;

  toggleUpPop: (id: string) => void;
  closeUpPop: (id: string) => void;
  togglePopLock: () => void;
  setSearchOpen: (v: boolean) => void;
  setSpotlightOpen: (v: boolean) => void;
  setAiWireOpen: (v: boolean) => void;
  toggleZen: () => void;
  setAgentOpen: (v: boolean) => void;
  setGenPanelSuppressed: (v: boolean) => void;
  setGalleryOpen: (v: boolean) => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  setSideEditorOpen: (v: boolean) => void;
  setTemplateMgr: (v: boolean, editId?: string | null) => void;
  setCharLibOpen: (v: boolean) => void;
  setLightbox: (src: string | null, before?: string | null, kind?: "image" | "video") => void;
  setSeqPreview: (urls: string[] | null) => void;
  setAddMenu: (v: AddMenuState) => void;
  setProxHint: (ids: string[] | null) => void;
  setAlignGuides: (g: { x: number | null; y: number | null } | null) => void;
  toggleTool: () => void;
  setGroupDraw: (v: boolean) => void;
  /** 进入节点图片直接编辑（同一时刻仅一个会话；重复进入同节点同模式 = 无操作） */
  openMediaEdit: (nodeId: string, mode: "crop" | "inpaint" | "mark") => void;
  patchMediaEdit: (p: Partial<MediaEditState>) => void;
  closeMediaEdit: () => void;
  setLayerEditorNodeId: (id: string | null) => void;
  addGallery: (item: Omit<GalleryItem, "id" | "time">) => void;
  toast: (msg: string, type?: Toast["type"]) => void;
  /** 记录一次报错：进报错中心 + 弹可点击的错误弹窗 */
  pushError: (source: string, message: string) => void;
  setErrlogOpen: (v: boolean) => void;
  clearErrlog: () => void;
};

export const useUi = create<UiState>((set) => ({
  zen: false,
  agentOpen: false,
  galleryOpen: false,
  settingsOpen: false,
  settingsTab: "models",
  sideEditorOpen: false,
  templateMgrOpen: false,
  templateMgrEdit: null,
  charLibOpen: false,
  lightbox: null,
  lightboxBefore: null,
  lightboxKind: "image",
  seqPreview: null,
  addMenu: null,
  gallery: [],
  toasts: [],
  errlog: [],
  errlogOpen: false,
  runLogOpen: false,
  setRunLogOpen: (v) => set({ runLogOpen: v }),
  errlogUnread: 0,
  proxHint: null,
  alignGuides: null,
  tool: "move",
  groupDraw: false,
  genPanelSuppressed: false,
  mediaEdit: null,
  layerEditorNodeId: null,
  upPop: [],
  popLock: false,
  searchOpen: false,
  spotlightOpen: false,
  aiWireOpen: false,

  setSearchOpen: (v) => set({ searchOpen: v }),
  setSpotlightOpen: (v) => set({ spotlightOpen: v }),
  setAiWireOpen: (v) => set({ aiWireOpen: v }),

  toggleUpPop: (id) =>
    set((s) => ({ upPop: s.upPop.includes(id) ? s.upPop.filter((x) => x !== id) : [...s.upPop, id] })),
  closeUpPop: (id) => set((s) => (s.upPop.includes(id) ? { upPop: s.upPop.filter((x) => x !== id) } : s)),
  togglePopLock: () => set((s) => ({ popLock: !s.popLock })),
  toggleZen: () => set((s) => ({ zen: !s.zen })),
  setAgentOpen: (v) => set({ agentOpen: v }),
  setGenPanelSuppressed: (v) =>
    set((s) => (s.genPanelSuppressed === v ? s : { genPanelSuppressed: v })),
  setGalleryOpen: (v) => set({ galleryOpen: v }),
  openSettings: (tab) => set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) }),
  closeSettings: () => set({ settingsOpen: false, sideEditorOpen: false }),
  setSideEditorOpen: (v) => set({ sideEditorOpen: v }),
  setTemplateMgr: (v, editId) => set({ templateMgrOpen: v, templateMgrEdit: v ? (editId ?? null) : null }),
  setCharLibOpen: (v) => set({ charLibOpen: v }),
  setLightbox: (src, before, kind) =>
    set({ lightbox: src, lightboxBefore: src ? (before ?? null) : null, lightboxKind: src ? (kind ?? "image") : "image" }),
  setSeqPreview: (urls) => set({ seqPreview: urls?.length ? urls : null }),
  setAddMenu: (v) => set({ addMenu: v }),

  setProxHint: (ids) =>
    set((s) => {
      // 拖拽中每帧都会算一次，内容没变就不触发渲染
      if (s.proxHint === ids || (s.proxHint && ids && s.proxHint.join() === ids.join())) return s;
      return { proxHint: ids };
    }),
  setAlignGuides: (g) =>
    set((s) => {
      // 拖拽中每帧都会算一次，内容没变就不触发渲染
      if (s.alignGuides === g || (!s.alignGuides && !g)) return s;
      if (s.alignGuides && g && s.alignGuides.x === g.x && s.alignGuides.y === g.y) return s;
      return { alignGuides: g };
    }),

  toggleTool: () => set((s) => ({ tool: s.tool === "move" ? "select" : "move" })),
  setGroupDraw: (v) => set({ groupDraw: v }),

  openMediaEdit: (nodeId, mode) =>
    set((s) => ({
      // 保留上一次会话的笔刷/通道/工具习惯
      mediaEdit: {
        nodeId,
        mode,
        tool: s.mediaEdit?.tool === "rect" || s.mediaEdit?.tool === "eraser" ? s.mediaEdit.tool : "brush",
        brush: s.mediaEdit?.brush ?? 64,
        markTool: s.mediaEdit?.markTool ?? "brush",
        markColor: s.mediaEdit?.markColor ?? "#ff3158",
        markOpacity: s.mediaEdit?.markOpacity ?? 0.92,
        prompt: "",
        channel: s.mediaEdit?.channel ?? "auto",
        aspect: "free",
        undoTick: 0,
        clearTick: 0,
      },
    })),
  patchMediaEdit: (p) => set((s) => (s.mediaEdit ? { mediaEdit: { ...s.mediaEdit, ...p } } : s)),
  closeMediaEdit: () => set({ mediaEdit: null }),
  setLayerEditorNodeId: (id) => set({ layerEditorNodeId: id, mediaEdit: null }),

  addGallery: (item) =>
    set((s) => ({ gallery: [{ ...item, id: uid(), time: Date.now() }, ...s.gallery].slice(0, 200) })),

  toast: (msg, type = "info") => {
    const id = uid(6);
    set((s) => ({ toasts: [...s.toasts, { id, msg, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, type === "err" ? 6000 : 3000);
    if (type === "err") console.warn("[toast]", msg);
  },

  pushError: (source, message) => {
    // 常见英文/网络报错先翻译成中文；原文保留在报错中心供排查
    const tip = humanizeError(message);
    const full = tip ? `${tip}\n—— 原始报错：${message}` : message;
    set((s) => ({
      errlog: [{ id: uid(6), time: Date.now(), source, message: full }, ...s.errlog].slice(0, 100),
      errlogUnread: s.errlogOpen ? s.errlogUnread : s.errlogUnread + 1,
    }));
    useUi.getState().toast(`${source}：${tip ?? message}`, "err");
    notifyError(source);
  },

  setErrlogOpen: (v) => set((s) => ({ errlogOpen: v, errlogUnread: v ? 0 : s.errlogUnread })),
  clearErrlog: () => set({ errlog: [], errlogUnread: 0 }),
}));

export const toast = (msg: string, type?: Toast["type"]) => useUi.getState().toast(msg, type);

/** 运行类报错统一入口：写入报错中心（点错误弹窗可查看历史） */
export const pushError = (source: string, message: string) => useUi.getState().pushError(source, message);
