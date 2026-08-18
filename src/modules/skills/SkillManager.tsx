/**
 * Skill 管理器 — 导入 / 查看 / 启停 / 收藏 / 删除
 *  - 导入 SKILL.md（快速 Skill）或 .momoskill 包（需 JSZip，懒加载）
 *  - 列表显示名称、版本、来源、适用位置、启用状态
 *  - 查看完整指令、变量定义
 *  - 内置 Skill 不可删除（只能禁用），可恢复默认
 */
import { useEffect, useRef, useState } from "react";
import { Modal, Row } from "../../ui/kit";
import { useSkills } from "../../core/stores/skillStore";
import { useUi } from "../../core/stores/uiStore";
import { toast } from "../../core/stores/uiStore";
import { importSkillMd, importSkillPackage, importClaudeSkillZip } from "../../core/skillImport";
import { errMsg } from "../../core/utils";
import { IcWand, IcStar, IcTrash, IcUpload, IcCheck } from "../../ui/icons";
import type { MomoSkill, SkillContext } from "../../core/skillTypes";

const CONTEXT_LABEL: Record<SkillContext, string> = {
  "prompt.text": "文本提示词",
  "prompt.image": "图片提示词",
  "prompt.video": "视频提示词",
  "director.project": "导演台·项目",
  "director.segment": "导演台·片段",
  "poster.layout": "海报排版",
  "ecom.layout": "电商图",
  "agent.image": "助手·出图",
  "agent.video": "助手·出片",
};

const PHASE_LABEL: Record<string, string> = {
  analyze: "分析",
  authoring: "创作",
  "model-adapter": "模型适配",
  validate: "校验",
};

