/**
 * 画布右上角系统资源仪表盘：CPU / 内存 / GPU / 显存。
 * 默认收起为一个低透明度小圆钮（不轮询、零开销）；点击展开环形仪表，2s 轮询，
 * 点击画布其他位置自动收回。沉浸模式（zen）由父级控制不渲染；浏览器预览不挂载。
 */
import { useEffect, useRef, useState } from "react";
import { getSystemStats, type SystemStats } from "../../core/services/sysmon";
import { isTauri } from "../../core/utils";
import { IcActivity } from "../../ui/icons";

/** r=10 的圆周长（环形仪表用） */
const CIRC = 2 * Math.PI * 10;

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);

function Gauge({ pct, label, title }: { pct: number | null; label: string; title: string }) {
  const hot = pct !== null && pct >= 90;
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className={`sm-g ${hot ? "hot" : ""}`} title={title}>
      <svg className="sm-ring" viewBox="0 0 26 26">
        <circle className="sm-track" cx="13" cy="13" r="10" />
        {pct !== null ? (
          <circle
            className="sm-val"
            cx="13"
            cy="13"
            r="10"
            strokeDasharray={`${(clamped / 100) * CIRC} ${CIRC}`}
            transform="rotate(-90 13 13)"
          />
        ) : null}
        <text className="sm-num" x="13" y="16.5" textAnchor="middle">
          {pct === null ? "--" : String(Math.round(clamped))}
        </text>
      </svg>
      <span className="sm-label">{label}</span>
    </div>
  );
}

export function SysMonitor({ shift }: { shift: number }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 只在展开时轮询，收起零开销
  useEffect(() => {
    if (!isTauri || !open) return;
    let dead = false;
    const tick = async () => {
      const s = await getSystemStats();
      if (!dead && s) setStats(s);
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [open]);

  // 点击组件外任意处自动收回
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!isTauri) return null;

  const memPct = stats && stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null;
  const gpuPct = stats?.gpuUtil ?? null;
  const vramPct = stats && stats.vramUsed != null && stats.vramTotal ? (stats.vramUsed / stats.vramTotal) * 100 : null;

  const cpuTitle = stats ? `CPU 占用 ${stats.cpu.toFixed(1)}%` : "系统信息读取中…";
  const memTitle = stats ? `内存 ${gb(stats.memUsed)} / ${gb(stats.memTotal)} GB` : "系统信息读取中…";
  const gpuTitle = !stats
    ? "系统信息读取中…"
    : stats.gpuName == null
      ? "未检测到 NVIDIA 显卡"
      : gpuPct == null
        ? `${stats.gpuName} · 核心占用不可用`
        : `${stats.gpuName} · 核心占用 ${gpuPct.toFixed(0)}%`;
  const vramTitle = !stats
    ? "系统信息读取中…"
    : stats.vramUsed == null || !stats.vramTotal
      ? stats.gpuName
        ? `${stats.gpuName} · 显存信息不可用`
        : "未检测到 NVIDIA 显卡"
      : `${stats.gpuName ?? "NVIDIA GPU"} · 显存 ${gb(stats.vramUsed)} / ${gb(stats.vramTotal)} GB`;

  return (
    <div className="sysmon-wrap" style={{ right: 16 + shift }} ref={ref}>
      {open ? (
        <div className="sysmon glass">
          <Gauge pct={stats ? stats.cpu : null} label="CPU" title={cpuTitle} />
          <Gauge pct={memPct} label="内存" title={memTitle} />
          <Gauge pct={gpuPct} label="GPU" title={gpuTitle} />
          <Gauge pct={vramPct} label="显存" title={vramTitle} />
        </div>
      ) : null}
      <button
        className={`sysmon-toggle glass ${open ? "on" : ""}`}
        title={open ? "收起系统资源监控" : "系统资源监控：CPU / 内存 / GPU / 显存"}
        onClick={() => setOpen(!open)}
      >
        <IcActivity size={15} />
      </button>
    </div>
  );
}
