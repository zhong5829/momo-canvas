/**
 * 设置 → 超清模型：管理本地超分/修复/人脸 ONNX 模型（查看在位状态 / 重新下载 / 删除）
 */
import { useEffect, useState } from "react";
import { LOCAL_MODELS, modelStatus, deleteModelFile, redownloadModel, type LocalModelTask } from "../../core/localModelRegistry";
import { toast } from "../../core/stores/uiStore";
import { IcDownload, IcLoading, IcTrash } from "../../ui/icons";

type Status = { downloaded: boolean; bytes: number; bundled: boolean; bundledBytes: number } | null;

/** 模型任务分组（展示顺序即数组顺序） */
const TASK_GROUPS: { task: LocalModelTask; label: string; hint: string }[] = [
  { task: "super-resolution", label: "超分模型", hint: "生产默认=Nomos/RealPLKSR；UltraSharp V2 仅非商业手动细节" },
  { task: "repair", label: "修复预处理", hint: "JPEG 压缩痕迹明显时，超分前自动先去块" },
  { task: "face-detect", label: "人脸检测", hint: "人像档的路由依据（轻量，常驻无忧）" },
  { task: "face-upscale", label: "人脸增强", hint: "人像档默认：128–256px 人脸 ROI 保真增强" },
  { task: "face-restore", label: "生成式人脸修复（可选）", hint: "默认关闭，开启对应功能时才下载（各 ~350MB）" },
];

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function EnhanceModelsTab() {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const next: Record<string, Status> = {};
    for (const m of LOCAL_MODELS) next[m.id] = await modelStatus(m.id);
    setStatuses(next);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const onRedownload = async (id: string) => {
    setBusy(id);
    try {
      await redownloadModel(id);
      toast("模型已重新下载并校验", "ok");
    } catch (e) {
      toast(`下载失败：${e}`, "err");
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const onDelete = async (id: string) => {
    if (!window.confirm("删除该模型文件？节点下次运行时会自动重新下载。")) return;
    setBusy(id);
    try {
      await deleteModelFile(id);
      toast("已删除", "ok");
    } catch (e) {
      toast(`删除失败：${e}`, "err");
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">本地超清模型（DirectML）</div>
        <div className="set-page-d">必需模型随安装包内嵌开箱即用；可选模型与重下副本存 AppData/models。</div>
      </div>
      {TASK_GROUPS.map((g) => {
        const models = LOCAL_MODELS.filter((m) => m.task === g.task);
        if (!models.length) return null;
        return (
          <div key={g.task} className="set-card">
            <div className="set-card-h">{g.label}</div>
            <div className="set-hint">{g.hint}</div>
            <div className="lm-list">
              {models.map((m) => {
                const st = statuses[m.id];
                // 可用 = AppData 副本或安装包内嵌任一在位；展示优先 AppData 副本（重下会覆盖内嵌版）
                const ok = !!(st?.downloaded || st?.bundled);
                const primaryBytes = st?.downloaded ? st.bytes : (st?.bundledBytes ?? 0);
                const sizeMismatch = ok && primaryBytes > 0 && primaryBytes !== m.size;
                return (
                  <div key={m.id} className="lm-item">
                    <div className="lm-info">
                      <div className="lm-name">
                        {m.displayName}{" "}
                        <span className={`lm-tag ${ok ? "on" : ""}`}>{ok ? "已就绪" : "未下载"}</span>
                        {st?.bundled ? <span className="lm-tag on" title="随安装包内嵌分发，不占用下载流量">内置</span> : null}
                        {st?.downloaded && st?.bundled ? <span className="lm-tag" title="AppData 存在重下副本，优先生效">已覆盖内置</span> : null}
                        {m.optional ? <span className="lm-tag">可选·按需下载</span> : null}
                        {m.bundleByDefault ? <span className="lm-tag on">生产内置</span> : null}
                        {m.commercialUse === "non-commercial" ? <span className="lm-tag warn">禁止商业内置</span> : null}
                        {m.commercialUse === "review" ? <span className="lm-tag warn">商用需复核</span> : null}
                        {sizeMismatch ? <span className="lm-tag warn">大小不符</span> : null}
                      </div>
                      <div className="lm-meta">
                        {m.scale}× · {m.architecture} · {fmtBytes(primaryBytes || m.size)}
                        {ok && primaryBytes ? ` / 期望 ${fmtBytes(m.size)}` : ""} · {m.tags.join(" / ")} · {m.license}
                      </div>
                    </div>
                    <div className="lm-actions">
                      <button className="btn sm" disabled={busy === m.id} title={st?.downloaded ? "重新下载到 AppData" : "下载一份 AppData 副本（覆盖内置版）"} onClick={() => onRedownload(m.id)}>
                        {busy === m.id ? <IcLoading size={14} /> : <IcDownload size={14} />} 重下
                      </button>
                      <button
                        className="btn sm ghost"
                        disabled={!st?.downloaded || busy === m.id}
                        title={st?.downloaded ? "删除 AppData 副本" : st?.bundled ? "内置模型随安装包提供，不可删除" : "未下载"}
                        onClick={() => onDelete(m.id)}
                      >
                        <IcTrash size={14} /> 删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="set-hint">
        模型文件不入 git。首跑已预拷，通常无需手动管理；仅在排查“模型损坏/想换版本”时用这里。
      </div>
    </div>
  );
}
