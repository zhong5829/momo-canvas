/**
 * ModelScope 生图底部参数面板 — 对齐「生成图像」面板布局：
 * 复用 GenPromptBar（顶部提示词条 + 发送/历史/上游）+ toolbar 里放模型选择与参数浮层按钮。
 * 参数浮层：比例 × 分辨率 → WxH（modelscope 的 size 字段），数量，以及 ModelScope 专属 LoRA 多选。
 */
import { useBoard } from "../../core/stores/boardStore";
import { GenPromptBar } from "./GenPromptBar";
import { NodeParamsPop } from "../../ui/NodeParamsPop";
import { ModelPicker } from "../../ui/ModelPicker";
import { splitModelKey } from "../../core/stores/settingsStore";
import { gptSize } from "../../core/modelMeta";
import { IcImage } from "../../ui/icons";
import type { MsImageGenData } from "../../core/types";

/** ModelScope 平台预置 LoRA（与参考项目官方 LoRA 一致，按 targetModel 匹配模型展示） */
const MS_LORAS: { id: string; name: string; targetModel: string; strength: number }[] = [
  { id: "Daniel8152/film", name: "Z-Image Film", targetModel: "Tongyi-MAI/Z-Image-Turbo", strength: 0.8 },
  { id: "Daniel8152/Qwen-Image-2512-Film", name: "Qwen Image 2512 Film", targetModel: "Qwen/Qwen-Image-2512", strength: 0.8 },
  { id: "Daniel8152/Klein-enhance", name: "Klein enhance", targetModel: "black-forest-labs/FLUX.2-klein-9B", strength: 0.8 },
];

const RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16"];
const TIERS = ["1K", "2K", "4K"];

export function MsImageGenConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "msImageGen" ? sel[0].id : null;
  });
  const d = useBoard((s) => (selId ? (s.nodes.find((n) => n.id === selId)?.data as MsImageGenData | undefined) : undefined));
  const upd = useBoard((s) => s.updateData);

  if (!selId || !d) return null;
  const patch = (p: Partial<MsImageGenData>) => upd(selId, p);

  // 当前选中模型名（复合键 providerId::model），用于过滤可用 LoRA
  const { model } = splitModelKey(d.modelId ?? "");
  const curLoras = MS_LORAS.filter((l) => !model || l.targetModel === model);
  const selLoras = d.loras ?? {};

  const aspect = d.aspect || "1:1";
  const tier = d.resolution || "1K";
  const applyRatio = (r: string) => {
    const s = gptSize(r, tier);
    if (!s) return;
    patch({ aspect: r, size: `${s.w}x${s.h}` });
  };
  const applyTier = (t: string) => {
    const s = gptSize(aspect, t);
    if (!s) return;
    patch({ resolution: t, size: `${s.w}x${s.h}` });
  };

  return (
    <div className="gen-panel">
      <GenPromptBar
        nodeId={selId}
        kind="msImageGen"
        toolbar={
          <>
            <ModelPicker role="image" value={d.modelId} onChange={(v) => patch({ modelId: v })} up />
            <NodeParamsPop icon={<IcImage size={15} />} label={`${aspect} · ${tier}`} title="ModelScope 参数" up>
              <div className="gp-sec-title">
                比例 <span className="gp-hint">与分辨率折算成 WxH 发给平台</span>
              </div>
              <div className="gp-grid ratios" style={{ gridTemplateColumns: `repeat(9, minmax(0, 1fr))` }}>
                {RATIOS.map((a) => (
                  <button key={a} className={`gp-cell ${aspect === a ? "on" : ""}`} onClick={() => applyRatio(a)}>
                    {a}
                  </button>
                ))}
              </div>
              <div className="gp-sec-title">分辨率</div>
              <div className="gp-seg">
                {TIERS.map((t) => (
                  <button key={t} className={tier === t ? "on" : ""} onClick={() => applyTier(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <div className="gp-sec-title">
                数量 <span className="gp-hint">当前 {d.count} 张（并发提交多个任务）</span>
              </div>
              <div className="gp-dur">
                <input
                  type="range"
                  className="range nodrag"
                  style={{ flex: 1, minWidth: 90 }}
                  min={1}
                  max={8}
                  step={1}
                  value={d.count ?? 1}
                  onChange={(e) => patch({ count: Number(e.target.value) })}
                />
              </div>
              {curLoras.length ? (
                <>
                  <div className="gp-sec-title">
                    LoRA <span className="gp-hint">仅随当前模型展示，勾选即用默认强度</span>
                  </div>
                  <div className="gp-opts">
                    {curLoras.map((l) => (
                      <label key={l.id} className="gp-check nodrag" title={`${l.id} · 强度 ${l.strength}`}>
                        <input
                          type="checkbox"
                          checked={l.id in selLoras}
                          onChange={(e) => {
                            const next = { ...selLoras };
                            if (e.target.checked) next[l.id] = l.strength;
                            else delete next[l.id];
                            patch({ loras: next });
                          }}
                        />
                        {l.name}
                      </label>
                    ))}
                  </div>
                </>
              ) : null}
            </NodeParamsPop>
          </>
        }
      />
    </div>
  );
}
