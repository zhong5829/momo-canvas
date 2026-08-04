/**
 * 运行控制 — 节点任务的停止通道 + 全局并发闸门
 *
 * 以前取消能力做了一半就断了：VideoGenReq.signal / StreamCallbacks.signal 都定义好了，
 * 但 runner 从来不传，UI 上也没有停止按钮——视频点错参数只能干等 2-6 分钟照样扣费。
 * 这里补齐两件事：
 *  ① 每个运行中的节点注册一个 AbortController，节点上/标题栏可随时停止；
 *  ② 简单信号量限流：runAllFlows 连通分量数 × 节点内并行不再无上限地打中转站（429 雪崩）。
 */
import { create } from "zustand";

export type RunTask = { kind: string; startedAt: number };

type RunTasksState = {
  /** 运行/排队中的节点任务（UI 响应式展示停止按钮/全部停止） */
  tasks: Record<string, RunTask>;
};

export const useRunTasks = create<RunTasksState>(() => ({ tasks: {} }));

const ctrls = new Map<string, AbortController>();

/** 注册一个节点任务，返回它的中止信号 */
export function beginTask(id: string, kind: string): AbortSignal {
  // 同一节点重复注册（理论上 runner 有短路，防御一下）：先掐掉旧的
  ctrls.get(id)?.abort();
  const ctrl = new AbortController();
  ctrls.set(id, ctrl);
  useRunTasks.setState((s) => ({ tasks: { ...s.tasks, [id]: { kind, startedAt: Date.now() } } }));
  return ctrl.signal;
}

export function endTask(id: string) {
  ctrls.delete(id);
  useRunTasks.setState((s) => {
    const t = { ...s.tasks };
    delete t[id];
    return { tasks: t };
  });
}

/** 节点当前的中止信号（runner 往服务层传） */
export function taskSignal(id: string): AbortSignal | undefined {
  return ctrls.get(id)?.signal;
}

/** 停止一个节点任务；不在运行中返回 false */
export function abortNode(id: string): boolean {
  const c = ctrls.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

/** 停止全部运行中的任务，返回停掉的个数 */
export function abortAll(): number {
  let n = 0;
  for (const c of ctrls.values()) {
    c.abort();
    n++;
  }
  return n;
}

/** 是不是「用户主动停止」类错误（这类不该弹红报错、不该进报错中心） */
export function isAbortError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /已取消|已手动停止|abort|cancell?ed/i.test(m);
}

/* ---------------- 全局并发闸门（简单信号量） ---------------- */

let maxConcurrent = 3;
let active = 0;
const waiters: Array<{ wake: () => void; drop: (e: Error) => void; signal?: AbortSignal }> = [];

export function setMaxConcurrent(n: number) {
  maxConcurrent = Math.max(1, Math.min(10, Math.round(n) || 3));
  // 上限调大时唤醒排队者
  while (active < maxConcurrent && waiters.length) {
    active++;
    waiters.shift()!.wake();
  }
}

function releaseSlot() {
  active = Math.max(0, active - 1);
  while (active < maxConcurrent && waiters.length) {
    const w = waiters.shift()!;
    if (w.signal?.aborted) {
      w.drop(new Error("已取消"));
      continue;
    }
    active++;
    w.wake();
  }
}

/** 占一个并发额度；满了就排队（可被 signal 取消）。返回释放函数（必须在 finally 里调） */
export function acquireSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new Error("已取消"));
  if (active < maxConcurrent) {
    active++;
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      releaseSlot();
    });
  }
  return new Promise<() => void>((resolve, reject) => {
    const entry = {
      wake: () => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          releaseSlot();
        });
      },
      drop: reject,
      signal,
    };
    waiters.push(entry);
    signal?.addEventListener("abort", () => {
      const i = waiters.indexOf(entry);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error("已取消"));
      }
    });
  });
}
