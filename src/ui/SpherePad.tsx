/**
 * 球面方位编辑器（LibLib 式大球） — 打光（光源）与多角度（机位）节点共用
 *  中央大圆内嵌上游参考图（= 主体所在的「星球」），太阳/相机图标在球面轨道上环绕；
 *  轨迹球交互：按住任意处拖动即可 360° 环绕，垂直拖动调俯仰；绕到背面时图标缩小变淡。
 *  light 模式额外做「打光实时预演」：光色从光源方向晕染到画面上、亮度压暗/提亮、逆光或轮廓光时亮边。
 *  camera 模式额外做「取景预演」：景别驱动画面推拉（特写放大 / 远景缩小）+ 视线锥。
 */
import { useId, useRef } from "react";
import { useThumb } from "./Thumb";

const R = 96; // 球面轨道半径
const CORE = 58; // 内嵌画面圆半径
const RAD = Math.PI / 180;

/** 景别 → 画面推拉比例（特写拉近 / 远景推远） */
const SHOT_SCALE = [1.34, 1.16, 1, 0.86, 0.74];

export function SpherePad({
  az,
  el,
  image,
  mode,
  lightColor,
  brightness = 50,
  rim,
  shot,
  dimmed,
  onChange,
}: {
  /** 水平方位角：0 正前方，负左正右，±180 背后 */
  az: number;
  /** 垂直仰角：正上负下 */
  el: number;
  /** 中央展示的参考图（上游图片） */
  image?: string;
  /** light = 光源（太阳）；camera = 机位（相机） */
  mode: "light" | "camera";
  /** light：光色（空 = 自然白光） */
  lightColor?: string;
  /** light：亮度 0-100（50 正常），驱动预演的压暗/提亮 */
  brightness?: number;
  /** light：轮廓光开关（逆光时自动有亮边） */
  rim?: boolean;
  /** camera：景别 0-4（特写→远景），驱动画面推拉 */
  shot?: number;
  /** 智能模式：参数不生效，标记弱化显示 */
  dimmed?: boolean;
  onChange: (az: number, el: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ az: number; el: number; x: number; y: number; sign: 1 | -1 } | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const thumb = useThumb(image);

  const cosE = Math.cos(el * RAD);
  const x = Math.sin(az * RAD) * cosE * R;
  const y = -Math.sin(el * RAD) * R;
  /** 深度（朝向观察者为正）：决定前/背面表现 */
  const depth = Math.cos(az * RAD) * cosE;
  const front = depth >= 0;
  const len = Math.hypot(x, y) || 1;
  /**  tether：从图标到画面圆边缘 */
  const tx = (x / len) * (CORE + 5);
  const ty = (y / len) * (CORE + 5);

  const glowColor = lightColor || "#FFE9C4";
  const glowA = 0.12 + (brightness / 100) * 0.4;
  const veil = brightness < 50 ? { c: "#06080F", a: ((50 - brightness) / 50) * 0.42 } : { c: "#FFFFFF", a: ((brightness - 50) / 50) * 0.22 };
  const showRim = mode === "light" && (rim || !front);
  const zoom = mode === "camera" ? (SHOT_SCALE[shot ?? 2] ?? 1) : 1;

  /* 交互（点击落点 + 快速环绕）：
     按下：指针位置直接映射到球面（前半球反投影），标记即刻落到指到的地方——粗调一步到位、精准跟手；
     拖动：以落点为基准做增量环绕，横向满幅 540°（约三分之一幅即绕到背面），纵向调俯仰。
     方向锁定在按下时的半球，松手重按即按新半球生效；双击复位正面。 */
  const toVb = (e: React.PointerEvent<SVGSVGElement>) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * 240 - 120, y: ((e.clientY - b.top) / b.height) * 240 - 120 };
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toVb(e);
    // 球面反投影：俯仰由高度决定，方位由横向占比决定（球外点击按方向钳到赤道圈上）
    const len = Math.hypot(p.x, p.y) || 1;
    const k = Math.min(1, len / R);
    const px = (p.x / len) * k * R;
    const py = (p.y / len) * k * R;
    const el = Math.max(-85, Math.min(85, -Math.asin(Math.max(-1, Math.min(1, py / R))) / RAD));
    const cosE = Math.cos(el * RAD) || 1e-6;
    const az = Math.asin(Math.max(-1, Math.min(1, px / R / cosE))) / RAD;
    drag.current = { az, el, x: e.clientX, y: e.clientY, sign: 1 };
    onChange(Math.round(az), Math.round(el));
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const b = ref.current?.getBoundingClientRect();
    if (!d || !b?.width) return;
    let naz = d.az + d.sign * ((e.clientX - d.x) / b.width) * 540;
    naz = ((naz + 540) % 360) - 180;
    const nel = Math.max(-85, Math.min(85, d.el - ((e.clientY - d.y) / b.height) * 300));
    onChange(Math.round(naz), Math.round(nel));
  };
  const onUp = () => {
    drag.current = null;
  };

  const mark = (
    <g transform={`translate(${x},${y}) scale(${front ? 1 : 0.68})`} className={`sp-mark ${mode} ${front ? "" : "back"}`}>
      <title>
        {`${mode === "light" ? "光源" : "机位"} · 水平 ${az}° / 垂直 ${el}°${front ? "" : "（背面）"} —— 按住拖动可 360° 环绕`}
      </title>
      {mode === "light" ? (
        <>
          {front ? <circle r={17} fill={`url(#spHalo${uid})`} /> : null}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line
              key={a}
              x1={Math.cos(a * RAD) * 7.4}
              y1={Math.sin(a * RAD) * 7.4}
              x2={Math.cos(a * RAD) * 11.4}
              y2={Math.sin(a * RAD) * 11.4}
              className="sp-ray"
            />
          ))}
          <circle r={5.4} className="sp-sun" style={lightColor ? { fill: lightColor } : undefined} />
        </>
      ) : (
        <>
          <rect x={-3.6} y={-9.4} width={7.2} height={3.4} rx={1.4} className="sp-cam" />
          <rect x={-8.8} y={-6.4} width={17.6} height={12.8} rx={2.8} className="sp-cam" />
          <circle r={3.5} className="sp-lens" />
          <circle r={1.4} className="sp-lens-core" />
        </>
      )}
    </g>
  );

  return (
    <svg
      ref={ref}
      className={`sphere-pad nodrag nopan ${dimmed ? "dim" : ""}`}
      viewBox="-120 -120 240 240"
      style={{ cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onDoubleClick={() => onChange(0, 0)}
    >
      <defs>
        <clipPath id={`spClip${uid}`}>
          <circle r={CORE} />
        </clipPath>
        {/* 球体体积感：左上受光、右下暗部 */}
        <radialGradient id={`spShade${uid}`} cx="0.38" cy="0.34" r="0.85">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.10" />
          <stop offset="62%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#05070f" stopOpacity="0.38" />
        </radialGradient>
        {/* 打光预演：以光源位置为中心的晕染 */}
        <radialGradient id={`spGlow${uid}`} gradientUnits="userSpaceOnUse" cx={x} cy={y} r={120}>
          <stop offset="0%" stopColor={glowColor} stopOpacity={front ? glowA : 0} />
          <stop offset="55%" stopColor={glowColor} stopOpacity={front ? glowA * 0.45 : 0} />
          <stop offset="100%" stopColor={glowColor} stopOpacity={0} />
        </radialGradient>
        {/* 光源图标光晕 */}
        <radialGradient id={`spHalo${uid}`}>
          <stop offset="0%" stopColor={glowColor} stopOpacity="0.85" />
          <stop offset="100%" stopColor={glowColor} stopOpacity="0" />
        </radialGradient>
        <filter id={`spBlur${uid}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>

      {/* 球面玻璃罩与经纬网格 */}
      <circle r={R} className="sp-dome" />
      <ellipse rx={R} ry={R * 0.32} className="sp-grid" />
      <ellipse rx={R * 0.32} ry={R} className="sp-grid" />
      <circle r={(R + CORE) / 2} className="sp-grid soft" />

      {/* 背面： tether 虚线 + 图标画在画面之下（「绕到了后面」） */}
      {!front ? <line x1={x} y1={y} x2={tx} y2={ty} className="sp-tether back" /> : null}
      {!front ? mark : null}

      {/* 中央画面（主体星球） */}
      <g clipPath={`url(#spClip${uid})`}>
        {thumb ? (
          <g transform={`scale(${zoom})`}>
            <image href={thumb} x={-CORE} y={-CORE} width={CORE * 2} height={CORE * 2} preserveAspectRatio="xMidYMid slice" />
          </g>
        ) : (
          <circle r={CORE} className="sp-photo" />
        )}
        <circle r={CORE} fill={`url(#spShade${uid})`} />
        {mode === "light" ? (
          <>
            <circle r={CORE} fill={`url(#spGlow${uid})`} />
            {veil.a > 0.005 ? <circle r={CORE} fill={veil.c} opacity={veil.a} /> : null}
          </>
        ) : null}
      </g>
      <circle r={CORE} className="sp-core-ring" />
      {/* 轮廓光 / 逆光：画面边缘亮圈 */}
      {showRim ? <circle r={CORE - 1} fill="none" stroke={glowColor} strokeWidth={3.2} opacity={rim ? 0.65 : 0.45} filter={`url(#spBlur${uid})`} /> : null}

      {/* 正面： tether 实线 + 视线锥 + 图标 */}
      {front ? <line x1={x} y1={y} x2={tx} y2={ty} className="sp-tether" /> : null}
      {front && mode === "camera" && len > 12 ? (
        <polygon
          points={`${x},${y} ${(-y / len) * CORE * 0.82},${(x / len) * CORE * 0.82} ${(y / len) * CORE * 0.82},${(-x / len) * CORE * 0.82}`}
          className="sp-cone"
        />
      ) : null}
      {front ? mark : null}
    </svg>
  );
}
