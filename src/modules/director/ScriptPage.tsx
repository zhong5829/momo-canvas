/**
 * 导演台·脚本页 — 故事导入、目标时长、结构分析、片段拆分
 *
 * 方案 §7.1：两步法（剧情分析 → 时长装箱），LLM 返回严格 JSON。
 * 方案 §20.2：支持外部剧本确定性切分（分段标记 + 自定义分层/分段标记）。
 * 剧本可直接拖入 .txt/.md 文件导入；输入框随窗口高度自适应。
 */
import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDirector } from "../../core/stores/directorStore";
import { useSkills } from "../../core/stores/skillStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { splitScript, structuredSplit, hasExternalSegments, projectProgress } from "../../core/directorEngine";
import { breakdownPrompt, type PromptBreakdown, newPromptRecipe, applyRecipeToPrompt } from "../../core/directorAnalysis";
import { errMsg } from "../../core/utils";
import { IcLoading, IcWand, IcSparkles, IcText } from "../../ui/icons";
import type { DirectorProject } from "../../core/types";

export function ScriptPage({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const [busy, setBusy] = useState(false);
  const [maxSegSec, setMaxSegSec] = useState(15);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [recipeText, setRecipeText] = useState("");
  const [recipeName, setRecipeName] = useState("");
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [breakdown, setBreakdown] = useState<PromptBreakdown | null>(null);
  // 订阅 skillStore 变化（useShallow 避免 byContext 返回新数组引用导致无限渲染）
  const directorSkills = useSkills(useShallow((s) => s.byContext("director.project")));
  // 配方库从 project 持久化读写（B4 修复：原 useState 切页签丢失）
  const savedRecipes = project.promptRecipes ?? [];

  const patch = (p: Partial<DirectorProject>) => updateProject(project.id, p);
  const progress = projectProgress(project);

  // 自定义分段/分场标记（方案 §20.2 扩展：行内含标记文本即在该行处切开）
  const si = project.scriptImport ?? { format: "text" as const, mode: "preserve-and-split" as const };
  const segDelim = si.delimiter?.trim() ?? "";
  const sceneDelim = si.sceneDelimiter?.trim() ?? "";
  const patchImport = (p: Partial<typeof si>) => patch({ scriptImport: { ...si, ...p } });

  /** 导入剧本文件（拖入或点选）：.txt/.md 纯文本 */
  const importFile = async (f: File) => {
    const ok = /\.(txt|md|markdown)$/i.test(f.name) || f.type.startsWith("text/");
    if (!ok) {
      toast("只支持 .txt / .md 文本文件", "err");
      return;
    }
    try {
      const text = await f.text();
      if (!text.trim()) {
        toast("文件内容为空", "err");
        return;
      }
      patch({ script: text });
      toast(`已导入「${f.name}」（${text.length} 字）`, "ok");
    } catch (e) {
      toast(`读取文件失败：${errMsg(e)}`, "err");
    }
  };

  const doSplit = async () => {
    if (!project.script.trim()) {
      toast("请先输入剧本或故事", "err");
      return;
    }
    setBusy(true);
    try {
      // 有外部分段标记时先确定性切分，再让 LLM 分析每段内部镜头
      const { characters, scenes } = await splitScript(project.script, project.targetDurationSec, maxSegSec);
      patch({ characters, scenes });
      toast(`已拆出 ${scenes.length} 场 · ${scenes.reduce((n, s) => n + s.segments.length, 0)} 个片段 · ${characters.length} 个角色`, "ok");
    } catch (e) {
      const msg = errMsg(e);
      toast(`剧本拆分失败：${msg}`, "err");
      useUi.getState().pushError?.("导演台 · 剧本拆分", msg);
    } finally {
      setBusy(false);
    }
  };

  const doDetect = () => {
    if (!sceneDelim && !segDelim && !hasExternalSegments(project.script)) {
      toast("没有检测到外部分段标记（分段1 / 第1段 / ### 标题 / --- 分隔等），可在下方设置自定义标记", "info");
      return;
    }
    const res = structuredSplit(project.script, maxSegSec, { delimiter: segDelim, sceneDelimiter: sceneDelim });
    const mkSegment = (text: string, id: string, sceneId: string, idx: number) => ({
      id,
      sceneId,
      durationSec: maxSegSec,
      summary: text.slice(0, 50).replace(/\n/g, " ").trim() || `分段 ${idx}`,
      dialogue: [],
      shots: [],
      scriptRange: [0, text.length] as [number, number],
      approvedTakeId: null,
      takes: [],
    });
    let scenes;
    if (sceneDelim) {
      // 分层模式：场 → 片段
      scenes = res.scenes.map((sc, i) => {
        const sid = `scene_${i + 1}`;
        return {
          id: sid,
          location: sc.title || sc.parts[0].slice(0, 20).replace(/\n/g, " ").trim() || `场景 ${i + 1}`,
          segments: sc.parts.map((text, j) => mkSegment(text, `seg_${i + 1}_${j + 1}`, sid, j + 1)),
        };
      });
    } else {
      // 单层模式：每段一个场景（与旧行为一致）
      const parts = res.scenes.flatMap((s) => s.parts);
      scenes = parts.map((text, i) => {
        const sid = `scene_${i + 1}`;
        return {
          id: sid,
          location: text.slice(0, 20).replace(/\n/g, " ").trim() || `分段 ${i + 1}`,
          segments: [mkSegment(text, `seg_${i + 1}`, sid, i + 1)],
        };
      });
    }
    if (!scenes.length) {
      toast("按当前标记没有切出任何片段", "info");
      return;
    }
    patch({ scenes });
    const segCount = scenes.reduce((n, s) => n + s.segments.length, 0);
    toast(
      sceneDelim
        ? `已按分层标记切出 ${scenes.length} 场 · ${segCount} 个片段`
        : `检测到 ${segCount} 个分段，已写入分镜表（可到分镜页编辑）`,
      "ok",
    );
  };

  return (
    <div className="ds-page ds-fill">
      {/* 概览统计（方案 §6.5） */}
      {progress.total > 0 ? (
        <div className="ds-stats">
          <div className="ds-stat">
            <b>{progress.total}</b>
            <span>已拆片段</span>
          </div>
          <div className="ds-stat ok">
            <b>{progress.approved}</b>
            <span>已采用</span>
          </div>
          <div className="ds-stat warn">
            <b>{progress.missing}</b>
            <span>缺片</span>
          </div>
          <div className="ds-stat accent">
            <b>{progress.durationSec}s</b>
            <span>总时长 / 目标 {project.targetDurationSec}s</span>
          </div>
        </div>
      ) : null}

      <div className="ds-cols">
        {/* 主列：剧本输入卡 */}
        <div className="ds-card ds-script-card">
          <div className="ds-card-head">
            <span className="ds-card-ic">
              <IcText size={16} />
            </span>
            <div>
              <div className="ds-card-title">剧本输入</div>
              <div className="ds-card-desc">
                粘贴故事或剧本、或直接拖入 .txt/.md 文件；带「分段1 / 第1段 / ### 标题 / ---」标记的剧本会按外部分段处理，也可用下方自定义标记
              </div>
            </div>
          </div>
          <div
            className={`ds-card-body ds-drop ${dragOver ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              // 移入子元素（textarea）也会触发 dragleave，只有真正离开卡片才取消高亮
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void importFile(f);
            }}
          >
            <textarea
              className="textarea nodrag nowheel ds-script"
              placeholder={"在此粘贴故事、剧本或大纲，或直接拖入 .txt / .md 文件…\n\n支持的外部分段标记：\n- 分段1 / 第1段 / 片段1 / Scene 1\n- markdown 二级/三级标题（## / ###）\n- 单独一行的 --- 分隔符\n- 下方自定义的分场 / 分段标记"}
              value={project.script}
              onChange={(e) => patch({ script: e.target.value })}
            />
            {dragOver ? <div className="ds-drop-mask">松开以导入剧本文件</div> : null}
          </div>
          {/* 自定义分层/分段标记（方案 §20.2 扩展） */}
          <div className="ds-split-opts">
            <label className="ds-opt">
              分场标记
              <input
                className="input sm nodrag"
                placeholder="例：【场景】"
                value={si.sceneDelimiter ?? ""}
                onChange={(e) => patchImport({ sceneDelimiter: e.target.value })}
              />
            </label>
            <label className="ds-opt">
              分段标记
              <input
                className="input sm nodrag"
                placeholder="例：【分段】"
                value={si.delimiter ?? ""}
                onChange={(e) => patchImport({ delimiter: e.target.value })}
              />
            </label>
            <span className="ds-opt-hint">行内含标记文本即在该行切开；都留空则自动识别内置标记</span>
          </div>
          <div className="ds-card-foot">
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = ""; // 允许重复选同一文件
              }}
            />
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              导入文件
            </button>
            <label className="ds-dur">
              单次最大片段时长
              <input
                className="input sm nodrag"
                type="number"
                min={4}
                max={60}
                value={maxSegSec}
                onChange={(e) => setMaxSegSec(Math.max(4, Number(e.target.value) || 15))}
              />
              秒
            </label>
            <span className="spacer" />
            <button className="btn sm" onClick={doDetect} disabled={busy || !project.script.trim()}>
              检测分段
            </button>
            <button className="btn sm primary" onClick={() => void doSplit()} disabled={busy || !project.script.trim()}>
              {busy ? <IcLoading size={14} /> : null}
              AI 拆分剧本
            </button>
          </div>
        </div>

        {/* 侧栏卡片组 */}
        <div className="ds-side">
          {/* 优秀范例拆解（方案 §23.3） */}
          <div className="ds-card">
            <div className="ds-card-head">
              <span className="ds-card-ic">
                <IcSparkles size={16} />
              </span>
              <div>
                <div className="ds-card-title">提示词范例拆解</div>
                <div className="ds-card-desc">把优秀提示词拆成结构化字段，存为配方复用到任意片段</div>
              </div>
            </div>
            <div className="ds-card-body">
              <textarea
                className="textarea nodrag nowheel"
                rows={2}
                placeholder="粘贴优秀提示词…"
                value={recipeText}
                onChange={(e) => setRecipeText(e.target.value)}
              />
              <div className="ds-recipe-bar">
                <input
                  className="input sm nodrag"
                  placeholder="配方名（如：电影感夜景）"
                  value={recipeName}
                  onChange={(e) => setRecipeName(e.target.value)}
                />
                <button
                  className="btn sm primary"
                  disabled={recipeBusy || !recipeText.trim()}
                  onClick={async () => {
                    setRecipeBusy(true);
                    try {
                      const bd = await breakdownPrompt(recipeText);
                      setBreakdown(bd);
                      toast("拆解完成，检查下方结果", "ok");
                    } catch (e) {
                      toast(`拆解失败：${errMsg(e)}`, "err");
                    } finally {
                      setRecipeBusy(false);
                    }
                  }}
                >
                  {recipeBusy ? <IcLoading size={13} /> : <IcSparkles size={13} />} AI 拆解
                </button>
                {breakdown ? (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const r = await newPromptRecipe(recipeName || "未命名配方", breakdown);
                      patch({ promptRecipes: [...savedRecipes, r] });
                      setRecipeText("");
                      setRecipeName("");
                      setBreakdown(null);
                      toast(`配方「${r.name}」已保存`, "ok");
                    }}
                  >
                    保存为配方
                  </button>
                ) : null}
              </div>
              {breakdown ? (
                <div className="ds-breakdown">
                  {(["subject", "scene", "action", "shotSize", "camera", "lighting", "style"] as const).map((k) => {
                    const LABEL: Record<string, string> = { subject: "主体", scene: "场景", action: "动作", shotSize: "景别", camera: "机位", lighting: "光线", style: "风格" };
                    const v = breakdown[k];
                    return v ? (
                      <div key={k} className="ds-bd-field">
                        <span className="ds-badge">{LABEL[k]}</span>
                        <span>{v}</span>
                      </div>
                    ) : null;
                  })}
                  {breakdown.negative.length ? (
                    <div className="ds-bd-field">
                      <span className="ds-badge warn">负向</span>
                      <span>{breakdown.negative.join("，")}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {savedRecipes.length ? (
                <div className="ds-saved-recipes">
                  <div className="ds-card-desc">已保存配方（点击追加到剧本末尾作为全局风格参考）</div>
                  {savedRecipes.map((r) => (
                    <button
                      key={r.id}
                      className="ds-recipe-card"
                      onClick={() => {
                        const newScript = applyRecipeToPrompt(project.script, r);
                        patch({ script: newScript });
                        toast(`已把配方「${r.name}」追加到剧本`, "ok");
                      }}
                    >
                      <b>{r.name}</b>
                      <span className="ds-card-desc">{r.breakdown.style || r.breakdown.subject || "（未拆解）"}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {/* 项目级 Skill 绑定（方案 §17.8） */}
          <div className="ds-card">
            <div className="ds-card-head">
              <span className="ds-card-ic">
                <IcWand size={16} />
              </span>
              <div>
                <div className="ds-card-title">项目级 Skill</div>
                <div className="ds-card-desc">勾选后作用于所有片段</div>
              </div>
            </div>
            <div className="ds-card-body">
              <div className="ds-skill-bind">
                {directorSkills.map((sk) => {
                  const bound = (project.skillBindings ?? []).find((b) => b.skillId === sk.id);
                  return (
                    <label key={sk.id} className="ds-skill-item">
                      <input
                        type="checkbox"
                        className="nodrag"
                        checked={!!bound?.enabled}
                        onChange={(e) => {
                          const existing = project.skillBindings ?? [];
                          const next = e.target.checked
                            ? [...existing.filter((b) => b.skillId !== sk.id), { skillId: sk.id, enabled: true, values: {} }]
                            : existing.map((b) => b.skillId === sk.id ? { ...b, enabled: false } : b);
                          patch({ skillBindings: next });
                        }}
                      />
                      <b>{sk.name}</b>
                      <span className="ds-card-desc">{sk.description}</span>
                    </label>
                  );
                })}
                {!directorSkills.length ? (
                  <div className="ds-empty">
                    <div className="ds-empty-desc">没有适用于「导演项目」上下文的 Skill，可在「设置 → Skill 管理」导入。</div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* 角色列表 */}
          {project.characters.length > 0 ? (
            <div className="ds-card">
              <div className="ds-card-head">
                <div>
                  <div className="ds-card-title">角色连续性</div>
                </div>
              </div>
              <div className="ds-card-body">
                <div className="ds-chars">
                  {project.characters.map((c) => (
                    <div key={c.id} className="ds-char">
                      <b>{c.name}</b>
                      <span className="ds-card-desc">{c.continuity || "（未描述连续性）"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