export function SkillManager() {
  const open = useUi((s) => s.skillMgrOpen);
  const close = () => useUi.getState().setSkillMgrOpen(false);
  const skills = useSkills((s) => s.skills);
  const loaded = useSkills((s) => s.loaded);
  const toggleEnabled = useSkills((s) => s.toggleEnabled);
  const toggleStarred = useSkills((s) => s.toggleStarred);
  const remove = useSkills((s) => s.remove);
  const install = useSkills((s) => s.install);
  const [viewing, setViewing] = useState<MomoSkill | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; description: string; instructions: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 打开管理器时确保 store 已加载（未加载就导入会把内置 Skill 与已存数据整体覆盖落盘）
  useEffect(() => {
    if (open && !loaded) void useSkills.getState().init();
  }, [open, loaded]);

  if (!open) return null;

  /** 打开详情（同时退出编辑态） */
  const openView = (s: MomoSkill | null) => {
    setViewing(s);
    setEditing(false);
    setDraft(null);
  };

  /** 导入文件：SKILL.md 直接解析；.momoskill 用 JSZip 解压后调 importSkillPackage */
  const onFiles = async (files: FileList) => {
    setWarnings([]);
    for (const f of Array.from(files)) {
      try {
        if (/\.md$/i.test(f.name)) {
          const text = await f.text();
          const r = importSkillMd(f.name, text);
          install(r.skill);
          if (r.warnings.length) setWarnings((w) => [...w, ...r.warnings]);
          toast(`已导入 Skill「${r.skill.name}」`, "ok");
        } else if (/\.momoskill$/i.test(f.name) || /\.zip$/i.test(f.name)) {
          // JSZip 懒加载解压成「路径 → 内容」映射；.momoskill 走完整包，普通 zip 按 Claude 风格找 SKILL.md
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(await f.arrayBuffer());
          const files = new Map<string, Uint8Array>();
          for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            files.set(path, await entry.async("uint8array"));
          }
          const r = /\.momoskill$/i.test(f.name) ? importSkillPackage(files) : importClaudeSkillZip(files);
          install(r.skill);
          if (r.warnings.length) setWarnings((w) => [...w, ...r.warnings]);
          toast(`已导入 Skill「${r.skill.name}」，请在详情里确认适用位置`, "ok");
          // 打开详情视图让用户确认/勾选适用位置（导入向导轻量版）
          openView(r.skill);
        } else {
          toast(`不支持的文件类型：${f.name}（支持 .md 和 .momoskill）`, "err");
        }
      } catch (e) {
        toast(`导入失败：${errMsg(e)}`, "err");
      }
    }
  };

  return (
    <Modal
      title={viewing ? `${editing ? "编辑" : "查看"} Skill · ${viewing.name}` : "Skill 管理"}
      onClose={() => (viewing ? openView(null) : close())}
      width={viewing ? 720 : 880}
    >
      <div
        className={`skill-drop${dragOver ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files);
        }}
      >
        {dragOver ? <div className="skill-drop-mask">松开以导入 Skill（.md / .zip / .momoskill）</div> : null}
      {warnings.length > 0 ? (
        <div className="sec-desc" style={{ marginBottom: 8, color: "var(--warn)" }}>
          {warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      ) : null}

      {viewing ? (
        /* ---- 查看 / 编辑详情 ---- */
        <div className="nodrag" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Row gap={8}>
            <span className="kind-ic" style={{ background: "var(--accent-soft, rgba(91,140,255,.15))" }}>
              <IcWand size={14} />
            </span>
            {editing && draft ? (
              <input
                className="input sm nodrag"
                style={{ minWidth: 220 }}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            ) : (
              <b style={{ fontSize: 15 }}>{viewing.name}</b>
            )}
            <span className="sec-desc">v{viewing.version}</span>
            <span className="sec-desc">· {PHASE_LABEL[viewing.phase] ?? viewing.phase}</span>
            <span className="sec-desc">· {viewing.source === "builtin" ? "内置" : "导入"}</span>
            <span className="spacer" style={{ flex: 1 }} />
            {editing && draft ? (
              <>
                <button
                  className="btn sm primary"
                  onClick={() => {
                    if (!draft.name.trim()) {
                      toast("名称不能为空", "err");
                      return;
                    }
                    const next = { ...viewing, name: draft.name.trim(), description: draft.description.trim(), instructions: draft.instructions };
                    install(next);
                    setViewing(next);
                    setEditing(false);
                    setDraft(null);
                    toast("已保存 Skill 修改", "ok");
                  }}
                >
                  保存
                </button>
                <button className="btn sm" onClick={() => { setEditing(false); setDraft(null); }}>
                  取消
                </button>
              </>
            ) : (
              <button
                className="btn sm"
                title="编辑名称、描述与指令正文"
                onClick={() => {
                  setDraft({ name: viewing.name, description: viewing.description, instructions: viewing.instructions });
                  setEditing(true);
                }}
              >
                编辑
              </button>
            )}
          </Row>
          {editing && draft ? (
            <input
              className="input sm nodrag"
              placeholder="一句话描述（这个 Skill 什么时候用）"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          ) : viewing.description ? (
            <div className="sec-desc">{viewing.description}</div>
          ) : null}
          <div>
            <div className="sec-desc" style={{ marginBottom: 4 }}>适用位置（点击切换，即改即存，决定 Skill 出现在哪些入口）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(Object.keys(CONTEXT_LABEL) as SkillContext[]).map((c) => {
                const on = viewing.contexts.includes(c);
                return (
                  <button
                    type="button"
                    key={c}
                    className={`skill-ctx${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      const contexts = on ? viewing.contexts.filter((x) => x !== c) : [...viewing.contexts, c];
                      if (!contexts.length) {
                        toast("至少保留一个适用位置", "err");
                        return;
                      }
                      const next = { ...viewing, contexts };
                      install(next);
                      setViewing(next);
                    }}
                  >
                    <span className="skill-ctx-box">{on ? <IcCheck size={10} /> : null}</span>
                    {CONTEXT_LABEL[c]}
                  </button>
                );
              })}
            </div>
          </div>
          {viewing.variables.length ? (
            <div>
              <div className="sec-desc" style={{ marginBottom: 4 }}>变量</div>
              {viewing.variables.map((v) => (
                <div key={v.key} style={{ fontSize: 12.5, marginBottom: 2 }}>
                  <b>{v.label}</b>（{v.key}）— {v.type}
                  {v.required ? " · 必填" : ""}
                  {v.hint ? <span className="sec-desc"> · {v.hint}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          <div>
            <div className="sec-desc" style={{ marginBottom: 4 }}>指令</div>
            {editing && draft ? (
              <textarea
                className="textarea nodrag nowheel"
                rows={14}
                style={{ fontSize: 12.5, lineHeight: 1.6 }}
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              />
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.6, background: "var(--panel)", padding: 12, borderRadius: "var(--r-md)", maxHeight: 360, overflow: "auto" }}>
                {viewing.instructions || "（空）"}
              </pre>
            )}
          </div>
        </div>
      ) : (
        /* ---- 列表视图 ---- */
        <div className="nodrag">
          <Row gap={8} style={{ marginBottom: 12 }}>
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              <IcUpload size={14} /> 导入 Skill
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.momoskill,.zip"
              multiple
              style={{ display: "none" }}
              onChange={(e) => e.target.files && onFiles(e.target.files)}
            />
            <span className="sec-desc">
              支持 SKILL.md（单文件）、Skill zip（Claude 风格）和 .momoskill（完整包）；可把文件直接拖进本窗口导入；当前版本不执行脚本
            </span>
          </Row>

          {!loaded ? (
            <div className="sec-desc" style={{ padding: "24px 0", textAlign: "center" }}>
              正在加载 Skill 列表…
            </div>
          ) : skills.length === 0 ? (
            <div className="sec-desc" style={{ padding: "24px 0", textAlign: "center" }}>
              还没有 Skill。导入一个 SKILL.md 或点击齿轮试试内置 Skill。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* 收藏置顶 */}
              {[...skills].sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || b.updatedAt - a.updatedAt).map((s) => (
                <div
                  key={s.id}
                  className="tpl-row"
                  style={{ opacity: s.enabled ? 1 : 0.55, cursor: "pointer" }}
                  onClick={() => openView(s)}
                >
                  <span className="tn" style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <button
                      className="icon-btn"
                      style={{ width: 24, height: 24 }}
                      title={s.starred ? "取消收藏" : "收藏置顶"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStarred(s.id);
                      }}
                    >
                      <IcStar size={14} style={s.starred ? { fill: "var(--accent)", color: "var(--accent)" } : {}} />
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <b style={{ fontSize: 13.5 }}>{s.name}</b>
                      <span className="sec-desc" style={{ marginLeft: 6 }}>v{s.version}</span>
                      <div className="sec-desc" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {s.description || s.instructions.slice(0, 60) + "…"}
                      </div>
                    </div>
                  </span>
                  <span className="acts" style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <span style={{ fontSize: 11, color: "var(--text-3)", alignSelf: "center", marginRight: 4 }}>
                      {s.contexts.slice(0, 2).map((c) => CONTEXT_LABEL[c] ?? c).join(" / ")}
                      {s.contexts.length > 2 ? "…" : ""}
                    </span>
                    <button
                      className={`btn sm${s.enabled ? "" : " ghost"}`}
                      title={s.enabled ? "点击禁用" : "点击启用"}
                      onClick={() => toggleEnabled(s.id)}
                    >
                      {s.enabled ? "已启用" : "已禁用"}
                    </button>
                    {s.source !== "builtin" ? (
                      <button
                        className="icon-btn danger"
                        title="删除"
                        onClick={() => {
                          if (confirm(`确定删除 Skill「${s.name}」吗？历史生成记录中的快照不受影响。`)) {
                            remove(s.id);
                            // 详情视图可能正显示此项（外层 viewing 已被 TS narrow，用 getState 安全读取）
                            setViewing((v) => (v && v.id === s.id) ? null : v);
                            toast(`已删除「${s.name}」`, "ok");
                          }
                        }}
                      >
                        <IcTrash size={15} />
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </Modal>
  );
}
