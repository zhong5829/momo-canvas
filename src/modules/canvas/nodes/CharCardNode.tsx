/**
 * 角色卡节点 — 人物图片 → 视觉模型提炼档案 + 各素材提示词 → 一键生成三视图/表情/服装/立绘/设定卡
 *  素材逐张生成、每张内容不堆砌（格子少区域大）；「补一张」自动换下一组内容追加，逐张补全设定。
 *  输出统一单口：出图模式下勾选素材的首图全部传给下游（整套参考，角色一致性更稳）。
 *  也可从「角色库」应用预设（档案与提示词已就绪，直接生成）
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, OutModeToggle, PortIn, PortOut } from "../NodeShell";
import { IcCheck, IcCopy, IcIdCard, IcLoading, IcPlus, IcRefresh, IcSparkles } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { regenCharDeliverable, runFlow } from "../../../core/runner";
import { CARD_STYLES, CHAR_DELIVERABLES, DELIV_VARIATIONS } from "../../../core/charPresets";
import { Thumb } from "../../../ui/Thumb";
import type { CharCardData, CharDeliverable } from "../../../core/types";

export const CharCardNode = memo(function CharCardNode({ id, data, selected }: NodeProps) {
  const d = data as CharCardData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const p = d.profile;
  const hasPrompts = Object.values(d.prompts).some((t) => (t ?? "").trim());
  const mode = d.outMode ?? (d.genImages === false ? "prompt" : "image");

  const toggleDeliv = (k: CharDeliverable) => {
    const has = d.deliverables.includes(k);
    upd(id, { deliverables: has ? d.deliverables.filter((x) => x !== k) : [...d.deliverables, k] });
  };

  const copyPrompt = async (k: CharDeliverable) => {
    const t = (d.prompts[k] ?? "").trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      toast("提示词已复制", "ok");
    } catch {
      toast("复制失败：请从下方「查看/编辑提示词」里手动复制", "err");
    }
  };

  /** 清空档案与产出，重新走一遍分析 */
  const reset = () =>
    upd(id, { profile: undefined, prompts: {}, results: {}, status: "idle", error: undefined, presetName: undefined });

  return (
    <NodeShell
      id={id}
      title={p ? `角色卡 · ${p.name}` : "角色卡"}
      icon={<IcIdCard size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={380}
      headExtra={
        <span className="acts nodrag" style={{ opacity: 1, display: "flex", alignItems: "center", gap: 5 }}>
          <OutModeToggle id={id} mode={mode} />
          {p ? (
            <button className="icon-btn" title="清空档案与产出，重新分析" onClick={reset}>
              <IcRefresh size={15} />
            </button>
          ) : null}
        </span>
      }
    >
      <div className="mnode-body">
        {p ? (
          <div className="cc-profile">
            <div className="cc-name">
              <b>{p.name}</b>
              {p.nameEn ? <i>{p.nameEn}</i> : null}
              {d.presetName ? <span className="cc-preset-tag">角色库预设</span> : null}
            </div>
            <div className="cc-meta">
              {[p.age ? `${p.age} 岁` : "", p.occupation, p.artStyle].filter(Boolean).join(" · ")}
            </div>
            {p.keywords?.length ? (
              <div className="cc-chips">
                {p.keywords.slice(0, 6).map((k) => (
                  <span key={k} className="chip on">
                    {k}
                  </span>
                ))}
              </div>
            ) : null}
            {p.palette?.length ? (
              <div className="cc-palette">
                {p.palette.slice(0, 8).map((c, i) => (
                  <i key={i} style={{ background: c }} title={c} />
                ))}
              </div>
            ) : null}
            {p.intro ? <div className="cc-intro">{p.intro}</div> : null}
          </div>
        ) : (
          <div className="gen-sum">
            <IcIdCard size={13} />
            <span>连接一张人物图片或一段角色文字描述后运行：模型提炼角色档案并产出整套素材；也可从「角色库」应用预设</span>
          </div>
        )}

        {!p ? (
          <>
            <div className="cc-lab">设定卡排版风格</div>
            <div className="opt-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {CARD_STYLES.map((s) => (
                <button
                  key={s.value}
                  title={s.desc}
                  className={`opt-cell ${d.style === s.value ? "on" : ""}`}
                  onClick={() => upd(id, { style: s.value })}
                >
                  <span className="oc-lab">{s.label}</span>
                </button>
              ))}
            </div>
            <div className="ctl-row" title="生图提示词的语言：多数绘画模型英文效果更好">
              <span className="cc-lab" style={{ margin: 0 }}>提示词语言</span>
              <span style={{ flex: 1 }} />
              <span className="lang-seg">
                <button className={d.lang === "zh" ? "on" : ""} onClick={() => upd(id, { lang: "zh" })}>
                  中
                </button>
                <button className={d.lang === "en" ? "on" : ""} onClick={() => upd(id, { lang: "en" })}>
                  EN
                </button>
              </span>
            </div>
          </>
        ) : null}

        <div className="cc-lab">产出素材（勾选 · 逐张生成，「补一张」自动换组）</div>
        <div className="cc-delivs nodrag">
          {CHAR_DELIVERABLES.map((dv) => {
            const on = d.deliverables.includes(dv.value);
            const imgs = d.results[dv.value] ?? [];
            const hasP = !!(d.prompts[dv.value] ?? "").trim();
            const canVary = !!DELIV_VARIATIONS[dv.value]?.length;
            return (
              <div key={dv.value} className={`cc-deliv ${on ? "" : "off"}`}>
                <div className="cc-deliv-head">
                  <button className={`cc-check ${on ? "on" : ""}`} title={dv.desc} onClick={() => toggleDeliv(dv.value)}>
                    {on ? <IcCheck size={12} /> : null}
                  </button>
                  <span className="cc-deliv-name" title={dv.desc}>
                    {dv.label}
                  </span>
                  <span style={{ flex: 1 }} />
                  {hasP ? (
                    <>
                      <button className="icon-btn" title="复制该素材的提示词" onClick={() => void copyPrompt(dv.value)}>
                        <IcCopy size={14} />
                      </button>
                      {mode === "image" ? (
                        <>
                          <button
                            className="icon-btn"
                            title="重新生成该素材（替换现有图）"
                            disabled={running}
                            onClick={() => void regenCharDeliverable(id, dv.value)}
                          >
                            <IcRefresh size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title={
                              canVary
                                ? `补一张：${dv.label}自动换成下一组内容后追加（逐张补全设定）`
                                : "补一张：按同一提示词再生成一张并追加"
                            }
                            disabled={running}
                            onClick={() => void regenCharDeliverable(id, dv.value, { append: true })}
                          >
                            <IcPlus size={14} />
                          </button>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {imgs.length ? (
                  <div className="cc-deliv-imgs">
                    {imgs.map((s, i) => (
                      <Thumb key={i} src={s} alt="" onClick={() => setLightbox(s)} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {hasPrompts ? (
          <details className="cc-prompts nodrag">
            <summary>查看 / 编辑提示词</summary>
            {CHAR_DELIVERABLES.filter((dv) => (d.prompts[dv.value] ?? "").trim()).map((dv) => (
              <div key={dv.value} className="cc-prompt-item">
                <span className="cc-lab">{dv.label}</span>
                <textarea
                  className="textarea nodrag nowheel"
                  rows={3}
                  value={d.prompts[dv.value]}
                  onChange={(e) => upd(id, { prompts: { ...d.prompts, [dv.value]: e.target.value } })}
                />
              </div>
            ))}
          </details>
        ) : null}

        <div className="cc-models nodrag">
          <label title="分析人物图片/描述用的视觉对话模型">
            <span>分析</span>
            <ModelPicker role="chat" value={d.chatModelId} onChange={(v) => upd(id, { chatModelId: v })} />
          </label>
          {mode === "image" ? (
            <label title="生成素材图片用的绘画模型">
              <span>绘画</span>
              <ModelPicker role="image" value={d.imageModelId} onChange={(v) => upd(id, { imageModelId: v })} />
            </label>
          ) : null}
        </div>
        <button
          className="btn primary nodrag"
          disabled={running || (!!p && mode === "prompt" && hasPrompts)}
          title={
            p && mode === "prompt" && hasPrompts
              ? "提示词已就绪：在上方逐条复制，或从输出端口接给下游节点；切到「出图」可直接生成图片"
              : undefined
          }
          onClick={() => void runFlow(id)}
        >
          {running ? <IcLoading size={17} /> : <IcSparkles size={17} />}
          {running
            ? "运行中…"
            : p
              ? mode === "image"
                ? "生成整套素材"
                : "提示词已就绪"
              : mode === "image"
                ? "分析并生成"
                : "仅生成提示词"}
        </button>
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
      </div>
      <PortIn />
      <PortOut kind={mode === "prompt" ? "text" : "image"} />
    </NodeShell>
  );
});
