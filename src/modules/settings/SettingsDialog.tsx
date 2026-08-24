/**
 * 设置面板 — 模型配置（多套卡片） / 联网搜索 / 图片保存 / ComfyUI / 外观
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal, Field, Switch, Row } from "../../ui/kit";
import { PopSelect } from "../../ui/PopSelect";
import { ModelPicker } from "../../ui/ModelPicker";
import { flattenCard, modelKey, resolveModelCard, splitModelKey, useSettings } from "../../core/stores/settingsStore";
import { useComfy, useComfyTemplates } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { useUsage } from "../../core/stores/usageStore";
import { chatOnce } from "../../core/services/llm";
import { freeComfyMemory, freeResultText } from "../../core/services/comfy";
import { fetchModelList } from "../../core/services/modelList";
import { calibrateProtocol } from "../../core/services/protoCalibrate";
import { placeholdersIn, protoFingerprint, unknownPlaceholders, validateProto, varList, varsDoc } from "../../core/services/protoSpec";
import { MANUAL, useProtoTab } from "./protoTabStore";
import { xfetch } from "../../core/services/http";
import { errMsg, isTauri, parseJsonLoose, uid } from "../../core/utils";
import { importTemplateFilesAuto, packTemplates, saveTextFile } from "../comfy/templateIO";
import {
  IcBlack,
  IcBulb,
  IcChat,
  IcCheck,
  IcBroom,
  IcChevronD,
  IcClose,
  IcDownload,
  IcEdit,
  IcFlow,
  IcFolder,
  IcGallery,
  IcGear,
  IcGlobe,
  IcKeyboard,
  IcLoading,
  IcMoon,
  IcMic,
  IcMusic,
  IcPlay,
  IcPlus,
  IcSearch,
  IcSparkles,
  IcSun,
  IcTrash,
  IcUpload,
  IcUpscale,
  IcVideo,
  IcWarn,
} from "../../ui/icons";
import { EnhanceModelsTab } from "./EnhanceModelsTab";
import { IcLogo } from "../../ui/icons";
import { IcWand } from "../../ui/icons";
import { checkUpdate, currentVersion, isPortable, GH_REPO, type UpdateInfo } from "../../core/services/updater";
import { PROTO_PRESETS, applyProtoPreset } from "../../core/protoPresets";
import { OLLAMA_PRESET, PROVIDER_PRESETS, buildPresetProvider, type ProviderPreset } from "../../core/providerPresets";
import { useLocalGguf } from "../../core/stores/localGgufStore";
import { GgufManageDialog } from "./GgufImportDialog";
import { SEARCH_PROVIDERS } from "../../core/services/webSearch";
import { openExternal } from "../../core/external";
import { playDone, playError } from "../../core/sound";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_LABEL,
  PROTOCOLS,
  ROLE_LABEL,
  type AnyProtocol,
  type CustomProtocol,
  type HotkeyAction,
  type ModelRole,
  type ProviderCard,
  type RoleSlot,
  type SearchProvider,
  type Settings,
  type SoundCfg,
} from "../../core/types";

const TABS = [
  { key: "models", label: "模型配置", icon: <IcSparkles size={17} /> },
  { key: "protocols", label: "协议", icon: <IcFlow size={17} /> },
  { key: "search", label: "联网搜索", icon: <IcGlobe size={17} /> },
  { key: "save", label: "图片保存", icon: <IcGallery size={17} /> },
  { key: "enhanceModels", label: "超清模型", icon: <IcUpscale size={17} /> },
  { key: "comfy", label: "ComfyUI", icon: <IcFlow size={17} /> },
  { key: "sound", label: "音效提醒", icon: <IcMusic size={17} /> },
  { key: "hotkeys", label: "快捷键", icon: <IcKeyboard size={17} /> },
  { key: "appearance", label: "外观主题", icon: <IcSun size={17} /> },
  { key: "usage", label: "用量与稳定性", icon: <IcGallery size={17} /> },
  { key: "about", label: "关于与更新", icon: <IcLogo size={17} /> },
];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const close = useUi((s) => s.closeSettings);
  const openSettings = useUi((s) => s.openSettings);
  const shifted = useUi((s) => s.sideEditorOpen);
  if (!open) return null;
  return (
    <Modal title="设置" onClose={close} width={1180} className={shifted ? "shifted" : ""}>
      <div className="settings-body">
        <div className="settings-nav">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => openSettings(t.key)}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-content">
          {tab === "models" && <ModelsTab />}
          {tab === "protocols" && <ProtocolTab />}
          {tab === "search" && <SearchTab />}
          {tab === "save" && <SaveTab />}
          {tab === "enhanceModels" && <EnhanceModelsTab />}
          {tab === "comfy" && <ComfyTab />}
          {tab === "sound" && <SoundTab />}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "usage" && <UsageTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}

/* ================= 配置导出 / 导入 ================= */

/** 写文本到用户选择的位置（Tauri 存盘对话框 / 浏览器下载） */
async function saveTextAs(text: string, filename: string) {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = filename.split(".").pop() ?? "json";
    const path = await save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, text);
    return path;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return filename;
}

/**
 * 导出配置：
 *  - stripKeys=true（默认，给别人/传网盘）：所有 API Key 置空并打 __keysStripped 标记，
 *    接收方导入后填自己的 Key；自己导入时本机已有的 Key 自动保留。
 *  - stripKeys=false（分享给信任的人直接用）：整份配置 AES 加密成分享包，
 *    文件里看不到明文密钥，接收方导入即可用（注意：能用就意味着技术上能被提取，只防翻看）。
 */
async function exportCfg(stripKeys: boolean) {
  try {
    const s = useSettings.getState().settings;
    if (stripKeys) {
      const cleaned = {
        ...s,
        models: { ...s.models, providers: s.models.providers.map((p) => ({ ...p, apiKey: "" })) },
        search: { ...s.search, apiKey: "" },
        __keysStripped: true,
      };
      const path = await saveTextAs(JSON.stringify(cleaned, null, 2), "momo-settings.json");
      if (path) toast(`配置已导出（已抹去全部 API Key）→ ${path}`, "ok");
    } else {
      const { encryptCfg } = await import("../../core/cfgCrypto");
      const pkg = await encryptCfg(JSON.stringify(s));
      const path = await saveTextAs(JSON.stringify(pkg), "momo-settings.momocfg");
      if (path) toast(`加密分享包已导出 → ${path}（含密钥，只发给信任的人）`, "ok");
    }
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

async function importCfg() {
  try {
    let text = "";
    if (isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "配置文件", extensions: ["json", "momocfg"] }], multiple: false });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      text = await readTextFile(path);
    } else {
      text = await new Promise<string>((resolve, reject) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.momocfg";
        inp.onchange = () => {
          const f = inp.files?.[0];
          if (!f) return reject(new Error("未选择文件"));
          f.text().then(resolve, reject);
        };
        inp.click();
      });
    }
    let parsed = JSON.parse(text) as Record<string, unknown>;
    // 加密分享包 → 先解密
    const { isEncryptedCfg, decryptCfg } = await import("../../core/cfgCrypto");
    if (isEncryptedCfg(parsed)) parsed = JSON.parse(await decryptCfg(parsed)) as Record<string, unknown>;
    // 抹密钥导出的文件：本机已有的 Key 按服务商 id / 地址回填，不要用空串覆盖
    if (parsed.__keysStripped) {
      const cur = useSettings.getState().settings;
      const models = parsed.models as { providers?: { id?: string; baseUrl?: string; apiKey?: string }[] } | undefined;
      for (const p of models?.providers ?? []) {
        if (p.apiKey) continue;
        const match = cur.models.providers.find((x) => x.id === p.id) ?? cur.models.providers.find((x) => x.baseUrl && x.baseUrl === p.baseUrl);
        if (match?.apiKey) p.apiKey = match.apiKey;
      }
      const search = parsed.search as { apiKey?: string } | undefined;
      if (search && !search.apiKey && cur.search.apiKey) search.apiKey = cur.search.apiKey;
      delete parsed.__keysStripped;
    }
    useSettings.getState().importSettings(parsed);
    toast("配置已导入 ✓", "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/**
 * 分区说明按钮：正文里不再铺一大段说明，收进标题右侧的「?」，
 * 鼠标移上去（或键盘聚焦）弹出小浮窗，移开即收。
 */
function SecHelp({ children }: { children: React.ReactNode }) {
  return (
    <span className="sec-help" tabIndex={0} role="button" aria-label="查看说明">
      ?<span className="sec-help-pop">{children}</span>
    </span>
  );
}

/** 带说明按钮的分区标题；extra 渲染在「?」左侧（用于「模型预设」等入口） */
function SecTitle({ title, extra, children }: { title: string; extra?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <h3 className="sec-h">
      {title}
      {extra || children ? (
        <span className="sec-h-tail">
          {extra ?? null}
          {children ? <SecHelp>{children}</SecHelp> : null}
        </span>
      ) : null}
    </h3>
  );
}

/* ================= 模型配置（服务商卡片） ================= */

const ROLE_ICON: Record<ModelRole, React.ReactNode> = {
  chat: <IcChat size={16} />,
  image: <IcSparkles size={16} />,
  video: <IcVideo size={16} />,
  audio: <IcMusic size={16} />,
  asr: <IcMic size={16} />,
};

const ROLES: ModelRole[] = ["chat", "image", "video", "audio", "asr"];

/** 默认模型行的短标签（五个并排一行，用长名会撑爆） */
const ROLE_SHORT: Record<ModelRole, string> = {
  chat: "对话",
  image: "绘画",
  video: "视频",
  audio: "音频",
  asr: "语音",
};

const MODEL_PLACEHOLDER: Record<ModelRole, string> = {
  chat: "输入模型名回车添加，如 deepseek-chat",
  image: "输入模型名回车添加，如 gpt-image-1",
  video: "输入模型名回车添加，如 cogvideox-3",
  audio: "输入模型名回车添加，如 tts-1 / speech-02",
  asr: "输入模型名回车添加，如 gpt-4o-transcribe / whisper-1",
};

/** 编辑草稿：三个角色槽位全部实体化，models 为空表示该用途未启用 */
type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  logo?: string;
  slots: Record<ModelRole, RoleSlot>;
};

function toDraft(p?: ProviderCard): ProviderDraft {
  const slot = (role: ModelRole): RoleSlot => {
    const s = p?.models[role];
    return s
      ? { protocol: s.protocol, models: [...s.models] }
      : { protocol: PROTOCOLS[role][0].value as AnyProtocol, models: [] };
  };
  return {
    id: p?.id ?? uid(8),
    name: p?.name ?? "",
    baseUrl: p?.baseUrl ?? "",
    apiKey: p?.apiKey ?? "",
    logo: p?.logo,
    slots: { chat: slot("chat"), image: slot("image"), video: slot("video"), audio: slot("audio"), asr: slot("asr") },
  };
}

function fromDraft(d: ProviderDraft): ProviderCard {
  const models: ProviderCard["models"] = {};
  for (const role of ROLES) {
    const s = d.slots[role];
    if (s.models.length) models[role] = { protocol: s.protocol, models: [...s.models] };
  }
  const fallback = d.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "未命名服务商";
  return { id: d.id, name: d.name.trim() || fallback, baseUrl: d.baseUrl, apiKey: d.apiKey, logo: d.logo, models };
}

/** 推荐中转站预设卡片：logo / 评分 / 价格 / 官网跳转 / 一键导入（点「选项」生成草稿，弹编辑浮层补 Key） */
function PresetCard({ p, onPick }: { p: ProviderPreset; onPick: (p: ProviderPreset) => void }) {
  const host = p.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || p.baseUrl;
  // 评分配色档：≥9 高（绿）/ 7-8 中（蓝）/ <7 低（灰）；作稳定性 · 可信度参考
  const level = p.rating == null ? "" : p.rating >= 9 ? "high" : p.rating >= 7 ? "mid" : "low";
  return (
    <div className={`preset-card ${level}`} title={`${p.label}\n\n${p.note}\n${p.baseUrl}`}>
      <div className="psc-top">
        {p.logo ? (
          /^https?:|^data:/i.test(p.logo) ? (
            <img className="psc-logo" src={p.logo} alt="" />
          ) : (
            // [...str][0] 按码点取首字符：emoji（如 🦙）是代理对，slice(0,1) 会切成乱码
            <span className="psc-logo txt">{[...p.logo][0]}</span>
          )
        ) : (
          <span className="psc-logo txt">{[...p.label][0]}</span>
        )}
        <b className="psc-name">{p.label}</b>
        {p.rating != null ? (
          <span className="psc-rating" title="稳定性 / 可信度参考（0-10，越高越稳）">
            {p.rating}
          </span>
        ) : null}
      </div>
      <span className="psc-host">{host}</span>
      {p.price ? (
        <span className="psc-price" title="大概费用（以下单页为准）">
          {p.price}
        </span>
      ) : null}
      <div className="psc-acts">
        {p.site ? (
          <button
            className="icon-btn"
            title={`打开官网：${p.site}`}
            onClick={() => void openExternal(p.site!)}
          >
            <IcGlobe size={14} />
          </button>
        ) : null}
        <button
          className="btn sm primary"
          title="导入为服务商卡片（名称 / 地址 / 协议已填好，再补 API Key 与模型即可）"
          onClick={() => onPick(p)}
        >
          选项
        </button>
      </div>
    </div>
  );
}

