/** 批量生成共享开关：每段后清显存 / 尾帧接力（分镜页与生成页的批量条共用） */
import { useDirector } from "../../core/stores/directorStore";
import type { DirectorProject } from "../../core/types";

export function BatchSwitches({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  return (
    <>
      <label
        className="ds-opt"
        title="每段生成结束后调用 ComfyUI /free 卸载模型并释放显存；H3 等大工作流防显存堆积，代价是下一段重新加载模型"
      >
        <input
          type="checkbox"
          className="nodrag"
          checked={!!project.freeMemBetween}
          onChange={(e) => updateProject(project.id, { freeMemBetween: e.target.checked })}
        />
        <span className="ds-hint">每段后清显存</span>
      </label>
      <label
        className="ds-opt"
        title="批量生成连贯性：上一段生成完成后自动抽取其尾帧，作为下一段的首帧/首张参考图（本段显式首帧优先），与本段参考图一起投喂，保证跨段画面衔接；关闭则各段独立生成"
      >
        <input
          type="checkbox"
          className="nodrag"
          checked={!!project.tailFrameRelay}
          onChange={(e) => updateProject(project.id, { tailFrameRelay: e.target.checked })}
        />
        <span className="ds-hint">尾帧接力</span>
      </label>
    </>
  );
}
