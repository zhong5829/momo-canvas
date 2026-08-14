/**
 * 本地模型引擎配置 — llama-server 路径的一次性选择 + 验证 + 运行中模型管理
 *
 * 设计（§6）：
 *  - 首次使用本地 GGUF 时弹出（detectLlamaServer 找不到时由 GgufImportDialog 触发）
 *  - 用户选择已有的 llama-server.exe 后验证（--version 能跑通）
 *  - 路径保存到 settings.localLlm.executablePath，所有本地模型复用
 *  - 第一版不实现自动下载（文档允许）
 *  - 浏览器预览模式：直接提示降级
 *  - 运行中模型列表：显示状态/端口，支持手动停止、查看最近日志（消费 getLogs，避免死代码）
 */
import { useEffect, useState } from "react";
import { Modal, Field } from "../../ui/kit";
import { useUi, toast, pushError } from "../../core/stores/uiStore";
import { useSettings } from "../../core/stores/settingsStore";
import { detectLlamaServer, setLlamaServerPath, getStatus, stopModel, getLogs } from "../../core/services/localLlm";
import { isTauri, errMsg } from "../../core/utils";
import { IcUpload, IcCheck, IcLoading, IcSparkles } from "../../ui/icons";
import type { LocalLlmStatus } from "../../core/types";