function ModelsTab() {
  const models = useSettings((s) => s.settings.models);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const removeProvider = useSettings((s) => s.removeProvider);
  const setDefault = useSettings((s) => s.setDefault);
  const reorderProviders = useSettings((s) => s.reorderProviders);
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [ggufMgrOpen, setGgufMgrOpen] = useState(false);
  const setSideEditorOpen = useUi((s) => s.setSideEditorOpen);
  const localModels = useLocalGguf((s) => s.models);
  // 已配置的 Ollama 卡（chat 槽走原生协议）：固定卡点击直接编辑它，没有则建一张新草稿
  const ollamaCard = models.providers.find((p) => p.models.chat?.protocol === "ollama");

  // 浮出面板打开时，让主设置窗口左移让位（两者整体居中）
  useEffect(() => {
    setSideEditorOpen(!!editing);
    return () => setSideEditorOpen(false);
  }, [!!editing, setSideEditorOpen]);

  const testChat = async (p: ProviderCard) => {
    const card = flattenCard(p, "chat");
    if (!card) return;
    setTesting(p.id);
    try {
      const r = await chatOnce(card, "你是一个连通性测试助手。", "请只回复两个字：正常");
      toast(`「${p.name}」对话模型连通 ✓ 回复：${r.slice(0, 40)}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setTesting(null);
    }
  };

  const saveEditing = (d: ProviderDraft) => {
    // Ollama 本地协议无需 API Key（其余协议仍要求 Key 非空）
    const isOllama = d.slots.chat.protocol === "ollama" || Object.values(d.slots).some((s) => s.protocol === "ollama");
    if (!d.apiKey.trim() && !isOllama) {
      toast("请填写 API Key 后再保存（没有 Key 的服务商不会保存到模型配置）", "err");
      return;
    }
    const p = fromDraft(d);
    if (!Object.keys(p.models).length) {
      toast("请至少为一种用途添加一个模型（输入后回车，或「拉取模型」从列表选择）", "err");
      return;
    }
    upsertProvider(p);
    setEditing(null);
    toast(`已保存「${p.name}」`, "ok");
  };

  const isExisting = !!editing && models.providers.some((p) => p.id === editing.id);
  const savedEditing = isExisting ? models.providers.find((p) => p.id === editing!.id) : undefined;

  return (
    <>
      <SecTitle
        title="模型配置"
        extra={
          <>
            <button
              className="btn sm"
              title="管理 Skill 创作规则包（导入 SKILL.md / .momoskill）"
              onClick={() => useUi.getState().setSkillMgrOpen(true)}
            >
              <IcWand size={14} /> Skill 管理
            </button>
            <button
              className="btn sm"
              title="添加本地 GGUF 模型（一键启动，直接对话）"
              onClick={() => useUi.getState().setGgufImportOpen(true)}
            >
              🧠 添加本地 GGUF
            </button>
            <button
              className="btn sm"
              title="配置本地模型引擎（llama-server 路径）"
              onClick={() => useUi.getState().setLocalLlmSetupOpen(true)}
            >
              🔧 本地引擎
            </button>
            <button
              className="btn sm"
              title="展开 / 收起下方推荐中转站预设"
              onClick={() => setShowPresets((v) => !v)}
            >
              <IcSparkles size={14} /> {showPresets ? "收起预设" : "中转站预设"}
            </button>
          </>
        }
      >
        一格 = 一个服务商（中转站/官方）：Base URL 与 API Key 只填一次，对话、绘画、视频、音频、语音识别每种用途都可以添加多个模型，
        点击方格会在设置窗口右侧弹出编辑面板。配置存在系统用户数据目录并自动备份，也可手动导出保管。
      </SecTitle>
      {/* 默认模型总览（置顶）：五类用途各选一个，节点/面板不单独指定时全用这里的 */}
      <div className="def-models">
        <div className="dm-title">
          默认模型
          <span className="hint">
            画布节点、创作助手不单独指定模型时，一律调用这里选的；节点上仍可临时改用别的模型。
          </span>
        </div>
        <div className="dm-grid">
          {ROLES.map((role) => {
            const has = models.providers.some((p) => (p.models[role]?.models.length ?? 0) > 0);
            return (
              <div key={role} className="dm-row">
                <span className="dm-lab" title={ROLE_LABEL[role]}>
                  {ROLE_ICON[role]}
                  {ROLE_SHORT[role]}
                </span>
                {has ? (
                  <ModelPicker
                    role={role}
                    value={models.defaults[role]}
                    onChange={(v) => {
                      if (v) setDefault(role, v);
                    }}
                  />
                ) : (
                  <span className="dm-none" title="先在下方服务商卡片里给这类用途添加模型">
                    未配置
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Row style={{ margin: "16px 0 12px" }}>
        <span style={{ flex: 1 }} />
        <button
          className="btn sm"
          title="导出全部设置，API Key 一律抹去（推荐：给别人 / 传网盘都安全，接收方填自己的 Key；自己重新导入时本机 Key 自动保留）"
          onClick={() => void exportCfg(true)}
        >
          <IcDownload size={15} /> 导出配置
        </button>
        <button
          className="btn sm"
          title="含密钥的加密分享包（.momocfg）：文件里看不到明文密钥，接收方导入即可直接使用。注意：能直接用就意味着密钥也随包给了对方，只发给信任的人"
          onClick={() => void exportCfg(false)}
        >
          <IcDownload size={15} /> 加密分享包
        </button>
        <button className="btn sm" title="从导出的配置文件恢复全部设置（支持 .json 与 .momocfg 加密包）" onClick={() => void importCfg()}>
          <IcUpload size={15} /> 导入配置
        </button>
      </Row>

      <div className="prov-grid">
        <button className="pcard add" onClick={() => setEditing(toDraft())}>
          <IcPlus size={22} />
          <span>添加服务商</span>
        </button>
        {/* Ollama 固定卡：未配置时作为创建入口；已配置后让位给服务商卡片（避免出现两张内容相同的卡） */}
        {!ollamaCard ? (
          <button
            className="pcard fixed"
            title="本地 Ollama 服务，无需 API Key。点击创建配置（默认 http://127.0.0.1:11434）"
            onClick={() => setEditing(toDraft(buildPresetProvider(OLLAMA_PRESET)))}
          >
            <span className="pc-logo txt">🦙</span>
            <b>Ollama 本地</b>
            <span className="pc-host">本地模型 · 无需 API Key</span>
          </button>
        ) : null}
        {/* 本地 GGUF 固定卡：导入后生成专属卡片，点击打开管理弹窗 */}
        <button
          className="pcard fixed"
          title={
            localModels.length
              ? `已导入：${localModels.map((m) => m.name).join("、")}`
              : "导入本地 .gguf 模型（一键注册并启动 llama-server）"
          }
          onClick={() => (localModels.length ? setGgufMgrOpen(true) : useUi.getState().setGgufImportOpen(true))}
        >
          <span className="pc-logo txt">🧠</span>
          <b>本地 GGUF 模型</b>
          <span className="pc-host">{localModels.length ? `已导入 ${localModels.length} 个模型` : "点击添加 .gguf 文件"}</span>
        </button>
        {models.providers.map((p, i) => (
          <button
            key={p.id}
            className={`pcard ${editing?.id === p.id ? "on" : ""} ${dragIdx === i ? "dragging" : ""} ${overIdx === i ? "drag-over" : ""}`}
            title="点击编辑；按住可拖动调整顺序"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", String(i));
              e.dataTransfer.effectAllowed = "move";
              setDragIdx(i);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIdx(i);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setOverIdx((v) => (v === i ? null : v));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx != null && dragIdx !== i) reorderProviders(dragIdx, i);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
            onClick={() => setEditing(toDraft(p))}
          >
            {p.logo ? (
              /^https?:|^data:/i.test(p.logo) ? (
                <img className="pc-logo" src={p.logo} alt="" />
              ) : (
                // 按码点取首字符：emoji（如 🦙）是代理对，slice(0,1) 会切成乱码
                <span className="pc-logo txt">{[...p.logo][0]}</span>
              )
            ) : null}
            <b>{p.name}</b>
            <span className="pc-host">{p.baseUrl.replace(/^https?:\/\//, "") || "未填地址"}</span>
            <span className="pc-roles">
              {ROLES.map((role) => {
                const slot = p.models[role];
                const isDef = splitModelKey(models.defaults[role]).pid === p.id;
                return (
                  <span
                    key={role}
                    className={`pc-dot ${slot?.models.length ? "on" : ""}`}
                    title={`${ROLE_LABEL[role]}${slot?.models.length ? `：${slot.models.join("、")}` : "：未配置"}${isDef ? "（默认）" : ""}`}
                  >
                    {ROLE_ICON[role]}
                    {isDef ? <i className="pc-def" /> : null}
                  </span>
                );
              })}
            </span>
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        卡片上的五个图标：对话 / 绘画 / 视频 / 音频 / 语音识别。图标点亮 = 该服务商配置了这类模型；
        <b>绿点 = 这类模型的当前默认来源</b>（在顶部「默认模型」里切换）。
      </div>

      {showPresets ? (
        <div className="preset-section">
          <div className="preset-sec-title">
            推荐中转站预设
            <span className="hint">· 一键导入常用中转站（名称 / 地址 / 协议已填好，补 API Key 即可）</span>
          </div>
          <div className="preset-grid">
            {PROVIDER_PRESETS.map((p) => (
              <PresetCard key={p.key} p={p} onPick={(pp) => setEditing(toDraft(buildPresetProvider(pp)))} />
            ))}
          </div>
        </div>
      ) : null}

      <GgufManageDialog open={ggufMgrOpen} onClose={() => setGgufMgrOpen(false)} />

      {editing
        ? createPortal(
            <div className="prov-float" role="dialog" aria-label="服务商配置">
              <div className="pf-head">
                <b>{isExisting ? savedEditing?.name || "编辑服务商" : "添加服务商"}</b>
                <button className="icon-btn" onClick={() => setEditing(null)} aria-label="关闭">
                  <IcClose size={16} />
                </button>
              </div>
              <div className="pf-body">
                {isExisting && savedEditing ? (
                  <div className="pd-actions">
                    {ROLES.filter((r) => savedEditing.models[r]?.models.length).map((role) => {
                      const slot = savedEditing.models[role]!;
                      const def = splitModelKey(models.defaults[role]);
                      const isDefault = def.pid === savedEditing.id;
                      return (
                        <span key={role} className="pd-def-group">
                          <button
                            className={`btn sm ${isDefault ? "primary" : ""}`}
                            title={isDefault ? `当前是${ROLE_LABEL[role]}默认` : `设为${ROLE_LABEL[role]}默认`}
                            onClick={() => setDefault(role, modelKey(savedEditing.id, slot.models[0]))}
                          >
                            {isDefault ? <IcCheck size={14} /> : null} {ROLE_LABEL[role]}默认
                          </button>
                          {isDefault && slot.models.length > 1 ? (
                            <PopSelect
                              style={{ width: 148, flex: "none" }}
                              title={`${ROLE_LABEL[role]}默认模型`}
                              value={def.model ?? slot.models[0]}
                              options={slot.models.map((m) => ({ value: m, label: m }))}
                              onChange={(v) => setDefault(role, modelKey(savedEditing.id, v))}
                            />
                          ) : null}
                        </span>
                      );
                    })}
                    <span style={{ flex: 1 }} />
                    {savedEditing.models.chat ? (
                      <button className="btn sm" disabled={testing === savedEditing.id} onClick={() => void testChat(savedEditing)}>
                        {testing === savedEditing.id ? <IcLoading size={14} /> : null} 测试
                      </button>
                    ) : null}
                    <button
                      className="icon-btn danger"
                      title={confirmDel === savedEditing.id ? "再点一次确认删除" : "删除该服务商"}
                      style={confirmDel === savedEditing.id ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)" } : undefined}
                      onClick={() => {
                        if (confirmDel === savedEditing.id) {
                          removeProvider(savedEditing.id);
                          setConfirmDel(null);
                          setEditing(null);
                        } else setConfirmDel(savedEditing.id);
                      }}
                    >
                      <IcTrash size={16} />
                    </button>
                  </div>
                ) : null}
                <ProviderEditor draft={editing} setDraft={setEditing} onSave={saveEditing} onCancel={() => setEditing(null)} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const EMPTY_BY_ROLE: Record<ModelRole, string> = { chat: "", image: "", video: "", audio: "", asr: "" };

function ProviderEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
}: {
  draft: ProviderDraft;
  setDraft: (d: ProviderDraft) => void;
  onSave: (d: ProviderDraft) => void;
  onCancel: () => void;
}) {
  // 拉取到的模型列表按协议缓存（同一中转站三个槽位通常协议相同，可复用）
  const [lists, setLists] = useState<Record<string, string[]>>({});
  const [pulling, setPulling] = useState<ModelRole | null>(null);
  // 手动输入框 / 拉取列表筛选词（每个用途各一份）
  const [inputs, setInputs] = useState({ ...EMPTY_BY_ROLE });
  const [queries, setQueries] = useState({ ...EMPTY_BY_ROLE });

  const patchSlot = (role: ModelRole, part: Partial<RoleSlot>) =>
    setDraft({ ...draft, slots: { ...draft.slots, [role]: { ...draft.slots[role], ...part } } });

  const addModel = (role: ModelRole, name: string) => {
    const m = name.trim();
    if (!m) return;
    const cur = draft.slots[role].models;
    if (!cur.includes(m)) patchSlot(role, { models: [...cur, m] });
    setInputs((s) => ({ ...s, [role]: "" }));
  };

  const removeModel = (role: ModelRole, m: string) =>
    patchSlot(role, { models: draft.slots[role].models.filter((x) => x !== m) });

  const customProtocols = useSettings((s) => s.settings.customProtocols);

  const pull = async (role: ModelRole) => {
    const proto = draft.slots[role].protocol;
    setPulling(role);
    try {
      // 自定义协议也按 OpenAI 兼容方式尝试（多数中转站同时开放 /models）
      const ids = await fetchModelList(proto, draft.baseUrl, draft.apiKey);
      setLists((s) => ({ ...s, [proto]: ids }));
      toast(`拉取到 ${ids.length} 个模型，可搜索筛选后点选添加`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setPulling(null);
    }
  };

  /** 输入框里没回车确认的文字，保存时一并收进槽位，避免误丢 */
  const finalize = (): ProviderDraft => {
    let d = draft;
    for (const role of ROLES) {
      const m = inputs[role].trim();
      if (m && !d.slots[role].models.includes(m))
        d = { ...d, slots: { ...d.slots, [role]: { ...d.slots[role], models: [...d.slots[role].models, m] } } };
    }
    return d;
  };

  return (
    <div className="mrow-editor">
      <Row gap={12}>
        <div style={{ flex: 1 }}>
          <Field label="服务商名称">
            <input
              className="input"
              placeholder="例如：中转A / 智谱官方"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
        </div>
        <div style={{ flex: 1.6 }}>
          <Field label="Base URL">
            <input
              className="input"
              placeholder="https://api.xxx.com/v1（Gemini 官方可留空）"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value.trim() })}
            />
          </Field>
        </div>
      </Row>
      <Field label="API Key">
        <input
          className="input"
          type="password"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value.trim() })}
        />
      </Field>

      {ROLES.map((role) => {
        const slot = draft.slots[role];
        const list = lists[slot.protocol] ?? [];
        const kw = queries[role].trim().toLowerCase();
        const filtered = kw ? list.filter((m) => m.toLowerCase().includes(kw)) : list;
        return (
          <div key={role} className="pe-slot">
            <div className="pe-slot-head">
              <span className="pc-role-ic">{ROLE_ICON[role]}</span>
              {ROLE_LABEL[role]}
              <span className="pe-slot-hint">可添加多个 · 不添加 = 该服务商不提供此用途</span>
            </div>
            <Row gap={10}>
              <PopSelect
                // 协议名可能很长（自定义协议）：触发按钮限宽截断，全名在弹层里看
                style={{ flex: "1 1 0", minWidth: 0, maxWidth: 190 }}
                title="协议"
                value={slot.protocol}
                options={[
                  ...PROTOCOLS[role].map((x) => ({ value: x.value, label: x.label })),
                  ...(role !== "chat"
                    ? customProtocols
                        .filter((p) => (p.role === "video" ? "video" : p.role === "audio" ? "audio" : "image") === role)
                        .map((p) => ({
                          value: `custom:${p.id}`,
                          label: `★ ${p.name}`,
                          desc: p.verifiedAt ? "✓ 已校准" : "未校准（自定义协议）",
                        }))
                    : []),
                ]}
                onChange={(v) => patchSlot(role, { protocol: v as AnyProtocol })}
              />
              <input
                className="input"
                style={{ flex: "1.5 1 0", minWidth: 0 }}
                placeholder={MODEL_PLACEHOLDER[role]}
                value={inputs[role]}
                onChange={(e) => setInputs((s) => ({ ...s, [role]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addModel(role, inputs[role]);
                  }
                }}
              />
              <button
                className="btn sm"
                style={{ flex: "none" }}
                title="从该服务商拉取可用模型列表"
                disabled={pulling !== null}
                onClick={() => void pull(role)}
              >
                {pulling === role ? <IcLoading size={14} /> : <IcDownload size={14} />} 拉取模型
              </button>
            </Row>
            {(() => {
              // 选了从未真实测试过的自定义协议 → 提醒先去协议页测通（协议不通，模型配了也连不上）
              const cp = customProtocols.find((x) => `custom:${x.id}` === slot.protocol);
              return cp && !cp.verifiedAt ? (
                <div className="pe-slot-hint" style={{ marginTop: 4 }}>
                  ⚠ 协议「{cp.name}」还没跑过真实测试——建议先到「设置 → 协议」用「真实测试并校准」把协议测通，再来配模型，避免生成时才发现连不上。
                </div>
              ) : null;
            })()}
            {slot.models.length ? (
              <div className="pe-chips">
                {slot.models.map((m) => (
                  <span key={m} className="pe-chip" title={m}>
                    {m}
                    <button onClick={() => removeModel(role, m)} aria-label={`移除 ${m}`}>
                      <IcClose size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {list.length ? (
              <>
                <div className="pe-search">
                  <IcSearch size={14} />
                  <input
                    placeholder="输入关键词筛选拉取到的模型…"
                    value={queries[role]}
                    onChange={(e) => setQueries((s) => ({ ...s, [role]: e.target.value }))}
                  />
                </div>
                <PopSelect
                  className="pe-pick"
                  title="点选即添加"
                  value=""
                  placeholder={
                    kw
                      ? `筛出 ${filtered.length} / ${list.length} 个模型，点选即添加…`
                      : `从拉取到的 ${list.length} 个模型中点选即添加…`
                  }
                  options={filtered.map((m) => ({
                    value: m,
                    label: slot.models.includes(m) ? `✓ ${m}` : m,
                    disabled: slot.models.includes(m),
                  }))}
                  onChange={(v) => {
                    if (v) addModel(role, v);
                  }}
                />
              </>
            ) : null}
          </div>
        );
      })}

      <Row style={{ justifyContent: "flex-end", margin: "12px 0 10px" }}>
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn sm primary" onClick={() => onSave(finalize())}>
          保存服务商
        </button>
      </Row>
    </div>
  );
}

/* ================= 协议（自定义协议 + 协议助手） ================= */

const protocolSystem = (role: CustomProtocol["role"]) => `你是 API 协议分析专家。用户会粘贴一个 AI 生成类中转站/服务商的接口文档、示例请求或抓包内容（图片 / 视频 / 音频生成都有可能）。请分析后输出一份 momo 画布的自定义协议 JSON（只输出 JSON，不要任何解释、不要代码块标记）。
用户在界面上把这份文档标为「${role === "video" ? "视频" : role === "audio" ? "音频" : "图片"}生成」，若你判断确实不是，再改 role。

JSON 结构（TypeScript 描述）：
{
  "name": string,            // 协议显示名，如 "某某站异步生图"
  "role": "image" | "video" | "audio", // 【务必仔细判断】该接口生成的是图片、视频还是音频：看接口路径（/images、/videos、/audio/speech）、参数（时长/帧率/音色）、返回字段（video_url、mp4、audio_url 等）
  "submit": {                // 提交生成请求
    "url": string,           // 完整 URL，可用占位符 {{baseUrl}}
    "method": "POST"|"GET",
    "headers": Record<string,string>,  // 通常 {"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}
    "body": string           // JSON 请求体的字符串模板
  },
  "taskIdPath": string,      // 【异步接口才填】提交响应中任务 id 的 JSON 路径，如 "task_id" 或 "data.id"；同步接口省略此字段
  "poll": {                  // 【异步接口才填】轮询查询
    "url": string,           // 查询 URL，可用 {{taskId}}
    "method": "GET"|"POST",
    "headers": Record<string,string>,
    "intervalMs": number,    // 轮询间隔毫秒，默认 3000
    "statusPath": string,    // 状态字段 JSON 路径
    "doneValue": string,     // 表示完成的状态值
    "failValue": string      // 表示失败的状态值
  },
  "resultPath": string       // 最终响应中图片/视频(url或base64)的 JSON 路径；数组用 []，如 "data[].url"
}

${varsDoc(role)}
【重要】body 必须是 JSON 字符串模板（一整个字符串），不能写成嵌套对象。{{prompt}} 必须出现，否则提示词发不出去。
【重要】若文档显示接口支持图生图（image/images 等字段），请务必把图片字段写进 body 模板，否则参考图发不出去；支持蒙版编辑（mask/inpaint）也请写上 {{mask}} 字段；视频接口把时长/分辨率/比例字段接到 {{duration}}/{{resolution}}/{{aspect}}，音频接口把音色接到 {{voice}}，否则画布面板上的设置全部不生效。
条件块语法（可选字段/端点切换用）：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留。例：url 写 "{{baseUrl}}/v1/images/{{?images}}edits{{/images}}{{^images}}generations{{/images}}"；body 里写 {{?mask}},"mask":{"image_url":"{{mask}}"}{{/mask}}。
JSON 路径语法：点号访问对象字段，字段名后加 [] 表示展开数组，如 "data.images[].url"。
如文档信息不足，按 OpenAI 风格合理推断并在 name 里标注「(待验证)」。`;

/**
 * 从粘贴内容里挑出「值得抓的文档链接」。
 * 以前是无差别捞前两个 http URL —— 而输入框恰恰鼓励粘 curl 示例，
 * 于是第一个 URL 往往是用户自己的生成端点，程序会对它发一次无鉴权 GET，
 * 拿回 401 的错误 JSON 还当成"抓取到的文档"喂给模型（xfetch 对 4xx 不抛错，静默污染）。
 */
function pickDocUrls(text: string): string[] {
  const all = text.match(/https?:\/\/[^\s"'<>）)】\]]+/g) ?? [];
  const apiLike = /\/(v\d+)\/|\/(chat\/completions|completions|images?|generations?|videos?|audio|speech|embeddings|edits|submit|query|task)s?(\/|$|\?)/i;
  return [...new Set(all.filter((u) => !apiLike.test(u)))].slice(0, 2);
}

/** 抓来的正文看着像不像文档（404 页、登录页、JS 壳页面、错误 JSON 一律不算） */
function looksLikeDoc(text: string): boolean {
  if (text.length < 300) return false;
  return !/(enable ?javascript|页面不存在|not found|请先登录|sign in to continue|access denied)/i.test(text.slice(0, 400));
}

/** 粗糙但够用的 HTML → 纯文本（协议助手抓取文档链接用） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 抓取粘贴内容里的文档链接（校验状态码/类型/正文成色，抓不到就明说，不拿垃圾正文冒充文档） */
async function fetchDocs(docs: string, limit: number): Promise<string> {
  let material = "";
  for (const u of pickDocUrls(docs)) {
    try {
      toast(`正在抓取文档：${u.slice(0, 60)}…`, "info");
      const resp = await xfetch(u);
      if (!resp.ok) {
        toast(`抓取 ${u.slice(0, 50)} 返回 ${resp.status}，已跳过（只用你粘贴的文字分析）`, "err");
        continue;
      }
      const ct = (resp.headers?.get?.("content-type") ?? "").toLowerCase();
      if (ct && !/html|text|markdown|json|plain/.test(ct)) {
        toast(`${u.slice(0, 50)} 返回的是 ${ct}，不是文档页，已跳过`, "err");
        continue;
      }
      const text = htmlToText(await resp.text()).slice(0, limit);
      if (!looksLikeDoc(text)) {
        toast(`${u.slice(0, 50)} 抓到的内容不像文档（可能是登录页或前端渲染页），已跳过——请把关键接口段落直接复制过来`, "err");
        continue;
      }
      material += `\n\n=== 以下内容抓取自 ${u} ===\n${text}`;
      toast(`已抓取 ${text.length} 字文档内容 ✓`, "ok");
    } catch (e) {
      toast(`抓取 ${u.slice(0, 50)} 失败：${errMsg(e)}，将只用已粘贴的文字分析`, "err");
    }
  }
  return material;
}

function ProtocolTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const [busy, setBusy] = useState(false);
  /* 草稿与校准现场都在 protoTabStore：切到其他页面/关掉弹窗不丢，正在跑的测试可停止 */
  const { docs, draft, roleSel, testProvider, testModel, manualBase, manualKey, calLog, calBusy, ctrl, calDone, calSnap, patch, logLine } =
    useProtoTab();
  const providers = settings.models.providers;
  const selProvider = testProvider || providers[0]?.id || MANUAL;
  const manual = selProvider === MANUAL;
  /* 「占位符参考」chips 行展开态：纯界面状态，不进 protoTabStore */
  const [varsOpen, setVarsOpen] = useState(false);

  /** 占位符 chip 点击复制（清单来自 protoSpec.varList，不硬编码） */
  const copyVar = (name: string) => {
    const s = `{{${name}}}`;
    navigator.clipboard
      ?.writeText(s)
      .then(() => toast(`已复制 ${s}`, "ok"))
      .catch(() => toast(`复制失败，请手动输入 ${s}`, "err"));
  };

  /** 选服务商时顺手预填其对应槽位的第一个模型 */
  const pickProvider = (pid: string) => {
    patch({ testProvider: pid });
    if (pid === MANUAL) return;
    const p = providers.find((x) => x.id === pid);
    const m = p?.models[roleSel]?.models[0];
    if (m) patch({ testModel: m });
  };

  const runCalibrate = async () => {
    let proto: CustomProtocol;
    try {
      const r = validateProto(parseJsonLoose<CustomProtocol>(draft) ?? JSON.parse(draft));
      proto = r.proto;
      if (r.warnings.length) toast(`协议有待确认之处：${r.warnings.join("；")}`, "info");
    } catch (e) {
      toast(`右侧协议 JSON 不完整：${errMsg(e)}`, "err");
      return;
    }
    proto.role = roleSel;
    const prov = manual ? undefined : providers.find((x) => x.id === selProvider);
    const baseUrl = (manual ? manualBase : prov?.baseUrl ?? "").trim();
    const apiKey = (manual ? manualKey : prov?.apiKey ?? "").trim();
    if (!baseUrl) {
      toast(manual ? "请填写用于测试的 Base URL" : "请选择服务商，或选「手动输入」直接填 Base URL / Key", "err");
      return;
    }
    if (!testModel.trim()) {
      toast("请填写用于测试的模型名", "err");
      return;
    }
    const ctrl = new AbortController();
    patch({
      calBusy: true,
      ctrl,
      calDone: null,
      calLog: [`使用${prov ? `服务商「${prov.name}」` : "手动填写的地址"}（${baseUrl}）· 模型 ${testModel.trim()} 进行真实测试…`],
    });
    try {
      const { proto: fixed, results } = await calibrateProtocol(
        proto,
        { baseUrl, apiKey, model: testModel.trim() },
        logLine,
        ctrl.signal,
      );
      if (!fixed.id) fixed.id = proto.id ?? uid(6);
      fixed.verifiedAt = Date.now(); // 真实测试通过 → 盖「已校准」章
      patch({
        draft: JSON.stringify(fixed, null, 2),
        calDone: { model: testModel.trim(), providerId: prov?.id, baseUrl, apiKey, role: roleSel },
        calSnap: fixed, // 存下这一刻的样子：之后再手改协议，「已校准」章会自动作废
      });
      logLine(`✅ 校准完成（取到 ${results.length} 个结果），协议已盖「已校准」章 —— 点下方按钮一键保存并应用到模型配置`);
      toast("测试通过，协议已按真实响应校准 ✓", "ok");
    } catch (e) {
      logLine(`❌ ${errMsg(e)}`);
      toast(`测试失败：${errMsg(e)}`, "err");
    } finally {
      patch({ calBusy: false, ctrl: null });
    }
  };

  /** 校准通过后的一键衔接：保存协议 → 服务商槽位切到该协议 → 测试模型加进槽位（没有服务商则新建一个） */
  const saveAndApply = () => {
    const done = calDone;
    if (!done) return;
    try {
      const { proto: p } = validateProto(parseJsonLoose<CustomProtocol>(draft) ?? JSON.parse(draft));
      if (!p.id) p.id = uid(6);
      p.role = done.role;
      // 校准通过后又手改了协议 → 这份没测过，不能带着「已校准」章落地
      if (p.verifiedAt && (!calSnap || protoFingerprint(p) !== protoFingerprint(calSnap))) {
        delete p.verifiedAt;
        toast("协议在校准后被修改过，「已校准」标记已清除——建议重新跑一次测试", "info");
      }
      const list = settings.customProtocols;
      const idx = list.findIndex((x) => x.id === p.id);
      update("customProtocols", idx >= 0 ? list.map((x, k) => (k === idx ? p : x)) : [...list, p]);
      const role = done.role === "video" ? "video" : done.role === "audio" ? "audio" : "image";
      const roleLabel = role === "video" ? "视频" : role === "audio" ? "音频" : "绘画";
      if (done.providerId) {
        const prov = settings.models.providers.find((x) => x.id === done.providerId);
        if (!prov) throw new Error("测试时所用的服务商已被删除，请到「模型配置」手动选择该协议");
        const models = [...new Set([done.model, ...(prov.models[role]?.models ?? [])])];
        upsertProvider({ ...prov, models: { ...prov.models, [role]: { protocol: `custom:${p.id}`, models } } });
        toast(`协议「${p.name}」已保存，并应用到「${prov.name}」的${roleLabel}槽位（模型 ${done.model}）✓ 可直接使用`, "ok");
      } else {
        const host = done.baseUrl.replace(/^https?:\/\//i, "").split("/")[0] || "新服务商";
        upsertProvider({
          id: uid(8),
          name: host,
          baseUrl: done.baseUrl,
          apiKey: done.apiKey,
          models: { [role]: { protocol: `custom:${p.id}`, models: [done.model] } },
        });
        toast(`协议「${p.name}」已保存，并新建服务商「${host}」、配好${roleLabel}槽位（模型 ${done.model}）✓ 可直接使用`, "ok");
      }
      patch({ calDone: null, draft: "", calSnap: null });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const generate = async () => {
    if (!docs.trim()) {
      toast("先把中转站的接口文档 / 文档链接 / 示例请求粘贴到左边输入框", "err");
      return;
    }
    setBusy(true);
    try {
      // 文档里的 http 链接自动抓取正文一并交给模型（最多取前 2 个，跳过看起来是 API 端点的地址）
      const material = docs.slice(0, 24000) + (await fetchDocs(docs, 20000));
      const card = resolveModelCard("chat");
      const out = await chatOnce(card, protocolSystem(roleSel), material.slice(0, 48000));
      // 宽容解析：模型经常在 JSON 前后加一句说明或包代码块，硬 JSON.parse 会直接崩
      const parsed = parseJsonLoose<CustomProtocol>(out);
      if (!parsed) {
        toast(
          `模型没有返回可解析的协议 JSON。已把原始回复填进右侧编辑框，你可以手动修整；也可以补充更完整的接口文档（请求示例 + 响应示例）后重试`,
          "err",
        );
        patch({ draft: out.slice(0, 8000) });
        return;
      }
      // 类型/必填校验：能自动纠的（body 写成对象等）当场纠，纠不了的明说缺哪个，别等运行时才炸
      let proto: CustomProtocol;
      let warnings: string[] = [];
      try {
        ({ proto, warnings } = validateProto(parsed));
      } catch (err) {
        patch({ draft: JSON.stringify(parsed, null, 2) });
        toast(`协议草稿已生成，但有问题：${errMsg(err)}——已填进右侧编辑框，补齐后再保存`, "err");
        return;
      }
      const pr = proto.role;
      // 用途不再静默覆盖用户的选择：先按你在界面上选的走，助手判断不一致时提示你自己决定
      const conflict = pr !== roleSel;
      patch({ draft: JSON.stringify({ ...proto, role: roleSel }, null, 2) });
      const lab = (r: string) => (r === "video" ? "视频" : r === "audio" ? "音频" : "图片");
      toast(
        conflict
          ? `协议草稿已生成 ✓ 但助手判定这是「${lab(pr)}生成」接口，与你选的「${lab(roleSel)}生成」不一致——请在下方「协议用途」自行确认（草稿仍按你选的用途保存）`
          : warnings.length
            ? `协议草稿已生成 ✓ 需注意：${warnings.join("；")}`
            : `协议草稿已生成 ✓ 用途「${lab(roleSel)}生成」，请核对右侧 JSON 后保存`,
        conflict || warnings.length ? "info" : "ok",
      );
    } catch (e) {
      toast(`生成失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  /** 一键补全：让协议助手在不破坏现有字段的前提下，为草稿补上图片/蒙版占位符（参考左侧文档，可抓链接） */
  const completeDraft = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const material = docs.trim().slice(0, 20000) + (await fetchDocs(docs, 16000));
      const card = resolveModelCard("chat");
      const ask = (roleSel === "audio"
        ? [
            "下面是一份音频生成协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全朗读/音乐能力：",
            "1. body 的文本字段用占位符 {{prompt}}（朗读文本或音乐描述），字段名以参考文档为准（常见：input / text / prompt / lyrics）",
            "2. 若文档有音色/歌手/风格字段，用 {{voice}} 占位（常见：voice / voice_id / timbre）",
            "3. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹；resultPath 指向音频地址（常见：data.audio_url / audio_url / data[].url）",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
        : roleSel === "video"
        ? [
            "下面是一份视频生成协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全图生视频与参数能力：",
            "1. body 补首帧图片字段：占位符 {{image}}（dataURL 或 URL），字段名以参考文档为准（常见：image / image_url / image_urls / first_frame_image）",
            "2. 若文档显示支持首尾帧过渡，补尾帧字段用 {{image2}}（常见：image_tail / last_frame_image / lastFrame）",
            "3. 补生成参数占位符：{{duration}}（秒数）/ {{resolution}}（如 720p）/ {{aspect}}（如 16:9）/ {{audio}}（true/false），字段名按文档",
            "4. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹，保证不传图/不传参时请求体依然是合法 JSON",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
        : [
            "下面是一份已能跑通文生图的协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全图生图与蒙版能力：",
            "1. body 补图片字段：占位符用 {{images}}（数组，不加引号）或 {{image}}（单图 dataURL），字段名以参考文档为准；没有文档就按常见网关风格（如 image_urls）补",
            "2. 若文档显示支持蒙版/inpaint，补 {{mask}} 字段；文生图与图生图端点不同时，用条件块切换 url",
            "3. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹，保证不传图时请求体依然是合法 JSON",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
      ).concat([
        `\n当前协议：\n${draft}`,
        material ? `\n参考文档：\n${material}` : "\n（没有粘贴文档：按站点风格合理推断）",
      ]).join("\n");
      const out = await chatOnce(card, protocolSystem(roleSel), ask.slice(0, 48000));
      const parsed = parseJsonLoose<CustomProtocol>(out);
      if (!parsed) throw new Error("模型没有返回可解析的协议 JSON（可补充更完整的接口文档后重试）");
      const { proto, warnings } = validateProto(parsed);
      // 身份字段以当前草稿为准，模型不许改（改了会变成另一条协议、丢掉绑定）
      const cur = parseJsonLoose<CustomProtocol>(draft);
      if (cur?.id) proto.id = cur.id;
      proto.role = roleSel;
      delete proto.verifiedAt; // 模板变了就不再是那份测过的协议
      if (warnings.length) toast(`补全结果需注意：${warnings.join("；")}`, "info");
      patch({ draft: JSON.stringify(proto, null, 2) });
      toast(
        roleSel === "video"
          ? "已补全图生视频/尾帧/参数字段 ✓ 核对右侧 JSON → 保存 → 校准"
          : roleSel === "audio"
            ? "已补全朗读/音色字段 ✓ 核对右侧 JSON → 保存 → 校准"
            : "已补全图片/蒙版字段 ✓ 核对右侧 JSON → 保存 → 到下方「真实测试并校准」跑一遍",
        "ok",
      );
    } catch (e) {
      toast(`补全失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    try {
      const { proto: p, warnings } = validateProto(parseJsonLoose<CustomProtocol>(draft) ?? JSON.parse(draft));
      if (!p.id) p.id = uid(6);
      // 用途以界面选择为准（可纠正助手判断）
      p.role = roleSel;
      // 「已校准」是这条链路的信任锚点：内容改过就不能继续挂着上次那枚章
      if (p.verifiedAt && (!calSnap || protoFingerprint(p) !== protoFingerprint(calSnap))) {
        delete p.verifiedAt;
        warnings.push("协议内容与上次测试通过的版本不一致，「已校准」标记已清除，建议重新跑一次校准");
      }
      const list = settings.customProtocols;
      const i = list.findIndex((x) => x.id === p.id);
      update("customProtocols", i >= 0 ? list.map((x, k) => (k === i ? p : x)) : [...list, p]);
      const lab = p.role === "video" ? "视频" : p.role === "audio" ? "音频" : "图片";
      toast(
        warnings.length
          ? `协议「${p.name}」已保存（${lab}生成）。需注意：${warnings.join("；")}`
          : `协议「${p.name}」已保存（${lab}生成）——到「模型配置」里给服务商的${p.role === "image" ? "绘画" : lab}槽位选择「★ ${p.name}」即可使用`,
        warnings.length ? "info" : "ok",
      );
      patch({ draft: "", calSnap: null });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <>
      <SecTitle title="协议">
        遇到不是 OpenAI 兼容的中转站（比如异步任务式生图/生视频）？把它的接口文档或文档链接粘贴给「协议助手」，
        由你配置的对话模型分析生成协议；核对用途（图片/视频）并保存后，就能在「模型配置」对应槽位的协议下拉里选用。
        协议也可以手写 / 修改 JSON。
      </SecTitle>
      {/* 卡 1：协议管理 —— 自愈开关 / 中转站预设 / 已保存协议 */}
      <div className="pt-card">
        <div className="pt-card-title">协议管理</div>
        <div className="pt-switch-row">
          <Switch on={settings.protoSelfHeal} onChange={(v) => update("protoSelfHeal", v)} />
          <div className="pt-switch-txt">
            <b>协议自愈</b>
            <div className="pt-hint">
              自定义协议运行失败时，自动把报错与执行现场（真实请求/响应，密钥已脱敏）交给对话模型修协议并重试一次；
              重试成功才写回保存，失败自动回滚不留坏协议。网络/鉴权/额度类错误不触发（修协议没用）。重试会产生一次生成费用。
            </div>
          </div>
        </div>

        <div className="pt-sub">常用中转站预设（一键导入 / 修复）</div>
        <div className="preset-list">
          {PROTO_PRESETS.map((pp) => (
            <div key={pp.key} className="preset-row" title={`${pp.label}\n\n${pp.note}`}>
              <div className="pr-info">
                <b>{pp.label}</b>
                <span>{pp.note}</span>
              </div>
              <button
                className="btn sm primary"
                title="若匹配的服务商已绑定自定义协议：原地覆盖修复（绑定不变）；否则新建协议并自动绑定"
                onClick={() => toast(applyProtoPreset(pp), "ok")}
              >
                导入 / 修复
              </button>
            </div>
          ))}
        </div>
        <div className="pt-hint">预设按官方文档校对过图片/蒙版字段格式。导入后建议先跑一次下方「测试与校准」卡片的真实测试再上画布。</div>

        {settings.customProtocols.length ? (
          <>
            <div className="pt-sub">已保存的协议</div>
            <div className="pt-chips">
              {settings.customProtocols.map((p) => (
                <span
                  key={p.id}
                  className="pe-chip"
                  title={`${p.role === "video" ? "视频生成" : p.role === "audio" ? "音频生成" : "图片生成"} · ${p.taskIdPath ? "异步轮询" : "同步"} · ${
                    p.verifiedAt ? `已于 ${new Date(p.verifiedAt).toLocaleString()} 真实测试通过` : "还没跑过真实测试（建议先到下方「测试与校准」验证）"
                  } · 点 × 删除`}
                >
                  {p.role === "video" ? "视频 · " : p.role === "audio" ? "音频 · " : "图片 · "}
                  {p.name}
                  {p.verifiedAt ? " ✓" : ""}
                  <button
                    onClick={() => patch({ draft: JSON.stringify(p, null, 2), roleSel: p.role, calSnap: p })}
                    title="编辑"
                    aria-label="编辑"
                  >
                    <IcEditSmall />
                  </button>
                  <button
                    onClick={() => update("customProtocols", settings.customProtocols.filter((x) => x.id !== p.id))}
                    aria-label="删除"
                  >
                    <IcClose size={11} />
                  </button>
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {/* 卡 2：编辑协议 —— 左栏粘贴文档 / 右栏 JSON（窄窗口折单列） */}
      <div className="pt-card">
        <div className="pt-card-title">编辑协议</div>
        <div className="pt-hint">把中转站的接口文档粘贴到左侧，由「协议助手」分析生成协议 JSON；也可以在右侧直接手写或修改。</div>
        <div className="pt-cols">
          <div className="pt-col">
            <div className="pt-sub">接口文档 / 文档链接 / 示例请求</div>
            <textarea
              className="textarea pt-doc"
              placeholder={
                "把中转站的 API 文档、curl 示例、请求/响应 JSON 粘贴到这里…\n也可以直接粘贴 API 文档的网址链接，会自动抓取页面内容分析。\n信息越全，生成的协议越准。"
              }
              value={docs}
              onChange={(e) => patch({ docs: e.target.value })}
            />
            <button className="btn primary" disabled={busy} onClick={() => void generate()}>
              {busy ? <IcLoading size={16} /> : <IcSparkles size={16} />} 让协议助手分析生成
            </button>
          </div>
          <div className="pt-col">
            <div className="pt-json-head">
              <span className="pt-sub">核对 / 手动编辑协议 JSON</span>
              <button
                className={`pt-vars-toggle ${varsOpen ? "on" : ""}`}
                title="展开当前用途可用的占位符清单（点击复制）"
                onClick={() => setVarsOpen((v) => !v)}
              >
                <IcChevronD size={12} /> 占位符参考
              </button>
            </div>
            {varsOpen ? (
              <div className="pt-var-chips">
                {varList(roleSel).map((v) => (
                  <button key={v.name} className="pt-var-chip" title={`${v.desc}（点击复制）`} onClick={() => copyVar(v.name)}>
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              className="textarea pt-json"
              placeholder={
                "协议 JSON 会出现在这里，也可以直接手写。\n占位符见上方「占位符参考」（随协议用途切换，点击复制）。\n提示：要支持图生图/局部重绘，body 里必须写上图片/蒙版字段，否则图片不会发给模型"
              }
              value={draft}
              onChange={(e) => patch({ draft: e.target.value })}
            />
            {/* 通用体检：缺 {{prompt}} 或占位符名字拼错——这两条不会报错，只会静默出一张与输入无关的图 */}
            {(() => {
              if (!draft.trim()) return null;
              const p = parseJsonLoose<CustomProtocol>(draft);
              if (!p?.submit?.url) return null;
              const msgs: string[] = [];
              try {
                if (!placeholdersIn(p).has("prompt")) msgs.push("模板里没有 {{prompt}}，提示词发不出去（会照样扣费，出一张与输入无关的结果）");
                const unk = unknownPlaceholders(p);
                if (unk.length) msgs.push(`有应用不认识的占位符 ${unk.map((k) => `{{${k}}}`).join(" ")}，运行时会被渲染成空串（多半是名字拼错）`);
              } catch {
                return null;
              }
              return msgs.length ? (
                <div className="pt-hint warn row">
                  <IcWarn size={13} />
                  <span>{msgs.join("；")}</span>
                </div>
              ) : null;
            })()}
            {/* 能力体检：保存前就把「只能文生图/没有真蒙版」讲清楚，并给出一键修复入口 */}
            {roleSel === "image" && draft.trim() ? (
              !["{{image}}", "{{images}}", "{{image2}}"].some((k) => draft.includes(k)) ? (
                <div className="pt-hint warn row">
                  <IcWarn size={13} />
                  <span>模板没有图片占位符（{"{{image}} / {{images}}"}）：该协议只能<b>文生图</b>，接了参考图会直接报错。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全图生图/蒙版
                  </button>
                </div>
              ) : !draft.includes("{{mask}}") ? (
                <div className="pt-hint row">
                  <IcBulb size={13} />
                  <span>模板不含 {"{{mask}}"}：可以图生图，但「真蒙版」重绘不可用（节点上切「指令式」也能重绘）。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全蒙版
                  </button>
                </div>
              ) : (
                <div className="pt-hint ok row">
                  <IcCheck size={13} />
                  <span>模板含图片与蒙版占位符：文生图 / 图生图 / 真蒙版重绘均可用。</span>
                </div>
              )
            ) : null}
            {roleSel === "video" && draft.trim() ? (
              !draft.includes("{{image}}") ? (
                <div className="pt-hint warn row">
                  <IcWarn size={13} />
                  <span>模板没有首帧占位符（{"{{image}}"}）：该协议只能<b>文生视频</b>，接上游图片不会生效。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全图生视频/尾帧/参数
                  </button>
                </div>
              ) : !draft.includes("{{image2}}") ? (
                <div className="pt-hint row">
                  <IcBulb size={13} />
                  <span>模板不含尾帧 {"{{image2}}"}：首尾帧过渡不可用（接 2 路图时第 2 路会被忽略）。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全尾帧/参数
                  </button>
                </div>
              ) : !["{{duration}}", "{{resolution}}", "{{aspect}}"].some((k) => draft.includes(k)) ? (
                <div className="pt-hint row">
                  <IcBulb size={13} />
                  <span>模板不含 {"{{duration}} / {{resolution}} / {{aspect}}"}：面板上的时长/分辨率/比例设置不会生效。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全参数
                  </button>
                </div>
              ) : (
                <div className="pt-hint ok row">
                  <IcCheck size={13} />
                  <span>模板含首帧/尾帧/参数占位符：文生视频 / 图生视频 / 首尾帧 / 面板参数均可用。</span>
                </div>
              )
            ) : null}
            {roleSel === "audio" && draft.trim() ? (
              !draft.includes("{{voice}}") ? (
                <div className="pt-hint row">
                  <IcBulb size={13} />
                  <span>模板不含 {"{{voice}}"}：音色/歌手/风格选择不会生效（只能用服务商默认音色）。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全音色字段
                  </button>
                </div>
              ) : (
                <div className="pt-hint ok row">
                  <IcCheck size={13} />
                  <span>模板含 {"{{prompt}}"} 与 {"{{voice}}"}：朗读文本与音色都能下发。</span>
                </div>
              )
            ) : null}
            <div className="pt-role-row">
              <span className="pt-sub" title="决定该协议出现在哪个模型槽位、结果按图片还是视频处理">
                协议用途
              </span>
              <div className="pt-seg">
                <button className={roleSel === "image" ? "on" : ""} onClick={() => patch({ roleSel: "image" })}>
                  <IcGallery size={13} /> 图片生成
                </button>
                <button className={roleSel === "video" ? "on" : ""} onClick={() => patch({ roleSel: "video" })}>
                  <IcVideo size={13} /> 视频生成
                </button>
                <button className={roleSel === "audio" ? "on" : ""} onClick={() => patch({ roleSel: "audio" })}>
                  <IcMusic size={13} /> 音频生成
                </button>
              </div>
              <span className="pt-spacer" />
              <button className="btn primary" disabled={!draft.trim()} onClick={save}>
                <IcCheck size={16} /> 校验并保存协议
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 卡 3：测试与校准 —— 真实跑一次协议，把结果路径从「猜」改成「量」 */}
      <div className="pt-card">
        <div className="pt-card-title">测试与校准</div>
        <div className="pt-hint">
          <b>真实调用一次</b>该协议（生成类接口会产生一次费用），程序在真实响应里定位任务
          ID、状态、结果字段的实际位置，自动把协议里写错的路径改成实测值。
          可以借已有服务商的 Key，也可以选「手动输入」直接填 Base URL / Key（还没建服务商也能先测协议）。
          测试在后台运行：切到其他页面不会中断，日志保留在这里，也可以随时停止。
        </div>
        <div className="pt-cal-row">
          <PopSelect
            className="pt-w-prov"
            triggerIcon
            title="借用服务商的 Key"
            value={selProvider}
            options={[
              ...providers.map((p) => ({ value: p.id, label: p.name, icon: <IcGlobe size={14} /> })),
              { value: MANUAL, label: "手动输入 Base URL / Key…", icon: <IcGear size={14} /> },
            ]}
            onChange={(v) => pickProvider(v)}
          />
          {manual ? (
            <>
              <input
                className="input pt-w-base"
                placeholder="Base URL（如 https://api.xx.com/v1）"
                value={manualBase}
                onChange={(e) => patch({ manualBase: e.target.value })}
              />
              <input
                className="input pt-w-key"
                type="password"
                placeholder="API Key"
                value={manualKey}
                onChange={(e) => patch({ manualKey: e.target.value })}
              />
            </>
          ) : null}
          <input
            className="input pt-w-model"
            placeholder="测试用模型名（如 gpt-image-2）"
            value={testModel}
            onChange={(e) => patch({ testModel: e.target.value })}
          />
          <button
            className="btn primary"
            disabled={calBusy || !draft.trim()}
            title="真实发起一次生成请求（有费用），并按真实响应校准协议 JSON"
            onClick={() => void runCalibrate()}
          >
            {calBusy ? <IcLoading size={15} /> : <IcCheck size={15} />} {calBusy ? "测试中…" : "真实测试并校准"}
          </button>
          {calBusy ? (
            <button className="btn" onClick={() => ctrl?.abort()} title="停止等待/轮询（已发出的提交请求所产生的费用无法撤回）">
              停止测试
            </button>
          ) : null}
        </div>
        {calLog.length ? (
          <div className="cal-log">
            {calLog.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        ) : null}
        {calDone && !calBusy ? (
          <div className="pt-apply-row">
            <button className="btn primary" onClick={saveAndApply}>
              <IcCheck size={15} />{" "}
              {calDone.providerId
                ? `保存协议并应用到「${providers.find((p) => p.id === calDone.providerId)?.name ?? "服务商"}」`
                : "保存协议并新建服务商"}
            </button>
            <span className="pt-hint">
              一键衔接：保存已校准协议 → {calDone.providerId ? "该服务商" : "新服务商"}的
              {calDone.role === "video" ? "视频" : calDone.role === "audio" ? "音频" : "绘画"}槽位切到此协议 → 模型 {calDone.model} 加入槽位，配完即可用
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** 小号编辑图标（協議 chip 内联用） */
function IcEditSmall() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m13.7 5 3.3 3.3L9.3 16 5 17l1-4.3L13.7 5Z" />
    </svg>
  );
}

/* ================= 音效提醒 ================= */
function SoundTab() {
  const sound = useSettings((s) => s.settings.sound);
  const update = useSettings((s) => s.update);
  const patch = (p: Partial<SoundCfg>) => update("sound", { ...sound, ...p });

  /** 上传自定义提示音（存为 dataURL；1.5MB 以内） */
  const upload = (key: "doneAudio" | "errAudio") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 1.5 * 1024 * 1024) {
        toast("音频太大（限 1.5MB 内）：建议用短促的提示音片段", "err");
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        patch({ [key]: r.result as string });
        toast("自定义提示音已保存，点「试听」确认效果", "ok");
      };
      r.readAsDataURL(f);
    };
    input.click();
  };

  return (
    <>
      <SecTitle title="音效提醒">
        任务完成/报错时的提示音与语音播报。完成音在点击「生成/运行」的目标节点跑完后响起；报错音随报错中心触发。
      </SecTitle>
      <Row gap={12} style={{ alignItems: "center", marginBottom: 14 }}>
        <Switch on={sound.enabled} onChange={(v) => patch({ enabled: v })} />
        <b>启用音效提醒</b>
      </Row>
      <Field label="音量">
        <Row gap={10} style={{ alignItems: "center" }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sound.volume}
            style={{ width: 220 }}
            onChange={(e) => patch({ volume: Number(e.target.value) })}
          />
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>{Math.round(sound.volume * 100)}%</span>
        </Row>
      </Field>
      <Field label="完成提示音" hint={sound.doneAudio ? "当前：自定义音频" : "当前：内置提示音（上扬双音）"}>
        <Row gap={8}>
          <button className="btn sm" onClick={playDone}>
            <IcPlay size={14} /> 试听
          </button>
          <button className="btn sm" onClick={() => upload("doneAudio")}>
            <IcUpload size={14} /> 上传自定义
          </button>
          {sound.doneAudio ? (
            <button className="btn sm" onClick={() => patch({ doneAudio: undefined })}>
              恢复内置
            </button>
          ) : null}
        </Row>
      </Field>
      <Field label="报错提示音" hint={sound.errAudio ? "当前：自定义音频" : "当前：内置提示音（下沉双音）"}>
        <Row gap={8}>
          <button className="btn sm" onClick={playError}>
            <IcPlay size={14} /> 试听
          </button>
          <button className="btn sm" onClick={() => upload("errAudio")}>
            <IcUpload size={14} /> 上传自定义
          </button>
          {sound.errAudio ? (
            <button className="btn sm" onClick={() => patch({ errAudio: undefined })}>
              恢复内置
            </button>
          ) : null}
        </Row>
      </Field>
      <Row gap={12} style={{ alignItems: "flex-start", marginTop: 16 }}>
        <Switch on={sound.speak} onChange={(v) => patch({ speak: v })} />
        <div>
          <div style={{ fontWeight: 600 }}>语音播报</div>
          <div className="sec-desc" style={{ margin: "2px 0 6px" }}>
            用系统语音念出节点名与结果，例如「生成图像完成」「生成视频出错」（使用 Windows 内置中文语音，无需联网）。
          </div>
          <button
            className="btn sm"
            onClick={() => {
              // 试听不受开关限制，方便先听效果再决定开不开
              const u = new SpeechSynthesisUtterance("生成图像完成");
              u.lang = "zh-CN";
              u.volume = sound.volume;
              speechSynthesis.speak(u);
            }}
          >
            <IcPlay size={14} /> 试听播报
          </button>
        </div>
      </Row>
    </>
  );
}

/* ================= 联网搜索 ================= */
function SearchTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const patch = (part: Partial<Settings["search"]>) => update("search", { ...settings.search, ...part });
  const p = settings.search.provider;
  const meta = SEARCH_PROVIDERS.find((x) => x.value === p);
  return (
    <>
      <SecTitle title="联网搜索">
        开启创作助手上的 🌐 后，提问会先联网检索再作答并给出来源。模型自带联网能力（GLM / MiniMax / 混元等）时优先用模型自己的搜索，
        失败自动降级到这里配置的搜索接口。推荐国内直连的智谱 / 博查 / LangSearch（都有免费额度或价格很低）。
      </SecTitle>
      <Field label="搜索服务商">
        <Row gap={8} style={{ alignItems: "center" }}>
          <PopSelect
            style={{ width: 260 }}
            value={p}
            options={SEARCH_PROVIDERS.map((x) => ({ value: x.value, label: x.label, desc: x.desc }))}
            onChange={(v) => patch({ provider: v as SearchProvider })}
          />
          {meta ? (
            <button
              className="btn sm"
              title={`打开 ${meta.site}（注册 / 获取 API Key）`}
              onClick={() => void openExternal(meta.site)}
            >
              <IcGlobe size={13} /> 官网 ↗
            </button>
          ) : null}
        </Row>
      </Field>
      {meta?.needs !== "baseUrl" ? (
        <Field label="API Key" hint={meta ? `到 ${meta.site.replace(/^https?:\/\//, "")} 注册获取（${meta.desc}）` : undefined}>
          <input className="input" type="password" value={settings.search.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value.trim() })} />
        </Field>
      ) : (
        <Field label="实例地址" hint="例如 http://127.0.0.1:8080（需开启 JSON 输出）">
          <input className="input" value={settings.search.baseUrl} placeholder="http://127.0.0.1:8080"
            onChange={(e) => patch({ baseUrl: e.target.value.trim() })} />
        </Field>
      )}
      <Field label="结果条数">
        <PopSelect
          style={{ width: 140 }}
          value={String(settings.search.maxResults)}
          options={[3, 5, 8, 10].map((n) => ({ value: String(n), label: `${n} 条` }))}
          onChange={(v) => patch({ maxResults: Number(v) })}
        />
      </Field>
    </>
  );
}

/* ================= 图片保存 ================= */

/** 命名模板可用变量（点击追加） */
const NAME_VARS: { token: string; label: string; sample: string }[] = [
  { token: "{date}", label: "日期", sample: "20260718" },
  { token: "{time}", label: "时间", sample: "153042" },
  { token: "{model}", label: "模型", sample: "gpt-image-2" },
  { token: "{prompt}", label: "提示词", sample: "赛博朋克城市夜景" },
  { token: "{size}", label: "分辨率", sample: "2560x1440" },
  { token: "{ratio}", label: "比例", sample: "16x9" },
  { token: "{n}", label: "序号", sample: "1" },
  { token: "{seed}", label: "随机种子", sample: "12345" },
];

/** 模板实时示例：把变量替换成样例值，直观看到最终文件名 */
function PatternPreview({ pattern }: { pattern: string }) {
  let out = pattern;
  for (const v of NAME_VARS) out = out.split(v.token).join(v.sample);
  return (
    <>
      示例：<b style={{ color: "var(--text-2)" }}>{out || "（空模板将使用 momo_日期_时间）"}.png</b>
      　·　序号 = 同前缀文件依次递增
    </>
  );
}

function SaveTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const patch = (part: Partial<Settings["save"]>) => update("save", { ...settings.save, ...part });

  const pickDir = async () => {
    if (!isTauri) {
      toast("浏览器预览模式无法选择文件夹", "err");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "选择图片保存文件夹" });
    if (typeof dir === "string") patch({ dir });
  };

  return (
    <>
      <SecTitle title="图片保存">
        控制「另存为 / 自动保存」写入磁盘的位置、格式与命名。画布生成的内容会另外自动收录进资产库，两者互不影响。
      </SecTitle>
      <Field label="保存文件夹">
        <Row>
          <input className="input" value={settings.save.dir} placeholder="尚未选择…"
            onChange={(e) => patch({ dir: e.target.value })} />
          <button className="btn" onClick={() => void pickDir()}>
            <IcFolder size={16} /> 浏览
          </button>
        </Row>
      </Field>
      <Row gap={12} style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <Field label="保存格式">
            <PopSelect
              value={settings.save.format}
              options={[
                { value: "png", label: "PNG", desc: "无损" },
                { value: "jpeg", label: "JPG", desc: "体积小" },
                { value: "webp", label: "WebP", desc: "兼顾两者" },
              ]}
              onChange={(v) => patch({ format: v as Settings["save"]["format"] })}
            />
          </Field>
          <Field
            label="PNG 元信息"
            hint="保存 PNG 时把提示词 / 模型 / seed / 生成时间嵌入文件（iTXt 文本块，不重编码图像、画质零损失，所有看图软件兼容）"
          >
            <Row gap={12} style={{ alignItems: "center" }}>
              <Switch on={settings.save.embedMeta} onChange={(v) => patch({ embedMeta: v })} />
              <span className="sec-desc">写入提示词 / 模型 / seed / 时间（仅 PNG）</span>
            </Row>
          </Field>
        </div>
        <div style={{ flex: 1.6 }}>
          <Field label="命名模板" hint={<PatternPreview pattern={settings.save.pattern} />}>
            <input className="input" value={settings.save.pattern}
              onChange={(e) => patch({ pattern: e.target.value })} />
            <div className="var-chips">
              {NAME_VARS.map((v) => (
                <button
                  key={v.token}
                  className="btn sm"
                  title={`点击把「${v.label}」追加到模板末尾（${v.token}）`}
                  onClick={() => {
                    const cur = settings.save.pattern.trim();
                    patch({ pattern: cur ? `${cur}_${v.token}` : v.token });
                  }}
                >
                  {v.label}
                </button>
              ))}
              <button className="btn sm" title="清空模板重新组合" onClick={() => patch({ pattern: "" })}>
                清空
              </button>
            </div>
          </Field>
        </div>
      </Row>
      <Field label="生成后自动保存" hint="开启后，每次生成成功都会按上述规则自动写入保存文件夹">
        <Switch on={settings.save.autoSave} onChange={(v) => patch({ autoSave: v })} />
      </Field>
    </>
  );
}

/* ================= ComfyUI ================= */
function ComfyTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const online = useComfy((s) => s.online);
  const onlineInfo = useComfy((s) => s.onlineInfo);
  const test = useComfy((s) => s.test);
  const templates = useComfyTemplates();
  const removeTpl = useComfy((s) => s.remove);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const [testing, setTesting] = useState(false);
  const [freeing, setFreeing] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const tplFileRef = useRef<HTMLInputElement>(null);

  const exportAllTpl = async () => {
    if (!templates.length) return toast("还没有模板可导出", "err");
    if (await saveTextFile("momo-comfy-templates.json", packTemplates(templates)))
      toast(`已导出全部 ${templates.length} 个模板 ✓`, "ok");
  };

  return (
    <>
      <SecTitle title="ComfyUI">
        连接本机或局域网内已启动的 ComfyUI 服务，通过工作流模板在画布上直接出图。
      </SecTitle>
      <Field label="服务地址">
        <Row>
          <input className="input" value={settings.comfy.host} placeholder="http://127.0.0.1:8188"
            onChange={(e) => update("comfy", { ...settings.comfy, host: e.target.value.trim() })} />
          <button
            className="btn"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              const r = await test(settings.comfy.host);
              setTesting(false);
              toast(
                r.ok ? "ComfyUI 已连接 ✓" : `无法连接 ComfyUI${r.err ? `：${r.err}` : "，请确认已启动"}`,
                r.ok ? "ok" : "err",
              );
            }}
          >
            {testing ? <IcLoading size={15} /> : null} 测试连接
          </button>
        </Row>
      </Field>
      <Field label="工作流目录（往返编辑）">
        <Row>
          <input
            className="input"
            value={settings.comfy.workflowDir ?? ""}
            placeholder="ComfyUI 的用户工作流目录，如 G:\ComfyUI\ComfyUI\user\default\workflows"
            title="配置后，模板管理里可把模板一键送进 ComfyUI 画布编辑（Ctrl+S 保存），再一键同步回模板"
            onChange={(e) => update("comfy", { ...settings.comfy, workflowDir: e.target.value })}
          />
          <button
            className="btn"
            onClick={async () => {
              try {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const picked = await open({ directory: true, title: "选择 ComfyUI 的用户工作流目录（通常在 …/ComfyUI/user/default/workflows）" });
                if (picked && typeof picked === "string") update("comfy", { ...settings.comfy, workflowDir: picked });
              } catch {
                toast("当前环境不支持选择目录，可直接粘贴路径", "info");
              }
            }}
          >
            选择…
          </button>
        </Row>
        <div className="sec-desc" style={{ marginTop: 6 }}>
          模板「⬆」按钮默认走 ComfyUI 自身接口直接推送工作流库（无需此项）。仅当不配服务地址（离线/旧版 ComfyUI）时，才用此目录以本地文件方式兜底。
        </div>
      </Field>
      <Row gap={8} style={{ marginBottom: 18 }}>
        <span className={`dot ${online}`} />
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-2)" }}>
          {online === "ok" ? `已连接 ${onlineInfo}` : online === "down" ? "未连接" : "未检测"}
        </span>
        <button
          className="btn sm"
          style={{ marginLeft: "auto" }}
          disabled={freeing}
          title="立即调用 ComfyUI /free：卸载全部模型、释放显存与 ComfyUI 进程内存缓存（下次运行会重新加载模型）"
          onClick={async () => {
            setFreeing(true);
            const r = await freeComfyMemory(settings.comfy.host);
            setFreeing(false);
            toast(freeResultText(r), r.ok ? "ok" : "err");
          }}
        >
          {freeing ? <IcLoading size={13} /> : <IcBroom size={13} />} 一键释放显存与内存
        </button>
      </Row>

      <div className="gp-lab" style={{ margin: "4px 0 8px" }}>工作流模板（{templates.length}）</div>
      {templates.length ? (
        templates.map((t) => (
          <div key={t.id} className="tpl-row">
            <span className="kind-ic" style={{ width: 34, height: 34, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--grad-brand-soft)", color: "var(--accent)" }}>
              <IcFlow size={17} />
            </span>
            <div className="tn">
              <b>{t.name}</b>
              <span>
                {Object.keys(t.workflow).length} 个节点 · 暴露 {t.params.length} 个参数
              </span>
            </div>
            <button className="icon-btn" title="编辑模板（参数/输入输出）" onClick={() => setTemplateMgr(true, t.id)}>
              <IcEdit size={17} />
            </button>
            <button
              className="icon-btn"
              title="导出该模板（含参数配置，可再导入）"
              onClick={() =>
                void saveTextFile(`${t.name}.momo-tpl.json`, packTemplates([t])).then(
                  (ok) => ok && toast(`模板「${t.name}」已导出 ✓`, "ok"),
                )
              }
            >
              <IcDownload size={17} />
            </button>
            <button
              className="icon-btn danger"
              title={confirmDel === t.id ? "再点一次确认删除" : "删除模板"}
              style={confirmDel === t.id ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)" } : undefined}
              onClick={() => {
                if (confirmDel === t.id) {
                  removeTpl(t.id);
                  setConfirmDel(null);
                } else setConfirmDel(t.id);
              }}
            >
              <IcTrash size={17} />
            </button>
          </div>
        ))
      ) : (
        <p className="sec-desc">还没有模板——打开模板管理器导入，或直接批量导入工作流/模板包 JSON。</p>
      )}
      <Row gap={8} style={{ marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => setTemplateMgr(true)}>
          <IcFlow size={16} /> 打开工作流模板管理器
        </button>
        <button className="btn" title="选择多个 JSON（API 工作流 / 模板 / 模板包）一次性导入" onClick={() => tplFileRef.current?.click()}>
          <IcUpload size={15} /> 批量导入
        </button>
        <button className="btn" title="把全部模板导出为一个模板包 JSON，可在其他设备导入恢复" onClick={() => void exportAllTpl()}>
          <IcDownload size={15} /> 全部导出
        </button>
        <input
          ref={tplFileRef}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length)
              void importTemplateFilesAuto(files).then(({ saved, errs }) => {
                if (saved) toast(`批量导入完成：${saved} 个模板 ✓`, "ok");
                if (errs.length) toast(`${errs.length} 个文件失败：${errs[0]}`, "err");
              });
            e.target.value = "";
          }}
        />
      </Row>
      <p className="sec-desc" style={{ marginTop: 12 }}>
        模板管理器支持选文件 / <b>直接拖入</b> / <b>Ctrl+V 粘贴</b> ComfyUI「API 格式」工作流
        JSON，自由勾选要暴露的输入/参数/输出节点保存为模板；画布的 ComfyUI 节点上即可直接编辑这些参数并运行。
      </p>
    </>
  );
}

