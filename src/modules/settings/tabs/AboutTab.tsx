/**
 * 设置面板 · 关于与更新页
 */
import { useEffect, useState } from "react";
import { errMsg, isTauri } from "../../../core/utils";
import { checkUpdate, currentVersion, isPortable, GH_REPO, type UpdateInfo } from "../../../core/services/updater";
import { IcLoading, IcLogo } from "../../../ui/icons";

export function AboutTab() {
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
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">关于与更新</div>
        <div className="set-page-d">版本信息、一键更新与数据隐私说明。</div>
      </div>

      <div className="about-card">
        <IcLogo size={40} />
        <div>
          <b style={{ fontSize: 16 }}>MOMO 智能画布</b>
          <div className="set-hint" style={{ marginTop: 2 }}>
            当前版本 v{ver} ·{" "}
            {mode === "web" ? "浏览器预览" : mode === "portable" ? "便携版（更新时下载 zip 自动替换）" : "安装版（更新时自动下载安装）"}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !isTauri} onClick={() => void doCheck()}>
          {busy ? <IcLoading size={15} /> : null} 检查更新
        </button>
      </div>
      {status ? <p className="set-hint" style={{ whiteSpace: "pre-wrap" }}>{status}</p> : null}
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

      <div className="set-card">
        <div className="set-card-h">数据与隐私</div>
        <p className="set-hint">
          所有配置（含 API Key）、画布、资产、模板都只保存在<b>本机</b>的应用数据目录，不打进安装包、不上传任何服务器；
          把安装包/便携包分发给别人，对方拿到的是<b>全新空白配置</b>，不会带上你的密钥。
        </p>
        {dataDir ? (
          <p className="set-hint" style={{ userSelect: "text", marginTop: 6 }}>
            数据目录：<code>{dataDir}</code>
          </p>
        ) : null}
        <p className="set-hint" style={{ marginTop: 6 }}>
          更新源：GitHub 仓库 <code>{GH_REPO}</code> 的 Releases（发布新版本后，这里一键升级）。
        </p>
      </div>
    </div>
  );
}
