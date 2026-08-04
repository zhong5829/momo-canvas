/**
 * 生成音频 — LibLib 式精简节点：画布上只留结果播放器；
 * 文本/模型/音色在选中后的底部生成面板里编辑（openai 走 /audio/speech，自定义协议 {{prompt}}/{{voice}}）。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortTextIn } from "../NodeShell";
import { IcDownload, IcLoading, IcMic } from "../../../ui/icons";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveAudioAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import type { AudioGenData } from "../../../core/types";

export const AudioGenNode = memo(function AudioGenNode({ id, data, selected }: NodeProps) {
  const d = data as AudioGenData;
  const running = d.status === "running";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const p = await saveAudioAs(d.resultUrl, useSettings.getState().settings.save, { prompt: d.text });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="生成音频"
      icon={<IcMic size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
      hideUpstream
      headExtra={
        <>
          <button className="nt-btn primary" disabled={running} title="生成（上游未运行的节点会按依赖顺序先自动运行）" onClick={() => void runFlow(id)}>
            {running ? <IcLoading size={14} /> : <IcMic size={14} />}
            {running ? "合成中" : "生成"}
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
        {running ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress || "合成中…"}
          </div>
        ) : d.resultUrl ? (
          <audio className="audio-main nodrag" src={d.resultUrl} controls preload="none" />
        ) : (
          <div className="gen-empty sm">
            <IcMic size={20} />
            <span>选中节点，在底部面板输入文本</span>
          </div>
        )}
      </div>
      <PortTextIn />
      <PortOut kind="audio" />
    </NodeShell>
  );
});
