/**
 * 导演台项目 Store — 独立持久化到 director-projects.json
 *
 * 设计要点（方案 §8.2）：
 *  - 节点 data 只保存 projectId（DirectorData），完整项目数据存这里
 *  - 原因：画布 undo/redo 会复制 node.data，大项目会让快照膨胀；生成队列持续更新会频繁触发画布持久化
 *  - 使用 loadJSON/saveJSON + 序号守卫（与 boardStore 同款），防止慢的旧快照覆盖新快照
 *  - 删除导演台节点时默认把项目移入「归档」，不直接删除素材
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import type { DirectorProject } from "../types";

type PersistShape = { projects: DirectorProject[]; archived: DirectorProject[]; schemaVersion: 1 };

type DirectorState = {
  projects: DirectorProject[];
  /** 归档项目（节点删除后移入这里，不删素材） */
  archived: DirectorProject[];
  loaded: boolean;
  init: () => Promise<void>;
  /** 新建项目（新建导演台节点时调用） */
  createProject: (nodeId: string, boardId: string, name?: string) => DirectorProject;
  /** 更新项目字段 */
  updateProject: (id: string, patch: Partial<DirectorProject>) => void;
  /** 删除项目 → 移入归档（不删素材） */
  archiveProject: (id: string) => void;
  /** 彻底删除归档项目 */
  purgeArchived: (id: string) => void;
  getById: (id: string) => DirectorProject | undefined;
  getByNodeId: (nodeId: string) => DirectorProject | undefined;
};

let saveSeq = 0;
let initOnce: Promise<void> | null = null;

function persist(state: { projects: DirectorProject[]; archived: DirectorProject[] }) {
  const mySeq = ++saveSeq;
  const data = {
    projects: state.projects,
    archived: state.archived,
    schemaVersion: 1,
  } satisfies PersistShape;
  // 序号守卫（与 boardStore 同款）：saveJSON 是异步的，高频调用时慢的旧快照不能覆盖新快照。
  // 用 setTimeout(0) 让出微任务，等同步代码里可能触发的后续 persist 都 ++saveSeq 后再检查。
  setTimeout(() => {
    if (mySeq !== saveSeq) return; // 已有更新的保存发起，丢弃这一份
    void saveJSON("director-projects.json", "v1", data);
  }, 0);
}

export const useDirector = create<DirectorState>((set, get) => ({
  projects: [],
  archived: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>("director-projects.json", "v1");
      // 脏数据兜底：早期版本或损坏的存档可能缺数组字段，缺了会让各页 flatMap/map 直接抛错白屏
      const fix = (p: DirectorProject): DirectorProject => ({
        ...p,
        script: p.script ?? "",
        characters: p.characters ?? [],
        scenes: p.scenes ?? [],
        recipes: p.recipes ?? [],
        globalSlots: p.globalSlots ?? [],
        timeline: p.timeline ?? [],
      });
      set({
        projects: (saved?.projects ?? []).map(fix),
        archived: (saved?.archived ?? []).map(fix),
        loaded: true,
      });
    })()),

  createProject: (nodeId, boardId, name) => {
    const now = Date.now();
    const project: DirectorProject = {
      id: uid(10),
      nodeId,
      boardId,
      name: name || "未命名项目",
      createdAt: now,
      updatedAt: now,
      targetDurationSec: 120,
      aspect: "16:9",
      script: "",
      characters: [],
      scenes: [],
      recipes: [],
      globalSlots: [],
      timeline: [],
      schemaVersion: 1,
    };
    const projects = [project, ...get().projects];
    set({ projects });
    persist(get());
    return project;
  },

  updateProject: (id, patch) => {
    const s = get();
    const projects = s.projects.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p));
    set({ projects });
    persist(get());
  },

  archiveProject: (id) => {
    const s = get();
    const proj = s.projects.find((p) => p.id === id);
    if (!proj) return;
    const projects = s.projects.filter((p) => p.id !== id);
    const archived = [proj, ...s.archived];
    set({ projects, archived });
    persist(get());
  },

  purgeArchived: (id) => {
    const s = get();
    const archived = s.archived.filter((p) => p.id !== id);
    set({ archived });
    persist(get());
  },

  getById: (id) => get().projects.find((p) => p.id === id),

  getByNodeId: (nodeId) => get().projects.find((p) => p.nodeId === nodeId),
}));
