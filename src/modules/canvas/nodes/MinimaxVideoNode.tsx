/**
 * MiniMax H3 专用视频节点 — 5 种生成模式 + 参数 + 参考图/音频（走上游连线）+ 官方 H3 提示词。
 * 参数集中在节点内编辑（非底部面板），结果直接预览可保存。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortIn, PortOut } from "../NodeShell";
import { IcDownload, IcLoading, IcVideo } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { ModelPicker } from "../../../ui/ModelPicker";
import { OptGrid, Switch } from "../../../ui/kit";
import type { MinimaxVideoData } from "../../../core/types";

const MODES: { value: MinimaxVideoData["mode"]; label: string }[] = [
  { value: "t2va", label: "文生" },
  { value: "i2va", label: "首帧" },
  { value: "fl2va", label: "首尾" },
  { value: "l2va", label: "尾帧" },
  { value: "ref2va", label: "多参考" },
];

const RESOLUTIONS = ["480p", "720p"];
const SECONDS = ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];
const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "4:5", "5:4"];

const MODE_TIP: Record<string, string> = {
  t2va: "文生视频：只接文本提示词",
  i2va: "首帧生视频：接 1 张上游图作首帧",
  fl2va: "首尾帧过渡：接上游图按序作首帧/尾帧（1-2 张）",
  l2va: "尾帧生视频：接 1 张上游图作尾帧",
  ref2va: "多参考：接 ≥1 张图（≤9）+ 音频（≤3）",
};

export const MinimaxVideoNode = memo(function MinimaxVideoNode({ id, data, selected }: NodeProps) {
  const d = data as MinimaxVideoData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";
  const mode = d.mode ?? "t2va";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      let model: string | undefined;
      try {
        model = resolveModelCard("video", d.modelId).model;
      } catch {
        /* 未配置模型时仅影响文件命名 */
      }
      const p = await saveVideoAs(d.resultUrl, useSettings.getState().settings.save, { prompt: d.prompt, model });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="MiniMax H3"
      icon={<IcVideo size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      hideUpstream
      headExtra={
        <>
          <button className="nt-btn primary" disabled={running} title="运行（上游可运行节点会按依赖先跑）" onClick={() => void runFlow(id)}>
            {running ? <IcLoading size={14} /> : <IcVideo size={14} />}
            {running ? "生成中" : "生成"}
          </button>
          {d.resultUrl ? (
            <button className="nt-btn" title="保存到本地" onClick={save}>
              <IcDownload size={14} /> 保存
            </button>
          ) : null}
        </>
      }
    >
      <div className="mnode-body">
        <div className="ta-wrap">
          <ModelPicker role="video" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
        </div>
        <OptGrid options={MODES} value={mode} onChange={(v) => upd(id, { mode: v as MinimaxVideoData["mode"] })} cols={5} />
        <div className="gp-hint" style={{ margin: "2px 0 6px" }}>{MODE_TIP[mode]}</div>

        <div className="llm-row">
          <span className="llm-lab">分辨率</span>
          <div className="chips nodrag">
            {RESOLUTIONS.map((r) => (
              <button key={r} className={`chip ${d.resolution === r ? "on" : ""}`} onClick={() => upd(id, { resolution: r })}>
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="llm-row">
          <span className="llm-lab">秒数</span>
          <div className="chips nodrag">
            {SECONDS.map((s) => (
              <button key={s} className={`chip ${d.seconds === s ? "on" : ""}`} onClick={() => upd(id, { seconds: s })}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="llm-row">
          <span className="llm-lab">比例</span>
          <div className="chips nodrag">
            {ASPECTS.map((a) => (
              <button key={a} className={`chip ${d.aspect === a ? "on" : ""}`} onClick={() => upd(id, { aspect: a })}>
                {a}
              </button>
            ))}
          </div>
        </div>

        <div className="llm-row">
          <span className="llm-lab">AI 优化</span>
          <Switch on={!!d.promptOptimization} onChange={(v) => upd(id, { promptOptimization: v })} />
          <span className="gp-hint">默认关 = 官方 H3 直发不失真</span>
        </div>

        <textarea
          className="textarea nodrag nowheel"
          rows={6}
          placeholder="任务提示词（可直贴官方 H3 三段/六段式）；留空自动取上游文本"
          value={d.prompt}
          onChange={(e) => upd(id, { prompt: e.target.value })}
        />

        {running ? (
          <div className="skeleton">
            <span>{d.progress || "正在提交并生成…"}</span>
          </div>
        ) : d.resultUrl ? (
          <video className="gen-video nodrag" src={d.resultUrl} controls playsInline style={{ width: "100%", borderRadius: 8 }} />
        ) : null}
      </div>
      <PortIn />
      <PortOut kind="video" />
    </NodeShell>
  );
});