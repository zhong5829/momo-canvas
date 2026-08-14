/**
 * 添加本地 GGUF 模型 — 一键添加 + 测试，不再让用户碰 Modelfile / 终端命令
 *
 * 新版三步流程（§2）：
 *  1. 选择主 GGUF 文件
 *  2. 自动扫描同目录 mmproj（视觉模型）
 *  3. 点「添加并测试」→ 注册到 localGgufStore + 启动 llama-server + /health 就绪
 *
 * 成功后模型出现在对话选择器，可直接聊天（视觉模型还能收图）。
 * 旧的「导入到 Ollama」Modelfile 流程收进折叠「高级设置」里作次要入口。
 *
 * 浏览器预览模式：降级提示，不白屏（无法获取绝对路径 / 启动进程）。
 */
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal, Field, Row } from "../../ui/kit";
import { useUi, toast, pushError } from "../../core/stores/uiStore";
import { useLocalGguf } from "../../core/stores/localGgufStore";
import { useSettings } from "../../core/stores/settingsStore";
import {
  analyzeGguf,
  generateOllamaImportSteps,
  type GgufMeta,
  type ModelfileParams,
} from "../../core/services/ollama";
import { detectLlamaServer, startModel } from "../../core/services/localLlm";
import { isTauri } from "../../core/utils";
import { errMsg } from "../../core/utils";
import { IcUpload, IcCopy, IcLoading, IcSparkles, IcPlus, IcTrash, IcClose } from "../../ui/icons";

