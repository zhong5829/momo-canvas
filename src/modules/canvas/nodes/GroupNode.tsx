/**
 * 组（主节点）：虚线框容器，拖动组时成员跟随；
 * 右侧统一出口把成员输出按位置顺序聚合给下游（端口统一后，按成员各自输出类型分流：文本/图片/视频/音频）
 * 头部可把整组（含内部连线）存为画布模板，Spotlight / 双击菜单可反复实例化
 */
import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoard } from "../../../core/stores/boardStore";
import { useTemplates } from "../../../core/stores/templateStore";
import { toast } from "../../../core/stores/uiStore";
import { IcCheck, IcGroup, IcLayers, IcTrash } from "../../../ui/icons";

export const GroupNode = memo(function GroupNode({ id, selected }: NodeProps) {
  const count = useBoard((s) => s.nodes.filter((n) => n.parentId === id).length);
  const removeNode = useBoard((s) => s.removeNode);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = () => {
    const s = useBoard.getState();
    const group = s.nodes.find((n) => n.id === id);
    const members = s.nodes.filter((n) => n.parentId === id);
    if (!group || !members.length) {
      toast("组里还没有节点", "err");
      return;
    }
    const finalName = name.trim() || `组模板 · ${members.length} 节点`;
    useTemplates.getState().saveFrom(finalName, [group, ...members], s.edges);
    setNaming(false);
    setName("");
    toast(`已存为画布模板「${finalName}」：Ctrl+K 或双击画布即可插入`, "ok");
  };

  return (
    <div className={`group-node ${selected ? "sel" : ""}`}>
      <div className="gn-head">
        <IcGroup size={15} />
        <span>组 · {count} 个节点</span>
        {naming ? (
          <span className="gn-name nodrag">
            <input
              className="input"
              autoFocus
              placeholder="模板名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setNaming(false);
              }}
            />
            <button className="icon-btn" title="保存模板" onClick={save}>
              <IcCheck size={15} />
            </button>
          </span>
        ) : (
          <button
            className="icon-btn nodrag"
            title="把整组（节点配置 + 内部连线）存为画布模板，之后 Ctrl+K / 双击画布可反复插入"
            onClick={() => setNaming(true)}
          >
            <IcLayers size={15} />
          </button>
        )}
        <button
          className="icon-btn danger nodrag"
          title="解散组（成员保留在画布上）"
          onClick={() => removeNode(id)}
        >
          <IcTrash size={15} />
        </button>
      </div>
      <Handle type="source" position={Position.Right} id="out" data-lab="组出（成员按序聚合）" title="成员按位置顺序聚合输出（文本/图片/视频/音频按各自类型分流给下游）" className="port" />
    </div>
  );
});
