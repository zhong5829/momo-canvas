/**
 * MiniMax H3 专用视频节点 — 精简卡（同生成视频）：画布上只留结果视频；
 * 参数（模式/分辨率/比例/秒数/优化/提示词）全部在选中后的底部面板编辑。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { mediaNodeWidth, NodeShell, PortIn, PortOut } from "../NodeShell";
import { IcDownload, IcLoading, IcScan, IcVideo } from "../../../ui/icons";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { useVideoDims, VideoThumb } from "../../../ui/VideoThumb";
import type { MinimaxVideoData } from "../../../core/types";

export const MinimaxVideoNode = memo(function MinimaxVideoNode({ id, data, selected }: NodeProps) {
  const d = data as MinimaxVideoData;
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  // 宽度随结果视频比例自适应（竖屏窄、横屏宽）
  const dims = useVideoDims(d.resultUrl);

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
      width={mediaNodeWidth(dims, 340)}
      hideUpstream
      media
      headExtra={
        <>
          <button className="nt-btn primary" disabled={running} title="生成（上游未运行的节点会按依赖顺序先自动运行）" onClick={() => void runFlow(id)}>
            {running ? <IcLoading size={14} /> : <IcVideo size={14} />}
            {running ? "生成中" : "生成"}
          </button>
          {d.resultUrl ? (
            <>
              <button className="nt-btn" title="放大播放" onClick={() => setLightbox(d.resultUrl!, null, "video")}>
                <IcScan size={14} /> 放大
              </button>
              <button className="nt-btn" title="保存到本地" onClick={save}>
                <IcDownload size={14} /> 保存
              </button>
            </>
          ) : null}
        </>
      }
    >
      <div className="mnode-body">
        {running ? (
          <div className="skeleton">
            <span>{d.progress || "正在生成视频…"}</span>
          </div>
        ) : d.resultUrl ? (
          <div className="media-main">
            <VideoThumb className="img-main" src={d.resultUrl} />
          </div>
        ) : (
          <div className="gen-empty">
            <IcVideo size={24} />
            <span>选中节点，在底部面板输入描述与参数</span>
          </div>
        )}
      </div>
      <PortIn />
      <PortOut kind="video" />
    </NodeShell>
  );
});