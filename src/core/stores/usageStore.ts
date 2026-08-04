/**
 * 用量统计 — 按 `YYYY-MM-DD | providerId | model` 聚合每次外部生成的调用/张数/时长/Token/预估花费。
 * 记账点在 runner 各 runXxx 与 llm 的 usage 回填；落 usage.json。
 * 看板（设置 → 用量）按天/模型/服务商读 rangeUsage 聚合展示。
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { estimateCost } from "../pricing";
import type { ModelCard } from "../types";

export type UsageRow = {
  calls: number;
  fails: number;
  images: number;
  videoSec: number;
  audioSec: number;
  inTok: number;
  outTok: number;
  estCost: number;
  /** 最近若干次耗时样本（毫秒），用于算中位数 */
  durs: number[];
};

export type UsageRecordOpts = {
  ok: boolean;
  images?: number;
  videoSec?: number;
  audioSec?: number;
  inTok?: number;
  outTok?: number;
  durMs?: number;
};

type UsageState = {
  rows: Record<string, UsageRow>;
  loaded: boolean;
  init: () => Promise<void>;
  record: (card: ModelCard, opts: UsageRecordOpts) => void;
  /** 当日累计花费（CNY），预算闸门用 */
  todayCost: () => number;
  /** 近 N 天的聚合（看板用） */
  rangeUsage: (days: number) => { rows: { day: string; cost: number; calls: number; fails: number }[]; total: number };
};

const HISTORY_DAYS = 90;

function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(rows: Record<string, UsageRow>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveJSON("usage.json", "v1", rows), 1500);
}

let initOnce: Promise<void> | null = null;

export const useUsage = create<UsageState>((set, get) => ({
  rows: {},
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<Record<string, UsageRow>>("usage.json", "v1");
      if (saved) {
        // 滚动清理：丢弃 90 天前的键，避免长期增长拖慢加载
        const cutoff = dayKey(new Date(Date.now() - HISTORY_DAYS * 86400_000));
        const rows: Record<string, UsageRow> = {};
        for (const [k, v] of Object.entries(saved)) if (k.slice(0, 10) >= cutoff) rows[k] = v;
        set({ rows, loaded: true });
      } else {
        set({ loaded: true });
      }
    })()),

  record: (card, opts) => {
    if (!useUsage.getState().loaded) return;
    const key = `${dayKey()}|${card.id}|${card.model}`;
    const rows = { ...get().rows };
    const cur: UsageRow = rows[key] ?? {
      calls: 0, fails: 0, images: 0, videoSec: 0, audioSec: 0, inTok: 0, outTok: 0, estCost: 0, durs: [],
    };
    cur.calls += 1;
    if (!opts.ok) cur.fails += 1;
    cur.images += opts.images ?? 0;
    cur.videoSec += opts.videoSec ?? 0;
    cur.audioSec += opts.audioSec ?? 0;
    cur.inTok += opts.inTok ?? 0;
    cur.outTok += opts.outTok ?? 0;
    // 失败的调用也记账但不计花费（多数失败不计费；个别计费的差额可接受，看板会单列 fails）
    if (opts.ok) cur.estCost += estimateCost(card.model, opts);
    if (opts.durMs) {
      cur.durs.push(opts.durMs);
      if (cur.durs.length > 30) cur.durs.shift();
    }
    rows[key] = cur;
    set({ rows });
    scheduleSave(rows);
  },

  todayCost: () => {
    const today = dayKey();
    let sum = 0;
    for (const [k, v] of Object.entries(get().rows)) if (k.startsWith(today)) sum += v.estCost;
    return Math.round(sum * 10000) / 10000;
  },

  rangeUsage: (days) => {
    const byDay: Record<string, { cost: number; calls: number; fails: number }> = {};
    const cutoff = dayKey(new Date(Date.now() - days * 86400_000));
    let total = 0;
    for (const [k, v] of Object.entries(get().rows)) {
      const day = k.slice(0, 10);
      if (day < cutoff) continue;
      const d = (byDay[day] ??= { cost: 0, calls: 0, fails: 0 });
      d.cost += v.estCost;
      d.calls += v.calls;
      d.fails += v.fails;
      total += v.estCost;
    }
    const rows = Object.entries(byDay)
      .map(([day, v]) => ({ day, cost: Math.round(v.cost * 10000) / 10000, calls: v.calls, fails: v.fails }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    return { rows, total: Math.round(total * 10000) / 10000 };
  },
}));
