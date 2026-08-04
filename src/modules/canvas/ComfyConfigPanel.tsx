/**
 * ComfyUI 设置面板 — 与生成图像同款底部弹窗：
 * 选中单个 ComfyUI 节点时弹出；chips 行 = 模板选择 / 模板管理 / 上游传入计数与详情 / 圆形运行按钮；
 * 模板暴露的参数在卡内直接调整（文本留空自动取上游、图片留空自动用上游图）。
 */
import { useEffect, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { useComfy } from "../../core/stores/comfyStore";
import { useUi } from "../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../core/runner";
import { PopSelect } from "../../ui/PopSelect";
import { IcGear, IcLoading, IcPlay } from "../../ui/icons";
import { UpstreamPanel } from "./GenPromptBar";
import { ParamField } from "./nodes/ComfyNode";
import type { ComfyData } from "../../core/types";

export function ComfyConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "comfy" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  const templates = useComfy((s) => s.templates);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const suppressed = useUi((s) => s.genPanelSuppressed);
  const [upOpen, setUpOpen] = useState(false);
  const upTextN = useBoard(() => (selId ? collectUpstream(selId).texts.length : 0));
  const upImgN = useBoard(() => (selId ? collectUpstream(selId).images.length : 0));
  // 本组件靠 return null 隐藏（不会卸载），换节点时手动收起上游面板
  useEffect(() => setUpOpen(false), [selId]);

  if (!selId || !node || suppressed) return null;
  const d = node.data as ComfyData;
  const tpl = templates.find((t) => t.id === d.templateId);
  const running = d.status === "running";
  const setParam = (key: string, v: string | number | boolean) =>
    upd(selId, { params: { ...d.params, [key]: v as string | number } });

  return (
    <div className="gen-panel">
      <div className="gd-main glass">
        <div className="gd-toolbar nodrag">
          <PopSelect
            style={{ minWidth: 220 }}
            title="工作流模板"
            value={d.templateId ?? ""}
            placeholder="选择工作流模板…"
            options={templates.map((t) => ({ value: t.id, label: t.name, desc: t.params.length ? `${t.params.length} 个参数` : undefined }))}
            onChange={(v) => upd(selId, { templateId: v || undefined, params: {} })}
            up
          />
          <button className="icon-btn" title="管理模板（导入 / 编辑要暴露的参数）" onClick={() => setTemplateMgr(true)}>
            <IcGear size={17} />
          </button>
          {upTextN > 0 || upImgN > 0 ? (
            <button
              className={`gd-up-toggle${upOpen ? " on" : ""}`}
              title="查看上游传入的提示词与图片（文本参数留空自动取上游文本，图片参数留空自动用上游图）"
              onClick={() => setUpOpen((v) => !v)}
            >
              上游{upTextN > 0 ? ` ${upTextN}段` : ""}
              {upImgN > 0 ? ` ${upImgN}图` : ""}
            </button>
          ) : null}
          <span className="gd-toolbar-sp" />
          <button
            className="gd-send"
            disabled={running || !tpl}
            title="运行工作流（上游未运行的节点会按依赖顺序先自动运行）"
            onClick={() => void runFlow(selId)}
          >
            {running ? <IcLoading size={17} /> : <IcPlay size={16} />}
          </button>
        </div>
        {tpl ? (
          tpl.params.length ? (
            <div className="cf-params nodrag nowheel">
              {tpl.params.map((p) => (
                <ParamField key={p.key} p={p} value={d.params?.[p.key]} onChange={(v) => setParam(p.key, v)} />
              ))}
            </div>
          ) : (
            <div className="gp-hint" style={{ padding: "0 2px" }}>
              该模板没有暴露参数——点左侧齿轮可勾选要暴露的参数；直接点右侧圆钮即可运行。
            </div>
          )
        ) : (
          <div className="gp-hint" style={{ padding: "0 2px" }}>
            还没有模板？点齿轮导入 ComfyUI 工作流（API 格式 JSON），并勾选要暴露的参数。
          </div>
        )}
      </div>
      {upOpen ? <UpstreamPanel nodeId={selId} onClose={() => setUpOpen(false)} /> : null}
    </div>
  );
}