export function LocalLlmSetup() {
  const open = useUi((s) => s.localLlmSetupOpen);
  const close = () => useUi.getState().setLocalLlmSetupOpen(false);
  const update = useSettings((s) => s.update);
  const storedPath = useSettings((s) => s.settings.localLlm?.executablePath);
  const storedVersion = useSettings((s) => s.settings.localLlm?.version);

  const [pickPath, setPickPath] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<{ path: string; version: string | null } | null>(null);

  // 运行中模型状态（每 3s 轮询一次，弹窗关闭时停止）
  const [runningModels, setRunningModels] = useState<LocalLlmStatus[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null); // 展开日志的 modelId
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !isTauri) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await getStatus();
        if (!cancelled) setRunningModels(list);
      } catch {
        /* 静默 */
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  const onStop = async (modelId: string, name: string) => {
    try {
      await stopModel(modelId);
      toast(`已停止「${name}」并释放显存`, "ok");
      // 立即刷新
      const list = await getStatus();
      setRunningModels(list);
    } catch (e) {
      pushError("停止本地模型", errMsg(e));
    }
  };

  const onShowLogs = async (modelId: string) => {
    if (expandedLogs === modelId) {
      setExpandedLogs(null);
      setLogLines([]);
      return;
    }
    try {
      const lines = await getLogs(modelId);
      setExpandedLogs(modelId);
      setLogLines(lines);
    } catch (e) {
      toast(`读取日志失败：${errMsg(e)}`, "err");
    }
  };

  const onSelectExe = async () => {
    if (!isTauri) {
      toast("浏览器预览模式无法选择本地文件", "err");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [
          { name: "llama-server", extensions: ["exe"] },
          { name: "所有可执行文件", extensions: ["*"] },
        ],
      });
      if (!picked || Array.isArray(picked)) return;
      setPickPath(picked);
      setVerified(null);
    } catch (e) {
      toast(`选择文件失败：${errMsg(e)}`, "err");
    }
  };

  const onVerify = async () => {
    if (!pickPath) {
      toast("请先选择 llama-server 可执行文件", "err");
      return;
    }
    setVerifying(true);
    try {
      const info = await setLlamaServerPath(pickPath);
      setVerified({ path: info.path ?? pickPath, version: info.version });
      toast("llama-server 验证通过", "ok");
    } catch (e) {
      pushError("本地模型引擎配置", errMsg(e));
    } finally {
      setVerifying(false);
    }
  };

  const onAutoDetect = async () => {
    setVerifying(true);
    try {
      const info = await detectLlamaServer();
      if (info.path) {
        setPickPath(info.path);
        setVerified({ path: info.path, version: info.version });
        toast(`已自动找到 llama-server：${info.path}`, "ok");
      } else {
        toast(
          "未在常见位置找到 llama-server。请手动选择已下载的 llama-server.exe",
          "info",
        );
      }
    } catch (e) {
      pushError("本地模型引擎探测", errMsg(e));
    } finally {
      setVerifying(false);
    }
  };

  const onConfirm = () => {
    const path = verified?.path ?? pickPath;
    if (!path) {
      toast("请先选择并验证 llama-server", "err");
      return;
    }
    update("localLlm", {
      executablePath: path,
      version: verified?.version ?? undefined,
    });
    toast("本地模型引擎已配置，所有本地 GGUF 模型将自动复用", "ok");
    close();
  };

  return (
    <Modal title="本地模型引擎配置" onClose={close} width={560}>
      <div className="nodrag" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!isTauri ? (
          <div className="sec-desc" style={{ color: "var(--warn, #e0a228)" }}>
            ⚠️ 浏览器预览模式无法配置本地模型引擎。请在桌面版使用。
          </div>
        ) : null}

        <div className="sec-desc">
          本地 GGUF 模型需要 <b>llama-server</b>（llama.cpp 官方推理引擎）才能运行。
          这是一次性配置 —— 配置后所有本地 GGUF 模型都会自动复用这个引擎，无需重复设置。
        </div>

        {/* 当前已配置状态 */}
        {storedPath ? (
          <div
            style={{
              padding: "10px 12px",
              background: "color-mix(in srgb, var(--accent) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              borderRadius: "var(--r-md)",
              fontSize: 12.5,
            }}
          >
            <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>
              <IcCheck size={13} /> 当前已配置
            </div>
            <div className="sec-desc" style={{ wordBreak: "break-all" }}>
              {storedPath}
              {storedVersion ? `（${storedVersion}）` : ""}
            </div>
          </div>
        ) : null}

        {/* 运行中模型列表 */}
        {isTauri && runningModels.length > 0 ? (
          <div
            style={{
              padding: "10px 12px",
              background: "var(--panel)",
              border: "1px solid var(--panel-border)",
              borderRadius: "var(--r-md)",
              fontSize: 12.5,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--text-1)" }}>
              运行中的本地模型（{runningModels.length}）
            </div>
            {runningModels.map((m) => (
              <div
                key={m.modelId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 0",
                  borderBottom: "1px solid var(--panel-border)",
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="ds-badge"
                  style={{
                    background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                    color: "var(--accent)",
                    flexShrink: 0,
                  }}
                >
                  运行中
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.modelName}
                </span>
                <span className="sec-desc" style={{ flexShrink: 0 }}>:{m.port}</span>
                <button className="btn sm" onClick={() => onShowLogs(m.modelId)} style={{ flexShrink: 0 }}>
                  {expandedLogs === m.modelId ? "收起日志" : "日志"}
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => onStop(m.modelId, m.modelName)}
                  style={{ flexShrink: 0 }}
                >
                  停止
                </button>
                {expandedLogs === m.modelId ? (
                  <pre
                    style={{
                      flexBasis: "100%",
                      margin: "6px 0 0",
                      maxHeight: 160,
                      overflow: "auto",
                      padding: 8,
                      background: "var(--bg-app)",
                      borderRadius: "var(--r-sm)",
                      fontSize: 11,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {logLines.length ? logLines.join("\n") : "（暂无日志）"}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <Field label="选择 llama-server 可执行文件">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn sm" onClick={onSelectExe} disabled={!isTauri}>
              <IcUpload size={13} /> 选择 exe
            </button>
            <button className="btn sm" onClick={onAutoDetect} disabled={verifying || !isTauri}>
              {verifying ? <IcLoading size={13} /> : <IcSparkles size={13} />} 自动探测
            </button>
            {pickPath ? (
              <span className="sec-desc" style={{ wordBreak: "break-all", minWidth: 0, flex: 1 }}>
                {pickPath}
              </span>
            ) : null}
          </div>
        </Field>

        {/* 验证结果 */}
        {verified ? (
          <div
            style={{
              padding: "10px 12px",
              background: "color-mix(in srgb, var(--accent) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              borderRadius: "var(--r-md)",
              fontSize: 12.5,
              color: "var(--accent)",
            }}
          >
            <IcCheck size={13} /> 验证通过
            {verified.version ? ` · ${verified.version}` : ""}
          </div>
        ) : null}

        <div className="sec-desc" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
          <b>llama-server 从哪来？</b>
          <br />
          · 从 llama.cpp GitHub Releases 下载预编译包（推荐）：解压后能在 bin/ 目录找到
          <code style={{ margin: "0 4px" }}>llama-server.exe</code>
          <br />
          · 自己编译的 llama.cpp：在 build 目录里
          <br />
          · 不打包进 MOMO（多平台多硬件版本会膨胀数百 MB）
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <button className="btn sm" onClick={onVerify} disabled={!pickPath || verifying}>
            {verifying ? <IcLoading size={13} /> : null} 测试
          </button>
          <button className="btn sm primary" onClick={onConfirm} disabled={!verified && !pickPath}>
            确认保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
