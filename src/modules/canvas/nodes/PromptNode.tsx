import { memo, useMemo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcText } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { collectImageRefsFor } from "../../../core/runner";
import { Thumb } from "../../../ui/Thumb";
import { PromptToolsBtn } from "../../../ui/PromptToolsBtn";
import { AtTextArea, type AtTextAreaHandle } from "../../../ui/AtTextArea";
import type { PromptData } from "../../../core/types";

/** 与本提示词共同接入同一个下游生成节点的上游图片（供 @ 引用；含组成员图） */
function useSiblingImages(id: string) {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  return useMemo(() => {
    const targets = edges.filter((e) => e.source === id).map((e) => e.target);
    const out: { src: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      // 复用 runner 的参考图收集（与 collectUpstream 同序、含组展开），保证 @图N 编号与发给模型时一致
      for (const r of collectImageRefsFor(t)) {
        if (seen.has(r.src)) continue;
        seen.add(r.src);
        out.push(r);
      }
    }
    return out;
  }, [nodes, edges, id]);
}

export const PromptNode = memo(function PromptNode({ id, data, selected }: NodeProps) {
  const d = data as PromptData;
  const upd = useBoard((s) => s.updateData);
  const images = useSiblingImages(id);
  const editorRef = useRef<AtTextAreaHandle>(null);

  const insertAt = (label: string) => {
    if (editorRef.current) {
      editorRef.current.insertToken(label);
      return;
    }
    upd(id, { text: `${d.text}${d.text && !d.text.endsWith(" ") ? " " : ""}@${label} ` });
  };

  return (
    <NodeShell
      id={id}
      title="提示词"
      icon={<IcText size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={290}
      headExtra={<PromptToolsBtn value={d.text} image={images[0]?.src} onApply={(t) => upd(id, { text: t }, { commit: true })} />}
    >
      <div className="mnode-body">
        {images.length ? (
          <div className="ref-strip">
            <span className="rs-lab">同路参考图 · 点击引用到提示词</span>
            <div className="rs-chips">
              {images.map((im, i) => (
                <button
                  key={im.label}
                  className="img-chip"
                  title={`插入引用（如：图${i + 1} 把背景换成夜景）· 发给模型时按「图${i + 1}」编号`}
                  onClick={() => insertAt(im.label)}
                >
                  <Thumb src={im.src} alt="" />
                  <b>图{i + 1}</b>
                  {im.label !== `图${i + 1}` ? <span className="ic-name">{im.label}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="ta-wrap">
          <AtTextArea
            ref={editorRef}
            rows={5}
            placeholder="描述你想要的画面…"
            value={d.text}
            onChange={(t) => upd(id, { text: t }, { commit: true })}
            refs={images}
          />
          <span className="ta-count">{d.text.length} 字</span>
        </div>
      </div>
      <PortOut kind="text" />
    </NodeShell>
  );
});