/* ================= 快捷键 ================= */

/** 键名 → 键帽显示（方向键用箭头，精致些） */
function keyLabel(key: string): string {
  const map: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
    Escape: "Esc",
    Delete: "Del",
    Backspace: "⌫",
    Enter: "⏎",
    Tab: "⇥ Tab",
  };
  return map[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 组合键 → 键帽显示（"ctrl+z" → "Ctrl + Z"） */
function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p === "ctrl" ? "Ctrl" : p === "shift" ? "Shift" : p === "alt" ? "Alt" : keyLabel(p)))
    .join(" + ");
}

/** 快捷键分组（设置页两列排布用；未列入的动作会自动归到「其他」） */
const HOTKEY_GROUPS: { title: string; actions: HotkeyAction[] }[] = [
  {
    title: "画布操作",
    actions: ["moveTool", "group", "ignore", "align", "duplicate", "delete", "undo", "redo", "popLock"],
  },
  { title: "视图", actions: ["fitView", "zoomIn", "zoomOut", "zen", "search", "spotlight"] },
  { title: "运行", actions: ["runAll", "runSelected"] },
  {
    title: "面板与窗口",
    actions: ["agent", "voiceCall", "director", "assets", "gallery", "charLib", "errCenter", "runLog", "settings", "theme", "newBoard"],
  },
  {
    title: "添加节点",
    actions: [
      "addImage",
      "addVideo",
      "addAudio",
      "addPrompt",
      "addStylePreset",
      "addNote",
      "addCombine",
      "addStoryboard",
      "addImageGen",
      "addVideoGen",
      "addAudioGen",
      "addComfy",
      "addRelight",
      "addMultiAngle",
      "addCharCard",
      "addEcomImage",
      "addDirector",
      "addEnhanceLocal",
      "addVectorize",
      "addVideoDub",
    ],
  },
  { title: "已并入其他功能（保留兼容）", actions: ["addChat", "addLlmText"] },
];