export function GgufImportDialog() {
  const open = useUi((s) => s.ggufImportOpen);
  const close = () => useUi.getState().setGgufImportOpen(false);
  const setLocalLlmSetupOpen = useUi((s) => s.setLocalLlmSetupOpen);
  const addModel = useLocalGguf((s) => s.addModel);
  const updateSettingLocalLlm = useSettings((s) => s.update);

  const [meta, setMeta] = useState<GgufMeta | null>(null);
  const [ggufPath, setGgufPath] = useState("");
  const [mmprojPath, setMmprojPath] = useState("");
  const [siblings, setSiblings] = useState<string[] | undefined>(undefined);
  // 高级设置
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [numCtx, setNumCtx] = useState(4096);
  const [gpuLayers, setGpuLayers] = useState<"auto" | number>("auto");
  const [reasoningMode, setReasoningMode] = useState<"auto" | "on" | "off">("auto");
  // 旧的 Ollama 导入（高级设置里）
  const [showOllamaLegacy, setShowOllamaLegacy] = useState(false);
  const [ollamaModelName, setOllamaModelName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  // 提交状态
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const reset = () => {
    setMeta(null);
    setGgufPath("");
    setMmprojPath("");
    setSiblings(undefined);
    setDisplayName("");
    setShowAdvanced(false);
    setBusy(false);
    setBusyMsg("");
  };

  const onPickFile = async (files: FileList) => {
    const f = files[0];
    if (!f) return;
    // 浏览器降级：拿不到绝对路径，只能用文件名（仅用于查看元数据）
    setGgufPath(f.name);
    const m = analyzeGguf({ name: f.name, size: f.size });
    setMeta(m);
    setDisplayName(deriveName(f.name));
    setMmprojPath("");
  };

  /** Tauri：用 dialog 选文件拿真实绝对路径，并扫描同目录 mmproj */
  const onPickTauri = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "GGUF", extensions: ["gguf"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const path = picked;
      const name = path.replace(/[\\/]/g, "/").split("/").pop() ?? "model.gguf";
      const { stat, readDir } = await import("@tauri-apps/plugin-fs");
      let size = 0;
      try {
        size = (await stat(path)).size;
      } catch {
        /* stat 失败不阻塞 */
      }
      setGgufPath(path);
      setDisplayName(deriveName(name));
      setMmprojPath("");
      // 扫描同目录 mmproj
      const dir = path.replace(/[\\/][^\\/]+$/, "");
      try {
        const entries = await readDir(dir);
        const siblingNames = entries.map((e) => e.name);
        setSiblings(siblingNames);
        const m = analyzeGguf({ name, size }, siblingNames);
        setMeta(m);
        if (m.mmprojCandidates?.length) {
          setMmprojPath(`${dir}/${m.mmprojCandidates[0]}`);
        }
      } catch {
        setMeta(analyzeGguf({ name, size }));
        /* 目录不可读就跳过 mmproj 扫描 */
      }
    } catch (e) {
      toast(`选择文件失败：${errMsg(e)}`, "err");
    }
  };

  /** 主流程：添加并测试 */
  const onAddAndTest = async () => {
    if (!meta || !ggufPath) {
      toast("请先选择 GGUF 文件", "err");
      return;
    }
    if (!isTauri) {
      toast("浏览器预览模式无法启动本地模型，请在桌面版使用", "err");
      return;
    }
    setBusy(true);
    setBusyMsg("正在检查 llama-server…");
    let registeredId: string | null = null; // 用于失败回滚（注册成功但启动失败时删除已注册项）
    try {
      // 1. 探测/确认 llama-server 可用
      const settingPath = useSettings.getState().settings.localLlm?.executablePath;
      let detected = await detectLlamaServer(settingPath);
      if (!detected.path) {
        // 没找到 → 打开配置弹窗让用户选 exe
        setBusy(false);
        setBusyMsg("");
        toast("首次使用本地 GGUF，需要先配置 llama-server", "info");
        useUi.getState().setLocalLlmSetupOpen(true);
        return;
      }
      // 记录到 settings（首次或路径变化时更新）
      if (detected.path !== settingPath || detected.version) {
        updateSettingLocalLlm("localLlm", {
          executablePath: detected.path,
          version: detected.version ?? undefined,
        });
      }

      // 2. 注册到 localGgufStore（自动解析量化/架构/mmproj）
      setBusyMsg("正在注册模型…");
      const model = addModel({
        ggufPath,
        mmprojPath: mmprojPath || undefined,
        filename: meta.filename,
        sizeBytes: meta.sizeBytes,
        siblings,
        name: displayName || deriveName(meta.filename),
        contextSize: numCtx,
        gpuLayers,
        reasoningMode,
        executablePath: detected.path,
      });
      registeredId = model.id;

      // 3. 启动 llama-server + 等 /health 就绪
      setBusyMsg("正在启动 llama-server 并加载模型（大模型可能需要一两分钟）…");
      await startModel(model);

      // 4. 成功
      const isVision = !!mmprojPath;
      toast(
        isVision
          ? `模型已添加（视觉模型），可以在对话中发送图片`
          : `模型已添加，可以直接在 MOMO 中对话`,
        "ok",
      );
      reset();
      close();
    } catch (e) {
      const msg = errMsg(e);
      // 启动失败：回滚已注册的模型（避免留下「永久失败」的幽灵模型卡）
      if (registeredId) {
        useLocalGguf.getState().removeModel(registeredId);
      }
      pushError("添加本地 GGUF 模型", msg);
    } finally {
      setBusy(false);
      setBusyMsg("");
    }
  };

  // 旧 Ollama 导入流程：Modelfile 生成（高级设置里）
  const legacyParams: ModelfileParams = {
    ggufPath,
    modelName: ollamaModelName || displayName,
    mmprojPath: mmprojPath || undefined,
    numCtx,
    think: reasoningMode !== "off",
    systemPrompt: systemPrompt || undefined,
  };
  const { modelfile, steps } =
    meta && showOllamaLegacy ? generateOllamaImportSteps(legacyParams) : { modelfile: "", steps: "" };

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast(`已复制${label}到剪贴板`, "ok"),
      () => toast("复制失败，请手动选择文本复制", "err"),
    );
  };

  const isVision = !!mmprojPath;

  return (
    <Modal title="添加本地 GGUF 模型" onClose={close} width={680}>
      <div className="nodrag" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isTauri ? (
          <div className="sec-desc" style={{ color: "var(--warn, #e0a228)" }}>
            ⚠️ 浏览器预览模式无法获取文件绝对路径、无法启动本地进程。请在桌面版使用此功能。
          </div>
        ) : null}

        {/* 步骤 1：选择 GGUF 文件 */}
        <Row gap={8}>
          <button
            className="btn sm"
            onClick={() => (isTauri ? void onPickTauri() : fileRef.current?.click())}
            disabled={busy}
          >
            <IcUpload size={14} /> 选择 GGUF 文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".gguf"
            style={{ display: "none" }}
            onChange={(e) => e.target.files && onPickFile(e.target.files)}
          />
          {!meta ? (
            <span className="sec-desc">选择本地 GGUF 文件（不会移动或删除原文件）</span>
          ) : null}
        </Row>

        {/* 识别卡 */}
        {meta ? (
          <div
            style={{
              padding: 14,
              borderRadius: "var(--r-md)",
              background: "var(--panel)",
              border: "1px solid var(--panel-border)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <b style={{ fontSize: 14 }}>{displayName || meta.filename}</b>
              <span
                className="ds-badge"
                style={{
                  background: isVision
                    ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                    : "var(--hover)",
                  color: isVision ? "var(--accent)" : "var(--text-3)",
                }}
              >
                {isVision ? "视觉模型" : "文本模型"}
              </span>
            </div>
            <div className="sec-desc" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
              <span>大小</span>
              <span>{meta.sizeLabel}</span>
              {meta.quant ? (
                <>
                  <span>量化</span>
                  <span>{meta.quant}</span>
                </>
              ) : null}
              {meta.arch ? (
                <>
                  <span>架构</span>
                  <span>{meta.arch}</span>
                </>
              ) : null}
              <span>视觉文件</span>
              <span>
                {mmprojPath ? (
                  `已自动匹配 ${mmprojPath.replace(/[\\/]/g, "/").split("/").pop()}`
                ) : (
                  <span style={{ color: "var(--text-3)" }}>（未检测到，按文本模型处理）</span>
                )}
              </span>
            </div>
          </div>
        ) : null}

        {/* 模型类型提示 */}
        {meta ? (
          <div className="sec-desc" style={{ color: isVision ? "var(--accent)" : "var(--text-3)" }}>
            {isVision
              ? "✓ 已识别为视觉模型，可以在对话中发送图片。"
              : "已识别为文本模型，仅支持文字对话。"}
          </div>
        ) : null}

        {/* 高级设置 */}
        {meta ? (
          <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
            <summary className="sec-desc" style={{ cursor: "pointer", padding: "4px 0" }}>
              高级设置
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 0 0" }}>
              <Field label="MOMO 中显示的模型名称">
                <input
                  className="input nodrag"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="默认从文件名推断"
                />
              </Field>
              <Row gap={12}>
                <Field label="上下文长度">
                  <input
                    className="input sm nodrag"
                    type="number"
                    min={512}
                    max={131072}
                    value={numCtx}
                    onChange={(e) => setNumCtx(Number(e.target.value) || 4096)}
                  />
                </Field>
                <Field label="GPU 卸载层数">
                  <select
                    className="input sm nodrag"
                    value={String(gpuLayers)}
                    onChange={(e) =>
                      setGpuLayers(e.target.value === "auto" ? "auto" : Number(e.target.value))
                    }
                  >
                    <option value="auto">自动（推荐）</option>
                    <option value="0">0（纯 CPU）</option>
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="40">40</option>
                    <option value="99">99（尽可能全部）</option>
                  </select>
                </Field>
              </Row>
              <Field label="thinking（推理思考链）">
                <select
                  className="input sm nodrag"
                  value={reasoningMode}
                  onChange={(e) => setReasoningMode(e.target.value as "auto" | "on" | "off")}
                >
                  <option value="auto">自动（跟随模型默认）</option>
                  <option value="on">开启</option>
                  <option value="off">关闭</option>
                </select>
              </Field>
              <Field label="手工指定视觉投影 mmproj（可选）">
                <input
                  className="input nodrag"
                  value={mmprojPath}
                  onChange={(e) => setMmprojPath(e.target.value)}
                  placeholder="留空 = 按文本模型处理"
                />
              </Field>
              <Row gap={8}>
                <button className="btn sm" onClick={() => setLocalLlmSetupOpen(true)}>
                  配置 llama-server 路径
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      const info = await detectLlamaServer();
                      toast(
                        info.path
                          ? `已找到 llama-server：${info.path}${info.version ? `（${info.version}）` : ""}`
                          : "未找到 llama-server，请点「配置 llama-server 路径」",
                        info.path ? "ok" : "info",
                      );
                    } catch (e) {
                      toast(`探测失败：${errMsg(e)}`, "err");
                    }
                  }}
                >
                  重新探测引擎
                </button>
              </Row>
              {/* 启动参数预览 */}
              <details>
                <summary className="sec-desc" style={{ cursor: "pointer" }}>
                  启动参数预览
                </summary>
                <pre
                  className="gguf-cmd"
                  style={{
                    background: "var(--bg-app)",
                    padding: 8,
                    borderRadius: "var(--r-sm)",
                    fontSize: 11.5,
                    margin: "6px 0 0",
                  }}
                >
                  {previewStartCmd(ggufPath, mmprojPath, numCtx, gpuLayers)}
                </pre>
              </details>

              {/* 旧 Ollama 导入流程（次要入口） */}
              <details open={showOllamaLegacy} onToggle={(e) => setShowOllamaLegacy((e.target as HTMLDetailsElement).open)}>
                <summary className="sec-desc" style={{ cursor: "pointer", color: "var(--text-3)" }}>
                  通过 Ollama 导入纯文本模型（高级 · 需已安装 Ollama）
                </summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 0 0" }}>
                  <div className="sec-desc" style={{ fontSize: 11.5 }}>
                    此入口仍生成 Modelfile 文本和 ollama create 命令，需手动在终端执行。仅推荐已使用 Ollama 的用户。
                  </div>
                  <Field label="Ollama 模型名（ollama create 的名字）">
                    <input
                      className="input nodrag"
                      value={ollamaModelName}
                      onChange={(e) => setOllamaModelName(e.target.value)}
                      placeholder="如 my-qwen-9b"
                    />
                  </Field>
                  <Field label="系统提示词（可选，仅 Ollama 流程）">
                    <textarea
                      className="textarea nodrag nowheel"
                      rows={2}
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      placeholder="你是一位专业的助手…"
                    />
                  </Field>
                  <div className="ds-section-title" style={{ marginTop: 6 }}>
                    导入步骤
                  </div>
                  <pre className="gguf-cmd" style={{ background: "var(--bg-app)", padding: 8, borderRadius: "var(--r-sm)", fontSize: 11.5 }}>
                    {steps}
                  </pre>
                  <div className="ds-section-title">Modelfile 内容</div>
                  <pre className="gguf-cmd" style={{ background: "var(--bg-app)", padding: 8, borderRadius: "var(--r-sm)", fontSize: 11.5 }}>
                    {modelfile}
                  </pre>
                  <button className="btn sm" onClick={() => copyText(modelfile, "Modelfile")}>
                    <IcCopy size={13} /> 复制 Modelfile
                  </button>
                </div>
              </details>
            </div>
          </details>
        ) : null}

        {/* 主按钮 */}
        {meta ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <button
              className="btn primary"
              onClick={() => void onAddAndTest()}
              disabled={busy || !ggufPath}
              style={{ flex: "0 0 auto" }}
            >
              {busy ? <IcLoading size={14} /> : <IcSparkles size={14} />} 添加并测试
            </button>
            {busy && busyMsg ? <span className="sec-desc">{busyMsg}</span> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** 本地 GGUF 模型管理弹窗 — 已导入模型列表（删除 / 继续添加）。
 *  挂在模型配置的「本地 GGUF」固定卡片上：导入即生成一张专属卡片，点开就能管。
 *  删除只删注册项并停掉 llama-server 进程，不动用户的 GGUF 文件。 */
export function GgufManageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const models = useLocalGguf((s) => s.models);
  const removeModel = useLocalGguf((s) => s.removeModel);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  if (!open) return null;

  const openImport = () => {
    onClose();
    useUi.getState().setGgufImportOpen(true);
  };

  // portal 到 body：本弹窗可能嵌套在设置弹窗里打开，避免两层 modal-mask 叠盖
  return createPortal(
    <Modal title="本地 GGUF 模型" onClose={onClose} width={640}>
      <div className="nodrag gguf-mgr" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!isTauri ? (
          <div className="sec-desc" style={{ color: "var(--warn, #e0a228)" }}>
            ⚠️ 浏览器预览模式只能查看注册列表，无法启动本地模型。请在桌面版使用。
          </div>
        ) : null}
        <Row>
          <button className="btn primary" onClick={openImport} title="打开导入弹窗，选择 .gguf 文件添加">
            <IcPlus size={14} /> 添加模型
          </button>
          <span style={{ flex: 1 }} />
          <span className="sec-desc">
            已导入 {models.length} 个模型 · 删除只移除注册项与运行进程，不会删除磁盘上的 GGUF 文件
          </span>
        </Row>
        {models.length ? (
          <div className="gguf-mgr-list">
            {models.map((m) => (
              <div key={m.id} className="gguf-mgr-item">
                <span className="gguf-mgr-logo">🧠</span>
                <div className="gguf-mgr-info">
                  <div className="gguf-mgr-name">
                    <b>{m.name}</b>
                    <span
                      className="ds-badge"
                      style={{
                        background: m.capabilities.vision
                          ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                          : "var(--hover)",
                        color: m.capabilities.vision ? "var(--accent)" : "var(--text-3)",
                      }}
                    >
                      {m.capabilities.vision ? "视觉" : "文本"}
                    </span>
                  </div>
                  <div className="sec-desc">
                    {[m.quantization ? `量化 ${m.quantization}` : "", m.architecture, fmtBytes(m.sizeBytes ?? 0)]
                      .filter(Boolean)
                      .join(" · ")}
                    {m.ggufPath ? ` · ${m.ggufPath}` : ""}
                  </div>
                </div>
                <button
                  className="icon-btn danger"
                  title={confirmDel === m.id ? "再点一次确认删除" : "删除该模型注册项（不删文件）"}
                  style={
                    confirmDel === m.id
                      ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)" }
                      : undefined
                  }
                  onClick={() => {
                    if (confirmDel === m.id) {
                      removeModel(m.id);
                      setConfirmDel(null);
                      toast(`已移除「${m.name}」（GGUF 文件保留在磁盘上）`, "ok");
                    } else setConfirmDel(m.id);
                  }}
                >
                  {confirmDel === m.id ? <IcClose size={15} /> : <IcTrash size={15} />}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="gguf-mgr-empty">
            <div className="gguf-mgr-logo">🧠</div>
            <div className="sec-desc">
              还没有导入本地 GGUF 模型。点上方「添加模型」选择 .gguf 文件，一键注册并启动 llama-server。
            </div>
          </div>
        )}
        <Row style={{ justifyContent: "flex-end" }}>
          <button
            className="btn sm"
            title="配置本地模型引擎（llama-server 路径）"
            onClick={() => useUi.getState().setLocalLlmSetupOpen(true)}
          >
            🔧 本地引擎
          </button>
        </Row>
      </div>
    </Modal>,
    document.body,
  );
}

/** 格式化字节数（GiB / MiB） */
function fmtBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

/** 从 GGUF 文件名推断模型显示名 */
function deriveName(filename: string): string {
  const base = filename.replace(/\.gguf$/i, "");
  return base.replace(/[-_.]?(iq)?q[0-9]_[a-z_]+|[-_.]?(iq)?q[0-9]+|[-_.]?bpw/i, "").trim() || base;
}

/** 预览启动命令（仅展示，不执行） */
function previewStartCmd(
  ggufPath: string,
  mmprojPath: string,
  ctxSize: number,
  gpuLayers: "auto" | number,
): string {
  // 用数组拼接，避免模板字符串里的反斜杠转义陷阱
  const backslash = " \\";
  const lines: string[] = [];
  lines.push("llama-server" + backslash);
  lines.push(`  --model "${ggufPath}"` + backslash);
  if (mmprojPath) lines.push(`  --mmproj "${mmprojPath}"` + backslash);
  lines.push("  --host 127.0.0.1" + backslash);
  lines.push("  --port <自动分配>" + backslash);
  lines.push(`  --ctx-size ${ctxSize}` + backslash);
  if (gpuLayers !== "auto") lines.push(`  -ngl ${gpuLayers}` + backslash);
  lines.push("  --alias <模型显示名>");
  return lines.join("\n");
}
