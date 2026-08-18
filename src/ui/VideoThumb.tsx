/**
 * 视频缩略图 — 节点/画廊内不挂 <video>（每个 <video> 都占用解码器与内存，
 * 多了整个画布掉帧），只显示抓取的封面帧 + 播放角标 + 时长，点击才进灯箱真正播放。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useUi } from "../core/stores/uiStore";

type Poster = { poster: string | null; dur: number; dims?: { w: number; h: number } };

const CACHE_MAX = 200;
const cache = new Map<string, Poster>();
const pending = new Map<string, Promise<Poster>>();

function remember(src: string, p: Poster) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(src, p);
}

/** 抓视频封面帧（≤480px webp）+ 时长；跨域被污染时 poster 为 null（仍显示占位块，不挂 video） */
export function makeVideoPoster(src: string): Promise<Poster> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(src);
  if (inflight) return inflight;
  const p = new Promise<Poster>((res) => {
    const v = document.createElement("video");
    const timer = setTimeout(() => res({ poster: null, dur: 0 }), 10000);
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => {
      v.currentTime = Math.min(0.3, (v.duration || 1) / 3);
    };
    v.onseeked = () => {
      clearTimeout(timer);
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const dims = v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : undefined;
      try {
        const scale = Math.min(1, 480 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round((v.videoWidth || 640) * scale));
        c.height = Math.max(1, Math.round((v.videoHeight || 360) * scale));
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        res({ poster: c.toDataURL("image/webp", 0.8), dur, dims });
      } catch {
        res({ poster: null, dur, dims });
      }
      v.src = "";
    };
    v.onerror = () => {
      clearTimeout(timer);
      res({ poster: null, dur: 0 });
    };
    v.src = src;
  })
    .then((r: Poster) => {
      remember(src, r);
      return r;
    })
    .finally(() => pending.delete(src));
  pending.set(src, p);
  return p;
}

export function fmtDur(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

/** 视频像素尺寸（封面抓取时已顺带记录）；未就绪为 null */
export function videoDimsSync(src: string): { w: number; h: number } | null {
  return cache.get(src)?.dims ?? null;
}

/** hook 版：组件里拿某视频的像素尺寸（封面就绪后可用） */
export function useVideoDims(src?: string): { w: number; h: number } | null {
  const [d, setD] = useState(() => (src ? videoDimsSync(src) : null));
  useEffect(() => {
    if (!src) {
      setD(null);
      return;
    }
    let on = true;
    setD(videoDimsSync(src));
    void makeVideoPoster(src).then((p) => {
      if (on && p.dims) setD(p.dims);
    });
    return () => {
      on = false;
    };
  }, [src]);
  return d;
}

/** 节点内视频：封面帧渲染，点击进灯箱播放（不传 onClick 时的默认行为） */
export function VideoThumb({
  src,
  className,
  style,
  title,
  onClick,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
}) {
  const [p, setP] = useState<Poster | null>(() => cache.get(src) ?? null);
  useEffect(() => {
    let on = true;
    setP(cache.get(src) ?? null);
    void makeVideoPoster(src).then((r) => {
      if (on) setP(r);
    });
    return () => {
      on = false;
    };
  }, [src]);
  const open = onClick ?? (() => useUi.getState().setLightbox(src, null, "video"));
  return (
    <div
      className={`vthumb ${className ?? ""}`}
      style={style}
      title={title ?? "点击放大播放"}
      onClick={open}
    >
      {p?.poster ? (
        <img src={p.poster} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="vthumb-ph">{p ? "视频（无法预览封面）" : "封面加载中…"}</div>
      )}
      <span className="vt-play">▶</span>
      {p?.dur ? <span className="vt-dur">{fmtDur(p.dur)}</span> : null}
    </div>
  );
}

/**
 * 悬停滑动预览缩略图：鼠标在卡上左右滑动时，画面跳到对应时间点的帧（时间轴擦洗式预览）。
 * 平时与 VideoThumb 一样只显示封面帧；悬停期间才挂一个 muted <video>，移开即卸载，避免多视频解码拖垮页面。
 * 点击进灯箱播放（不传 onClick 时的默认行为）。
 */
export function ScrubVideoThumb({
  src,
  className,
  style,
  title,
  onClick,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
}) {
  const [p, setP] = useState<Poster | null>(() => cache.get(src) ?? null);
  const [hover, setHover] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let on = true;
    setP(cache.get(src) ?? null);
    void makeVideoPoster(src).then((r) => {
      if (on) setP(r);
    });
    return () => {
      on = false;
    };
  }, [src]);
  // 鼠标横移 → seek 到对应比例的时间点（duration 未就绪时跳过）
  useEffect(() => {
    const v = vidRef.current;
    if (!v || pct == null || !Number.isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = Math.min(Math.max(0.05, pct * v.duration), Math.max(0.05, v.duration - 0.05));
  }, [pct]);
  const open = onClick ?? (() => useUi.getState().setLightbox(src, null, "video"));
  return (
    <div
      className={`vthumb scrub ${className ?? ""}`}
      style={style}
      title={title ?? "点击放大播放；悬停后左右滑动可擦洗预览画面"}
      onClick={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPct(null);
      }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (!r.width) return;
        setPct(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      }}
    >
      {hover ? (
        <video ref={vidRef} src={src} muted playsInline preload="auto" />
      ) : p?.poster ? (
        <img src={p.poster} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="vthumb-ph">{p ? "视频（无法预览封面）" : "封面加载中…"}</div>
      )}
      <span className="vt-play">▶</span>
      {hover && pct != null ? (
        <span className="vt-scrub">
          <i style={{ width: `${Math.round(pct * 100)}%` }} />
        </span>
      ) : null}
      {!hover && p?.dur ? <span className="vt-dur">{fmtDur(p.dur)}</span> : null}
    </div>
  );
}
