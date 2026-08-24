/**
 * MiniMax H3 底部参数面板 — 完全对齐「生成视频」面板布局：
 * 复用 GenPromptBar（顶部提示词条 + 发送/历史/上游）+ toolbar 里放模型选择与参数浮层按钮。
 * 与节点内编辑并存（Data 同源），参数浮层用 NodeParamsPop + .gp-* 控件（theme.css 已带 :is(.gen-panel,.gp-scope) 前缀）。
 */
import { useBoard } from "../../core/stores/boardStore";
import { GenPromptBar } from "./GenPromptBar";
import { NodeParamsPop } from "../../ui/NodeParamsPop";
import { ModelPicker } from "../../ui/ModelPicker";
import { IcVideo } from "../../ui/icons";
import type { MinimaxVideoData } from "../../core/types";

const MODES: { value: MinimaxVideoData["mode"]; label: string }[] = [
  { value: "t2va", label: "文生" },
  { value: "i2va", label: "首帧" },
  { value: "fl2va", label: "首尾" },
  { value: "l2va", label: "尾帧" },
  { value: "ref2va", label: "多参考" },
];
const RESOLUTIONS = ["480p", "720p"];
const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "4:5", "5:4"];
const MODE_TIP: Record<string, string> = {
  t2va: "文生视频",
  i2va: "首帧生视频",
  fl2va: "首尾帧过渡",
  l2va: "尾帧生视频",
  ref2va: "多参考（≤9图 + ≤3音频）",
};

export function MinimaxVideoConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "minimaxVideo" ? sel[0].id : null;
  });
  const d = useBoard((s) => (selId ? (s.nodes.find((n) => n.id === selId)?.data as MinimaxVideoData | undefined) : undefined));
  const upd = useBoard((s) => s.updateData);

  if (!selId || !d) return null;
  const patch = (p: Partial<MinimaxVideoData>) => upd(selId, p);
  const mode = d.mode ?? "t2va";

  return (
    <div className="gen-panel">
      <GenPromptBar
        nodeId={selId}
        kind="minimaxVideo"
        toolbar={
          <>
            <ModelPicker role="video" value={d.modelId} onChange={(v) => patch({ modelId: v })} up />
            <NodeParamsPop
              icon={<IcVideo size={15} />}
              label={`${d.seconds}s · ${d.resolution} · ${d.aspect}`}
              title="MiniMax 参数"
              up
            >
              <div className="gp-sec-title">
                生成模式 <span className="gp-hint">{MODE_TIP[mode]}</span>
              </div>
              <div className="gp-seg">
                {MODES.map((m) => (
                  <button key={m.value} className={mode === m.value ? "on" : ""} onClick={() => patch({ mode: m.value })}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="gp-sec-title">分辨率</div>
              <div className="gp-seg">
                {RESOLUTIONS.map((r) => (
                  <button key={r} className={d.resolution === r ? "on" : ""} onClick={() => patch({ resolution: r })}>
                    {r}
                  </button>
                ))}
              </div>
              <div className="gp-sec-title">比例</div>
              <div className="gp-grid ratios" style={{ gridTemplateColumns: `repeat(9, minmax(0, 1fr))` }}>
                {ASPECTS.map((a) => (
                  <button key={a} className={`gp-cell ${d.aspect === a ? "on" : ""}`} onClick={() => patch({ aspect: a })}>
                    {a}
                  </button>
                ))}
              </div>
              <div className="gp-sec-title">
                秒数 <span className="gp-hint">当前 {d.seconds}s</span>
              </div>
              <div className="gp-dur">
                <input
                  type="range"
                  className="range nodrag"
                  style={{ flex: 1, minWidth: 90 }}
                  min={5}
                  max={15}
                  step={1}
                  value={Number(d.seconds)}
                  onChange={(e) => patch({ seconds: String(e.target.value) })}
                />
              </div>
              <div className="gp-sec-title">选项</div>
              <div className="gp-opts">
                <label className="gp-check nodrag" title="开启后授权 AI 重组提示词结构；默认关 = 官方 H3 直发不失真">
                  <input
                    type="checkbox"
                    checked={!!d.promptOptimization}
                    onChange={(e) => patch({ promptOptimization: e.target.checked })}
                  />
                  AI 优化提示词
                </label>
              </div>
            </NodeParamsPop>
          </>
        }
      />
    </div>
  );
}