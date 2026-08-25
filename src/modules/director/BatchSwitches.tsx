/** 批量生成共享开关：每段后清显存 / 空间接力（分镜页与生成页的批量条共用） */
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
        title="只对提示词标记为 continuity_relay／同场接力的片段，从故事顺序中紧邻的上一段提取稳定桥接帧；配方有空余参考视频槽时再截取末尾 2 秒。opening／开篇与 hard_cut／硬切换场会自动忽略并清除历史接力槽。关闭后已提取素材保留但不参与生成"
      >
        <input
          type="checkbox"
          className="nodrag"
          checked={!!project.tailFrameRelay}
          onChange={(e) => updateProject(project.id, { tailFrameRelay: e.target.checked })}
        />
        <span className="ds-hint">空间接力（帧＋2秒）</span>
      </label>
    </>
  );
}
