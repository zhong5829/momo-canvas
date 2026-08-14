/**
 * Skill Store — 安装 / 更新 / 启停 / 收藏 / 独立持久化
 * 落盘到 skills.json；Skill 本体存这里，节点/导演项目只保存 SkillBinding。
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import type { MomoSkill } from "../skillTypes";

type PersistShape = { skills: MomoSkill[]; schemaVersion: 1 };

type SkillState = {
  skills: MomoSkill[];
  loaded: boolean;
  init: () => Promise<void>;
  install: (skill: MomoSkill) => void; // 新增或更新（同 id 覆盖）
  remove: (id: string) => void;
  toggleEnabled: (id: string) => void;
  toggleStarred: (id: string) => void;
  getById: (id: string) => MomoSkill | undefined;
  /** 按上下文查询已启用的 Skill（供选择器使用） */
  byContext: (ctx: string) => MomoSkill[];
};

let initOnce: Promise<void> | null = null;

/** 内置 Skill（首版一个简单的提示词优化 Skill，验证整条链路） */
function builtinSkills(): MomoSkill[] {
  const now = Date.now();
  return [
    {
      id: "builtin-prompt-polish",
      name: "提示词精修",
      version: "1.0.0",
      description: "把粗糙的绘画意图优化为高质量中文提示词：补充主体细节、构图、光影、风格、质感、镜头信息",
      source: "builtin",
      contexts: ["prompt.image", "prompt.video", "agent.image", "agent.video"],
      phase: "authoring",
      output: "text",
      instructions: `你是一位顶级 AI 绘画提示词专家。用户会给你一段绘画意图或粗糙提示词，请把它优化为一段高质量的中文绘画提示词。

要求：
- 补充主体细节（外貌、服装、材质、姿势）
- 补充构图（景别、视角、画面布局）
- 补充光影（光源方向、明暗对比、氛围）
- 补充风格与质感（绘画/摄影/3D、色调）
- 补充镜头信息（焦段、景深、运动）
- 保持原意，不改变用户的核心意图
- 只输出优化后的提示词本身，不要任何解释或前后缀`,
      variables: [
        {
          key: "style",
          label: "风格倾向",
          type: "select",
          options: ["自动", "电影感", "动漫", "写实摄影", "油画", "水彩", "3D 渲染"],
          default: "自动",
          hint: "引导优化方向；「自动」由模型判断",
        },
      ],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export const useSkills = create<SkillState>((set, get) => ({
  skills: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>("skills.json", "v1");
      // 合并内置 Skill（用户可能禁用了内置项，保留用户的 enabled/starred 状态）
      const builtin = builtinSkills();
      const userSkills = saved?.skills ?? [];
      const merged: MomoSkill[] = [...builtin];
      for (const s of userSkills) {
        const bi = merged.findIndex((m) => m.id === s.id);
        if (bi >= 0) {
          // 同 id：用户版本覆盖内置（允许内置 Skill 被用户更新）
          merged[bi] = s;
        } else {
          merged.push(s);
        }
      }
      set({ skills: merged, loaded: true });
    })()),

  install: (skill) => {
    const s = get();
    const idx = s.skills.findIndex((x) => x.id === skill.id);
    const skills = idx >= 0 ? s.skills.map((x) => (x.id === skill.id ? { ...skill, updatedAt: Date.now() } : x)) : [...s.skills, skill];
    set({ skills });
    void saveJSON("skills.json", "v1", { skills, schemaVersion: 1 } satisfies PersistShape);
  },

  remove: (id) => {
    const s = get();
    // 内置 Skill 不允许删除（只能禁用）
    if (s.skills.find((x) => x.id === id)?.source === "builtin") return;
    const skills = s.skills.filter((x) => x.id !== id);
    set({ skills });
    void saveJSON("skills.json", "v1", { skills, schemaVersion: 1 } satisfies PersistShape);
  },

  toggleEnabled: (id) => {
    const s = get();
    const skills = s.skills.map((x) => (x.id === id ? { ...x, enabled: !x.enabled, updatedAt: Date.now() } : x));
    set({ skills });
    void saveJSON("skills.json", "v1", { skills, schemaVersion: 1 } satisfies PersistShape);
  },

  toggleStarred: (id) => {
    const s = get();
    const skills = s.skills.map((x) => (x.id === id ? { ...x, starred: !x.starred } : x));
    set({ skills });
    void saveJSON("skills.json", "v1", { skills, schemaVersion: 1 } satisfies PersistShape);
  },

  getById: (id) => get().skills.find((x) => x.id === id),

  byContext: (ctx) => get().skills.filter((s) => s.enabled && s.contexts.includes(ctx as any)),
}));

/** 便利方法：React 外用 getState() 取已启用的某上下文 Skill */
export function skillsForContext(ctx: string): MomoSkill[] {
  const s = useSkills.getState();
  if (!s.loaded) void s.init();
  return s.byContext(ctx);
}

/** 新建空 Skill（导入向导用） */
export function newSkill(partial: Partial<MomoSkill>): MomoSkill {
  const now = Date.now();
  return {
    id: uid(8),
    name: "未命名 Skill",
    version: "1.0.0",
    description: "",
    source: "import",
    contexts: ["prompt.text"],
    phase: "authoring",
    output: "text",
    instructions: "",
    variables: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}
