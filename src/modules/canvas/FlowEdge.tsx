/**
 * 画布连线（自定义边）— LibLib 式三件事：
 * 1. 贴框：端点沿端口方向向节点内侧多伸 10px（被卡片盖住一截），连线必然「碰到」节点外框，不再留缝；
 * 2. 剪刀：悬停连线中点片刻，浮出圆形剪刀钮，点击剪断这条连线（可 Ctrl+Z 撤销）；
 * 3. 脉冲：节点被选中时，与它相连的连线出现流光脉冲，方向 = 上游 → 下游。
 */
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import { useBoard } from "../../core/stores/boardStore";
import { IcScissors } from "../../ui/icons";

/** 端点向节点内侧多伸的距离（px），盖住缝隙 */
const REACH = 10;

/** 把端点沿「节点内侧」方向推进：口在左侧则内侧为 +x，右侧为 -x，上侧 +y，下侧 -y */
const into = (x: number, y: number, pos: Position): [number, number] => {
  switch (pos) {
    case Position.Left:
      return [x + REACH, y];
    case Position.Right:
      return [x - REACH, y];
    case Position.Top:
      return [x, y + REACH];
    case Position.Bottom:
      return [x, y - REACH];
  }
};

export const FlowEdge = memo(function FlowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  // 脉冲开关：任一相连节点被选中即亮（布尔选择器，不变不触发重渲染）
  const pulsing = useBoard((s) => s.nodes.some((n) => n.selected && (n.id === source || n.id === target)));

  const [sx, sy] = into(sourceX, sourceY, sourcePosition);
  const [tx, ty] = into(targetX, targetY, targetPosition);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition,
    targetX: tx,
    targetY: ty,
    targetPosition,
  });

  const cut = () => {
    useBoard.getState().onEdgesChange([{ type: "remove", id }]);
  };

  return (
    <>
      <BaseEdge id={id} path={path} />
      {pulsing ? <path d={path} className="medge-flow" /> : null}
      <EdgeLabelRenderer>
        <div
          className="edge-cut nodrag nowheel"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button className="edge-cut-btn" title="剪断连线" onClick={cut}>
            <IcScissors size={13} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