const FIXED_KEYS: { label: string; keys: string[] }[] = [
  { label: "临时平移画布", keys: ["Space", "拖动"] },
  { label: "多选 / 框选连线", keys: ["Ctrl", "点击或框选"] },
  { label: "粘贴图片/文字", keys: ["Ctrl", "V"] },
  { label: "Alt 拖拽复制工作流", keys: ["Alt", "拖动节点"] },
];

function HotkeysTab() {
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const update = useSettings((s) => s.update);
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);

  // 实时冲突检测：同一组合键被多个动作绑定 → 双方标红（录制新键时的拦截只能防新增，标红负责暴露存量冲突）
  const clashOf = useMemo(() => {
    const byKey = new Map<string, HotkeyAction[]>();
    for (const [a, k] of Object.entries(hotkeys) as [HotkeyAction, string][]) {
      if (!k) continue;
      const key = k.toLowerCase();
      const list = byKey.get(key) ?? [];
      list.push(a);
      byKey.set(key, list);
    }
    const out = new Map<HotkeyAction, HotkeyAction>(); // 冲突方 → 冲突对方（互相指认）
    for (const list of byKey.values()) {
      if (list.length > 1) list.forEach((a, i) => out.set(a, list[(i + 1) % list.length]));
    }
    return out;
  }, [hotkeys]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const base = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const mods = [(e.ctrlKey || e.metaKey) && "ctrl", e.shiftKey && "shift", e.altKey && "alt"].filter(
        Boolean,
      ) as string[];
      if (capturing === "delete" && mods.length) {
        toast("删除请绑定单键（如 Del / X），暂不支持组合键删除", "err");
        return;
      }
      const combo = [...mods, base].join("+");
      const clash = (Object.entries(hotkeys) as [HotkeyAction, string][]).find(
        ([a, k]) => k.toLowerCase() === combo.toLowerCase() && a !== capturing,
      );
      if (clash) {
        toast(`「${comboLabel(combo)}」已分配给：${HOTKEY_LABEL[clash[0]]}`, "err");
        return;
      }
      update("hotkeys", { ...hotkeys, [capturing]: combo });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, hotkeys, update]);

  return (
    <>
      <SecTitle title="快捷键">
        点击键帽后按下新按键即可重新绑定（Esc 取消）。按功能分组、两列排布；最下方为固定组合键，仅作速查。
      </SecTitle>
      {clashOf.size ? (
        <div className="hint" style={{ color: "var(--danger)", margin: "8px 0 0" }}>
          ⚠ 检测到 {clashOf.size / 2} 组快捷键冲突：标红的键帽有多个功能共用同一按键，点击键帽重新绑定即可消除
        </div>
      ) : null}
      {HOTKEY_GROUPS.map((g) => (
        <div key={g.title} className="hk-group">
          <div className="hk-gtitle">{g.title}</div>
          <div className="hk-grid">
            {g.actions.map((action) => (
              <div className="hk-row" key={action}>
                <span className="hk-name" title={HOTKEY_LABEL[action]}>
                  {HOTKEY_LABEL[action]}
                </span>
                <button
                  className={`keycap ${capturing === action ? "cap" : ""} ${clashOf.has(action) ? "clash" : ""}`}
                  title={
                    clashOf.has(action)
                      ? `⚠ 与「${HOTKEY_LABEL[clashOf.get(action)!]}」快捷键冲突——点击后按下新按键重新绑定`
                      : "点击后按下新按键"
                  }
                  onClick={() => setCapturing(capturing === action ? null : action)}
                >
                  {capturing === action ? "按键…" : hotkeys[action] ? comboLabel(hotkeys[action]) : "未绑定"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
      <Row style={{ margin: "6px 0 18px" }}>
        <button className="btn sm" onClick={() => update("hotkeys", { ...DEFAULT_HOTKEYS })}>
          恢复默认
        </button>
      </Row>
      <h3 style={{ fontSize: "var(--fs-base)" }}>固定快捷键</h3>
      <div className="hk-grid">
        {FIXED_KEYS.map((f) => (
          <div className="hk-row dim" key={f.label}>
            <span className="hk-name">{f.label}</span>
            <span className="hk-combo">
              {f.keys.map((k, i) => (
                <span key={i}>
                  {i > 0 ? <i className="hk-plus">+</i> : null}
                  <kbd className="keycap sm">{k}</kbd>
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ================= 用量与稳定性 ================= */
function UsageTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  // rangeUsage/todayCost 每次返回新对象/需计算，不能做 selector（会无限重渲染）；读一次即可（切回此 tab 重新挂载会刷新）
  const range = useUsage.getState().rangeUsage(7);
  const todayCost = useUsage.getState().todayCost();
  const retry = settings.retry;
  const budget = settings.budget;
  const num = (v: string) => Number(v) || 0;
  const maxCost = Math.max(0.01, ...range.rows.map((r) => r.cost));
  return (
    <>
      <SecTitle title="用量与花费">
        每次生成（图/视频/音频）自动按模型单价记账、按天聚合预估花费；价格为粗略估算，不作为计费依据。
      </SecTitle>
      <div className="gp-lab" style={{ marginBottom: 8 }}>
        今日 ¥{todayCost.toFixed(2)} · 近 7 天累计 ¥{range.total.toFixed(2)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 6 }}>
        {range.rows.length ? (
          range.rows.map((r) => (
            <div key={r.day} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ flex: "0 0 42px", color: "var(--text-2)" }}>{r.day.slice(5)}</span>
              <span
                style={{
                  height: 10,
                  width: `${Math.max(3, (r.cost / maxCost) * 160)}px`,
                  borderRadius: 5,
                  background: "color-mix(in srgb, var(--accent) 60%, transparent)",
                }}
              />
              <span style={{ color: "var(--text-2)" }}>
                ¥{r.cost.toFixed(2)} · {r.calls} 次{r.fails ? ` · 失败 ${r.fails}` : ""}
              </span>
            </div>
          ))
        ) : (
          <div className="hint">还没有用量记录（生成图片/视频后这里会出现数据）</div>
        )}
      </div>

      <div className="gp-lab" style={{ marginTop: 18, marginBottom: 6 }}>
        预算护栏（0 = 不限制）
      </div>
      <Row gap={12} style={{ alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          日预算上限 ¥
          <input
            className="input"
            type="number"
            style={{ width: 100 }}
            value={budget.dailyCap}
            onChange={(e) => update("budget", { ...budget, dailyCap: num(e.target.value) })}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          超此花费二次确认 ¥
          <input
            className="input"
            type="number"
            style={{ width: 100 }}
            value={budget.confirmOverCost}
            onChange={(e) => update("budget", { ...budget, confirmOverCost: num(e.target.value) })}
          />
        </label>
      </Row>
      <p className="sec-desc" style={{ marginTop: 4 }}>
        超日预算会阻断并报错；超确认阈值弹窗确认。Token 类（对话/分镜）按实际记账、暂不预拦。
      </p>

      <div className="gp-lab" style={{ marginTop: 18, marginBottom: 6 }}>
        失败重试（中转站 429 / 5xx / 网络抖动）
      </div>
      <Row gap={12} style={{ alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          幂等请求重试
          <input
            className="input"
            type="number"
            style={{ width: 70 }}
            value={retry.idempotentMax}
            onChange={(e) => update("retry", { ...retry, idempotentMax: num(e.target.value) })}
          />
          次
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          生成类重试
          <input
            className="input"
            type="number"
            style={{ width: 70 }}
            value={retry.submitMax}
            onChange={(e) => update("retry", { ...retry, submitMax: num(e.target.value) })}
          />
          次
        </label>
      </Row>
      <p className="sec-desc" style={{ marginTop: 4 }}>
        幂等请求（轮询/搜索/下载）自动重试，无扣费风险；生成类重试有重复扣费风险，默认关，按需开启。
      </p>

      <div className="gp-lab" style={{ marginTop: 18, marginBottom: 6 }}>
        备用模型（主模型重试耗尽后换卡再试一次）
      </div>
      <Row gap={12} style={{ flexDirection: "column", alignItems: "stretch" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ flex: "0 0 64px" }}>绘画备用</span>
          <ModelPicker role="image" value={retry.fallbackImage || undefined} onChange={(v) => update("retry", { ...retry, fallbackImage: v || "" })} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ flex: "0 0 64px" }}>视频备用</span>
          <ModelPicker role="video" value={retry.fallbackVideo || undefined} onChange={(v) => update("retry", { ...retry, fallbackVideo: v || "" })} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ flex: "0 0 64px" }}>音频备用</span>
          <ModelPicker role="audio" value={retry.fallbackAudio || undefined} onChange={(v) => update("retry", { ...retry, fallbackAudio: v || "" })} />
        </label>
      </Row>
      <p className="sec-desc" style={{ marginTop: 4 }}>
        留空 = 不兜底。建议选与主模型同家族的备用，跨家族时面板参数会自动适配。
      </p>
    </>
  );
}

/* ================= 外观 ================= */
function AppearanceTab() {
  const theme = useSettings((s) => s.settings.theme);
  const gpuBoost = useSettings((s) => s.settings.gpuBoost);
  const update = useSettings((s) => s.update);
  return (
    <>
      <SecTitle title="外观主题">
        三套精心调校的主题，随时一键切换（标题栏主题按钮或 Ctrl+Shift+T 同样可切换）。
      </SecTitle>
      <div className="theme-cards">
        <div className={`theme-card ${theme === "light" ? "on" : ""}`} onClick={() => update("theme", "light")}>
          <div className="tc-preview" style={{ background: "#eef1f8" }}>
            <div style={{ position: "absolute", inset: "12px auto auto 12px", width: 90, height: 28, borderRadius: 8, background: "#fff", boxShadow: "0 4px 14px rgba(28,42,84,.14)" }} />
            <div style={{ position: "absolute", inset: "50px auto auto 34px", width: 110, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#5b8cff,#9a6bff)" }} />
          </div>
          <div className="tc-name"><IcSun size={16} /> 云白 · 白色主题</div>
        </div>
        <div className={`theme-card ${theme === "dark" ? "on" : ""}`} onClick={() => update("theme", "dark")}>
          <div className="tc-preview" style={{ background: "#161f36" }}>
            <div style={{ position: "absolute", inset: "12px auto auto 12px", width: 90, height: 28, borderRadius: 8, background: "#1c2644", border: "1px solid rgba(126,156,255,.2)" }} />
            <div style={{ position: "absolute", inset: "50px auto auto 34px", width: 110, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#5b8cff,#9a6bff)" }} />
          </div>
          <div className="tc-name"><IcMoon size={16} /> 深空蓝 · 深色主题</div>
        </div>
        <div className={`theme-card ${theme === "black" ? "on" : ""}`} onClick={() => update("theme", "black")}>
          <div className="tc-preview" style={{ background: "#0d0e15" }}>
            <div style={{ position: "absolute", inset: "12px auto auto 12px", width: 90, height: 28, borderRadius: 8, background: "#1a1c26", border: "1px solid rgba(255,255,255,.08)" }} />
            <div style={{ position: "absolute", inset: "50px auto auto 34px", width: 110, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#ff7a45,#ffc857)" }} />
          </div>
          <div className="tc-name"><IcBlack size={16} /> 深邃黑 · 暖橙强调</div>
        </div>
      </div>
      <h3 style={{ marginTop: 24 }}>性能</h3>
      <Row gap={12} style={{ alignItems: "center" }}>
        <Switch on={gpuBoost} onChange={(v) => update("gpuBoost", v)} />
        <div>
          <div style={{ fontWeight: 600 }}>画布 GPU 加速</div>
          <div className="sec-desc" style={{ margin: 0 }}>
            把节点提升为独立合成层，平移/缩放走 GPU 合成，明显减少大画布的卡顿闪烁。默认开启；若遇到显卡驱动兼容问题（花屏/残影）可关闭，立即生效。
          </div>
        </div>
      </Row>
    </>
  );
}

/* ================= 关于与更新 ================= */

function AboutTab() {
  const [ver, setVer] = useState("…");
  const [mode, setMode] = useState<"installed" | "portable" | "web">("web");
  const [dataDir, setDataDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [found, setFound] = useState<Extract<UpdateInfo, { kind: "installed" | "portable" }> | null>(null);

  useEffect(() => {
    void currentVersion().then(setVer);
    if (isTauri) {
      void isPortable().then((p) => setMode(p ? "portable" : "installed"));
      void import("@tauri-apps/api/path").then((m) => m.appDataDir()).then(setDataDir).catch(() => undefined);
    }
  }, []);

  const doCheck = async () => {
    setBusy(true);
    setStatus("正在检查更新…");
    setFound(null);
    try {
      const info = await checkUpdate();
      if (info.kind === "none") setStatus(`已是最新版本（v${info.current}）`);
      else {
        setFound(info);
        setStatus("");
      }
    } catch (e) {
      setStatus(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    if (!found) return;
    setBusy(true);
    try {
      await found.apply((m) => setStatus(m));
    } catch (e) {
      setStatus(`更新失败：${errMsg(e)}`);
      setBusy(false);
    }
  };

  return (
    <>
      <h3>关于与更新</h3>
      <div className="about-card">
        <IcLogo size={40} />
        <div>
          <b style={{ fontSize: 16 }}>MOMO 智能画布</b>
          <div className="sec-desc" style={{ margin: 0 }}>
            当前版本 v{ver} ·{" "}
            {mode === "web" ? "浏览器预览" : mode === "portable" ? "便携版（更新时下载 zip 自动替换）" : "安装版（更新时自动下载安装）"}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !isTauri} onClick={() => void doCheck()}>
          {busy ? <IcLoading size={15} /> : null} 检查更新
        </button>
      </div>
      {status ? <p className="sec-desc" style={{ whiteSpace: "pre-wrap" }}>{status}</p> : null}
      {found ? (
        <div className="about-update">
          <b>发现新版本 v{found.version}</b>
          {found.notes ? <pre className="about-notes">{found.notes}</pre> : null}
          <button className="btn primary" disabled={busy} onClick={() => void doApply()}>
            {busy ? <IcLoading size={15} /> : null}
            {found.kind === "portable" ? "下载并替换（应用将自动重启）" : "下载并安装（应用将自动重启）"}
          </button>
        </div>
      ) : null}
      <h3 style={{ marginTop: 26 }}>数据与隐私</h3>
      <p className="sec-desc">
        所有配置（含 API Key）、画布、资产、模板都只保存在<b>本机</b>的应用数据目录，不打进安装包、不上传任何服务器；
        把安装包/便携包分发给别人，对方拿到的是<b>全新空白配置</b>，不会带上你的密钥。
      </p>
      {dataDir ? (
        <p className="sec-desc" style={{ userSelect: "text" }}>
          数据目录：<code>{dataDir}</code>
        </p>
      ) : null}
      <p className="sec-desc">
        更新源：GitHub 仓库 <code>{GH_REPO}</code> 的 Releases（发布新版本后，这里一键升级）。
      </p>
    </>
  );
}
