/**
 * 角色卡节点 — 人物图片 → 视觉模型提炼档案 + 各素材提示词 → 一键生成三视图/表情/服装/立绘/设定卡
 *  素材逐张生成、每张内容不堆砌（格子少区域大）；「补一张」自动换下一组内容追加，逐张补全设定。
 *  输出统一单口：出图模式下勾选素材的首图全部传给下游（整套参考，角色一致性更稳）。
 *  也可从「角色库」应用预设（档案与提示词已就绪，直接生成）
 *
 *  节点本体只展示「结果」：档案 + 各素材图墙（带重新生成/补一张）。所有参数（模型/比例/风格/语言、
 *  素材勾选、提示词编辑）全在画布下方「角色卡参数栏」（选中本节点出现，与生图节点同款底部生成栏）。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, OutModeToggle, PortIn, PortOut } from "../NodeShell";
import { IcCopy, IcIdCard, IcLoading, IcPlus, IcRefresh, IcSparkles } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { regenCharDeliverable, runFlow } from "../../../core/runner";
import { CHAR_DELIVERABLES, DELIV_VARIATIONS } from "../../../core/charPresets";
import { Thumb } from "../../../ui/Thumb";
import type { CharCardData } from "../../../core/types";

export const CharCardNode = memo(function CharCardNode({ id, data, selected }: NodeProps) {
  const d = data as CharCardData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const p = d.profile;
  const hasPrompts = Object.values(d.prompts).some((t) => (t ?? "").trim());
  const mode = d.outMode ?? (d.genImages === false ? "prompt" : "image");
  // 节点只展示「已生成出图」的素材（勾选与提示词编辑都在底部参数栏）
  const resultRows = CHAR_DELIVERABLES.filter(
    (dv) => d.deliverables.includes(dv.value) && (d.results[dv.value]?.length ?? 0) > 0,
  );

  const copyPrompt = async (k: (typeof CHAR_DELIVERABLES)[number]["value"]) => {
    const t = (d.prompts[k] ?? "").trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      toast("提示词已复制", "ok");
    } catch {
      toast("复制失败：请从底部参数栏的「提示词」里手动复制", "err");
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
            <span>连接一张人物图片或一段角色文字描述后运行：模型提炼角色档案并产出整套素材；模型/比例/风格、素材勾选与提示词都在下方参数栏设置，也可从「角色库」应用预设</span>
          </div>
        )}

        {resultRows.length ? (
          <div className="cc-delivs nodrag">
            {resultRows.map((dv) => {
              const imgs = d.results[dv.value] ?? [];
              const canVary = !!DELIV_VARIATIONS[dv.value]?.length;
              return (
                <div key={dv.value} className="cc-deliv">
                  <div className="cc-deliv-head">
                    <span className="cc-deliv-name" title={dv.desc}>
                      {dv.label}
                    </span>
                    <span style={{ flex: 1 }} />
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
                  </div>
                  <div className="cc-deliv-imgs">
                    {imgs.map((s, i) => (
                      <Thumb key={i} src={s} alt="" onClick={() => setLightbox(s)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <button
          className="btn primary nodrag"
          disabled={running || (!!p && mode === "prompt" && hasPrompts)}
          title={
            p && mode === "prompt" && hasPrompts
              ? "提示词已就绪：在底部参数栏的「提示词」里查看，或从输出端口接给下游节点；切到「出图」可直接生成图片"
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
