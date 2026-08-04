/**
 * 生成面板提示词栏 — LibLib 式画布交互：
 * 提示词 / 参考图胶囊集中在底部生成栏上半行；下半行是模型/参数等 chips 工具栏 + 圆形发送按钮，节点上只留结果。
 * 生成图像的参考图胶囊可点击在光标处插入 @ 引用；生成视频的第 1/2 路胶囊标注首帧/尾帧。
 * 「历史」与「上游」打开时在主体卡右侧弹出贴底的小侧面板（内容少时收小，最高 340px 内部滚动）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { collectUpstream, collectUpstreamParts, runFlow } from "../../core/runner";
import { Thumb } from "../../ui/Thumb";
import { PromptAiTools } from "../../ui/PromptAiTools";
import { usePromptHist } from "../../core/stores/promptHistStore";
import { AtTextArea, useOwnUpstreamImageRefs, type AtTextAreaHandle } from "../../ui/AtTextArea";
import { IcClose, IcHistory, IcLoading, IcSend, IcTrash } from "../../ui/icons";

export function GenPromptBar({
  nodeId,
  kind,
  toolbar,
  trailing,
}: {
  nodeId: string;
  kind: "imageGen" | "videoGen" | "audioGen";
  /** 底部工具栏左侧 chips（模型选择 / 参数 / 语言 / 更多…） */
  toolbar?: ReactNode;
  /** 底部工具栏右侧、发送按钮之前的 chips（如数量） */
  trailing?: ReactNode;
}) {
  const node = useBoard((s) => s.nodes.find((n) => n.id === nodeId));
  const upd = useBoard((s) => s.updateData);
  const refs = useOwnUpstreamImageRefs(nodeId);
  const upTextN = useBoard(() => collectUpstream(nodeId).texts.length);
  const upImgN = useBoard(() => collectUpstream(nodeId).images.length);
  const [upOpen, setUpOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const editorRef = useRef<AtTextAreaHandle>(null);
  if (!node) return null;
  const d = node.data as Record<string, unknown>;
  const field = kind === "audioGen" ? "text" : "prompt";
  const value = (d[field] as string | undefined) ?? "";
  const running = d.status === "running";
  const set = (t: string) => upd(nodeId, { [field]: t }, { commit: true });
  const placeholder =
    kind === "imageGen"
      ? upTextN > 0
        ? "已接上游文本，留空自动使用；在此输入则优先生效…"
        : "描述你想生成的画面…"
      : kind === "videoGen"
        ? upTextN > 0
          ? "已接上游文本，留空自动使用；在此输入则优先生效…"
          : "描述你想生成的视频画面与运动…"
        : upTextN > 0
          ? "已接上游文本（分镜台词可直通），留空自动朗读…"
          : "输入要朗读的文本 / 音乐描述…";
  return (
    <>
      <div className="gd-main glass">
        <div className="gd-prompt">
          {refs.length ? (
            <div className="gd-refs">
              {refs.map((r, i) => (
                <button
                  key={`${r.label}_${i}`}
                  className={`gd-ref ${kind === "imageGen" ? "" : "static"}`}
                  title={
                    kind === "imageGen"
                      ? `点击在光标处插入 @${r.label}（发给模型时按「图${i + 1}」编号）`
                      : kind === "videoGen"
                        ? i === 0
                          ? "第 1 路上游图 = 首帧"
                          : i === 1
                            ? "第 2 路上游图 = 尾帧（家族支持时）"
                            : `第 ${i + 1} 路上游图`
                        : undefined
                  }
                  onClick={kind === "imageGen" ? () => editorRef.current?.insertToken(r.label) : undefined}
                >
                  <Thumb src={r.src} alt="" />
                  <b>{i + 1}</b>
                  {kind === "videoGen" && i < 2 ? <span className="gd-tag">{i === 0 ? "首帧" : "尾帧"}</span> : null}
                </button>
              ))}
              {kind === "imageGen" ? <span className="gd-hint">点击胶囊在提示词中 @ 引用</span> : null}
            </div>
          ) : null}
          <div className="gd-row">
            <AtTextArea
              ref={editorRef}
              rows={2}
              placeholder={placeholder}
              value={value}
              onChange={set}
              refs={kind === "imageGen" ? refs : []}
              style={{ flex: 1 }}
            />
            <div className="gd-side">
              {upTextN > 0 || upImgN > 0 ? (
                <button
                  className={`gd-up-toggle${upOpen ? " on" : ""}`}
                  title="查看上游传入的提示词与图片"
                  onClick={() => {
                    setUpOpen((v) => !v);
                    setHistOpen(false);
                  }}
                >
                  上游{upTextN > 0 ? ` ${upTextN}段` : ""}{upImgN > 0 ? ` ${upImgN}图` : ""}
                </button>
              ) : null}
              <PromptAiTools value={value} image={refs[0]?.src} onApply={set} up />
              {kind !== "audioGen" ? (
                <button
                  className={`btn sm ${histOpen ? "on" : ""}`}
                  title="提示词历史：生成成功的提示词自动收录，点选回填；⭐ 收藏置顶"
                  onClick={() => {
                    setHistOpen((v) => !v);
                    setUpOpen(false);
                  }}
                >
                  <IcHistory size={15} /> 历史
                </button>
              ) : null}
            </div>
          </div>
          <div className="gd-toolbar nodrag">
            {toolbar}
            <span className="gd-toolbar-sp" />
            {trailing}
            <button
              className="gd-send"
              disabled={!!running}
              title="生成（上游未运行的节点会按依赖顺序先自动运行）"
              onClick={() => void runFlow(nodeId)}
            >
              {running ? <IcLoading size={17} /> : <IcSend size={17} />}
            </button>
          </div>
        </div>
      </div>
      {upOpen ? <UpstreamPanel nodeId={nodeId} onClose={() => setUpOpen(false)} /> : null}
      {histOpen ? <HistPanel onPick={set} onClose={() => setHistOpen(false)} /> : null}
    </>
  );
}

/** 提示词历史侧面板：主体卡右侧贴底的小面板（≤340px，内部滚动） */
function HistPanel({ onPick, onClose }: { onPick: (t: string) => void; onClose: () => void }) {
  const items = usePromptHist((s) => s.items);
  const [kw, setKw] = useState("");
  useEffect(() => {
    void usePromptHist.getState().init();
  }, []);
  const list = items
    .filter((i) => !kw || i.text.toLowerCase().includes(kw.toLowerCase()))
    .sort((a, b) => Number(b.pin) - Number(a.pin) || b.ts - a.ts)
    .slice(0, 80);
  return (
    <div className="gd-side-panel glass nodrag nowheel">
      <div className="gd-up-head">
        <b>
          <IcHistory size={14} /> 提示词历史
        </b>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="gd-hist-search">
        <input className="input" placeholder="搜索提示词…" value={kw} autoFocus onChange={(e) => setKw(e.target.value)} />
        {items.some((i) => !i.pin) ? (
          <button className="btn sm" title="清空未收藏的历史" onClick={() => usePromptHist.getState().clear()}>
            <IcTrash size={13} />
          </button>
        ) : null}
      </div>
      <div className="gd-up-body">
        {list.length === 0 ? (
          <div className="pt-hist-empty">{items.length ? "没有匹配的提示词" : "暂无历史——生成成功后自动收录"}</div>
        ) : (
          list.map((i) => (
            <div key={i.id} className={`pt-hist-item ${i.pin ? "pin" : ""}`}>
              <span className="t" title={`${i.text}\n\n点击回填`} onClick={() => onPick(i.text)}>
                {i.text}
              </span>
              <button
                className={`star ${i.pin ? "on" : ""}`}
                title={i.pin ? "取消收藏" : "收藏置顶（不被清理）"}
                onClick={() => usePromptHist.getState().togglePin(i.id)}
              >
                ★
              </button>
              <button className="icon-btn danger" title="删除" onClick={() => usePromptHist.getState().remove(i.id)}>
                <IcTrash size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 上游传入详情面板（生成设置弹窗右侧弹出）：完整查看上游提示词 + 图片，与节点上的上游徽标弹窗同源；ComfyUI 面板复用 */
export function UpstreamPanel({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const parts = collectUpstreamParts(nodeId);
  const images = parts.filter((p) => p.kind === "image");
  const texts = parts.filter((p) => p.kind === "text");
  return (
    <div className="gd-side-panel glass nodrag nowheel">
      <div className="gd-up-head">
        <b>上游传入</b>
        <span className="gd-up-sum">{images.length} 张图 · {texts.length} 段文本</span>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="gd-up-body">
        {images.length ? (
          <>
            <div className="gd-up-sec">参考图 {images.length} 张（按传给模型的顺序，提示词可用 @ 引用）</div>
            {images.map((p, i) => (
              <div key={`img${i}`} className="gd-up-row">
                <Thumb src={p.value} alt="" />
                <b>图{i + 1}</b>
                <span className="gd-up-from" title={p.from}>{p.from}</span>
              </div>
            ))}
          </>
        ) : null}
        {texts.length ? (
          <>
            <div className="gd-up-sec">文本 {texts.length} 段（提示词留空时按此顺序换行合并）</div>
            {texts.map((p, i) => (
              <div key={`txt${i}`} className="gd-up-text">
                <div className="gd-up-text-head">
                  <b>段{i + 1}</b>
                  <span className="gd-up-from" title={p.from}>{p.from}</span>
                </div>
                <div className="gd-up-text-body">{p.value}</div>
              </div>
            ))}
            {texts.length > 1 ? (
              <>
                <div className="gd-up-sec">合并预览（实际发给模型的完整文本）</div>
                <div className="gd-up-text">
                  <div className="gd-up-text-body">{texts.map((t) => t.value).join("\n")}</div>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
