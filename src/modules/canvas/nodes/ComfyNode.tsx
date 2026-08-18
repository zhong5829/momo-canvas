import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortIn, PortOut } from "../NodeShell";
import { EditSurface } from "../EditSurface";
import { IcCopy, IcDice, IcDownload, IcFlow, IcLoading, IcRows } from "../../../ui/icons";
import { Switch } from "../../../ui/kit";
import { useBoard } from "../../../core/stores/boardStore";
import { useComfyTemplates } from "../../../core/stores/comfyStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { saveImageAs } from "../../../core/services/imageSaver";
import { buildImageEntries, COMFY_SLOT_NONE, effectiveParams } from "../../../core/services/comfy";
import { errMsg } from "../../../core/utils";
import { Thumb } from "../../../ui/Thumb";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { ComfyData, ComfyExposedParam } from "../../../core/types";

export const ComfyNode = memo(function ComfyNode({ id, data, selected }: NodeProps) {
  const d = data as ComfyData;
  const upd = useBoard((s) => s.updateData);
  const templates = useComfyTemplates();
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const tpl = templates.find((t) => t.id === d.templateId);
  const main = d.results?.[d.picked ?? 0];

  const save = async () => {
    if (!main) return;
    try {
      const p = await saveImageAs(main, useSettings.getState().settings.save, { model: tpl?.name });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="ComfyUI 工作流"
      icon={<IcFlow size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      hideUpstream
      headExtra={
        main ? (
          <span className="acts nodrag">
            <button className="icon-btn" title="保存到本地" aria-label="保存到本地" onClick={save}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        {tpl ? (
          <>
          <div className="gen-sum" title="模板与参数在底部设置面板调整（选中本节点即弹出）">
            {tpl.name}
            {(() => {
              const eff = effectiveParams(tpl, d.variantId);
              const vName = d.variantId ? tpl.variants?.find((v) => v.id === d.variantId)?.name : undefined;
              const vTag = vName && vName !== "默认" ? ` · ${vName}` : "";
              const branchParams = (d.variantId ? d.paramsByVariant?.[d.variantId] : undefined) ?? d.params ?? {};
              return eff.length ? `${vTag} · ${Object.keys(branchParams).length}/${eff.length} 参数已调` : vTag;
            })()}
          </div>
          {(() => {
            // 输入映射徽章：一眼看出哪张图被精确指定到了哪个入口（∅ = 明确不给图）
            const map = d.imageSlotMap ?? {};
            const mapped = buildImageEntries(tpl, d.variantId).filter((e) => e.key in map);
            if (!mapped.length) return null;
            return (
              <div className="comfy-slot-badges nodrag" title="输入映射：已精确指定这些入口的图（在底部「输入映射」里调整）">
                {mapped.map((e) => (
                  <span key={e.key} className="comfy-slot-badge" title={`入口 ${e.label}（${e.key}）`}>
                    {e.label.slice(0, 8)} {map[e.key] === COMFY_SLOT_NONE ? "∅" : "✓"}
                  </span>
                ))}
              </div>
            );
          })()}
          </>
        ) : (
          <div className="hint" style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6 }}>
            选中本节点，在底部设置面板选择工作流模板并调整参数
          </div>
        )}

        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
            {d.progressPct !== undefined ? <b className="pl-pct">{d.progressPct}%</b> : null}
          </div>
        ) : null}
        {running && d.progressPct !== undefined ? (
          <div className="progress-bar" title={`${d.progressPct}%`}>
            <i style={{ width: `${d.progressPct}%` }} />
          </div>
        ) : null}
        {main && !running ? (
          <>
            <EditSurface id={id} src={main}>
              <Thumb className="img-main" src={main} alt="" res onClick={() => setLightbox(main)} />
            </EditSurface>
            {d.results.length > 1 ? (
              <div className="thumbs nodrag">
                {d.results.map((s, i) => (
                  <Thumb
                    key={i}
                    src={s}
                    className={i === (d.picked ?? 0) ? "on" : ""}
                    onClick={() => upd(id, { picked: i })}
                    alt=""
                  />
                ))}
                <button
                  className="icon-btn"
                  title={`对比视图：${d.results.length} 张并排挑图`}
                  aria-label="对比视图"
                  onClick={() => useUi.getState().setLightboxList(d.results)}
                >
                  <IcRows size={13} />
                </button>
              </div>
            ) : null}
          </>
        ) : null}
        {!main && d.videoResults?.length && !running ? (
          <VideoThumb className="img-main" src={d.videoResults[0]} />
        ) : null}
        {d.textOut && !running ? (
          <div className="comfy-textout nodrag">
            <pre>{d.textOut}</pre>
            <button
              className="btn sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(d.textOut!)
                  .then(() => toast("已复制文本 ✓", "ok"))
                  .catch(() => toast("复制失败，请手动选择文本复制", "err"))
              }
            >
              <IcCopy size={14} /> 复制文本输出
            </button>
          </div>
        ) : null}
      </div>
      <PortIn />
      <PortOut kind={d.videoResults?.length && !d.results?.length ? "video" : "image"} />
    </NodeShell>
  );
});

export function ParamField({
  p,
  value,
  onChange,
  options,
}: {
  p: ComfyExposedParam;
  value: string | number | undefined;
  onChange: (v: string | number | boolean) => void;
  /** combo 参数的可选项（来自 ComfyUI /object_info；有则渲染下拉而非文本框） */
  options?: string[];
}) {
  const v = value !== undefined ? value : (p.value as string | number);
  const label = (
    <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>{p.label}</label>
  );
  switch (p.kind) {
    case "text":
      if (options?.length) {
        const cur = String(v ?? p.options?.[0] ?? options[0]);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {label}
            <select
              className="input nodrag"
              style={{ minHeight: 34 }}
              title="下拉选项来自 ComfyUI 节点定义（object_info）"
              value={options.includes(cur) ? cur : options[0]}
              onChange={(e) => onChange(e.target.value)}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        );
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {label}
          <textarea
            className="textarea nodrag nowheel"
            rows={2}
            value={String(v ?? "")}
            placeholder="留空则使用上游文本"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "seed":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {label}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="input nodrag"
              type="number"
              style={{ minHeight: 34 }}
              value={Number(v ?? 0)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <button
              className="icon-btn nodrag"
              title="随机种子"
              onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}
            >
              <IcDice size={18} />
            </button>
          </div>
        </div>
      );
    case "number":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>{label}</span>
          <input
            className="input nodrag"
            type="number"
            style={{ width: 110, minHeight: 34 }}
            value={Number(v ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      );
    case "toggle":
      return (
        <div className="nodrag" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>{label}</span>
          <Switch on={Boolean(v)} onChange={(b) => onChange(b)} />
        </div>
      );
    case "image":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {label}
          <input
            className="input nodrag"
            style={{ minHeight: 34 }}
            value={String(v ?? "")}
            placeholder="留空则使用上游图片（自动上传）"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}
