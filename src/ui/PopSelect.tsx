/**
 * 统一浮层下拉系统 — LibLib 式圆角卡片弹层，全应用替代原生 <select>。
 * - PopLayer：通用浮层容器（点击外部 / Esc 关闭，弹性缩放淡入动画，按视口空间自动向上/向下翻转）
 * - PopSelect：通用下拉（触发按钮 = 当前值 + 下拉箭头；弹层列表项 = 图标 + 标题 + 描述 + 选中勾）
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { IcCheck, IcChevronD } from "./icons";

export interface PopOption {
  value: string;
  label: string;
  /** 第二行灰色小字描述（如服务商名） */
  desc?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/** 当前打开的浮层栈（后开的在末尾）：Esc 只关最上层 */
const layerStack: RefObject<HTMLDivElement | null>[] = [];

/** 浮层容器：挂在触发器父级（.pop-wrap）内，绝对定位向上/向下弹出 */
export function PopLayer({
  anchorRef,
  onClose,
  up,
  children,
  className,
  style,
}: {
  /** 触发器所在容器：点在容器内（如触发按钮）不视为外部点击 */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 强制向上弹出；不传则按视口剩余空间自动判断 */
  up?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(up ?? false);
  const [alignRight, setAlignRight] = useState(false);

  // 翻转/收边按实测尺寸算，并在内容变化（弹层换视图）与窗口缩放时重算
  useLayoutEffect(() => {
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!r || !el) return;
      if (up === undefined) {
        const below = window.innerHeight - r.bottom;
        setFlipUp(below < el.offsetHeight + 16 && r.top > below);
      } else {
        setFlipUp(up);
      }
      const lw = el.offsetWidth;
      if (lw) setAlignRight(r.left + lw > window.innerWidth - 12 && r.right - lw > 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [up, anchorRef]);

  useEffect(() => {
    // 浮层栈：嵌套弹层时 Esc 只关最上面那层（否则一次全关，外层弹窗也跟着没了）
    layerStack.push(ref);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // 触发按钮的 onClick 自己处理开合
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (layerStack[layerStack.length - 1] !== ref) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      const i = layerStack.indexOf(ref);
      if (i >= 0) layerStack.splice(i, 1);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  return (
    <div ref={ref} className={`pop-layer nodrag nowheel ${flipUp ? "up" : "down"} ${alignRight ? "align-right" : ""} ${className ?? ""}`} style={style}>
      {children}
    </div>
  );
}

/** 通用下拉：原生 select 的完整替代（动作型用法：value 固定传 ""，onChange 即触发动作） */
export function PopSelect({
  value,
  options,
  onChange,
  placeholder = "请选择…",
  title,
  className,
  layerClassName,
  style,
  up,
  disabled,
  triggerIcon,
}: {
  value: string;
  options: PopOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  /** 弹层顶部标题（如「模型选择」） */
  title?: string;
  className?: string;
  /** 弹层附加类名（调宽 / 右对齐等） */
  layerClassName?: string;
  style?: CSSProperties;
  up?: boolean;
  disabled?: boolean;
  /** 触发按钮也显示当前项图标（默认只显示文字） */
  triggerIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);
  return (
    <div ref={wrapRef} className={`pop-wrap ${className ?? ""}`} style={style}>
      <button
        type="button"
        className={`pop-trigger ${open ? "open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerIcon && cur?.icon ? <span className="pt-ic">{cur.icon}</span> : null}
        <span className={`pt-label ${cur ? "" : "ph"}`}>{cur ? cur.label : placeholder}</span>
        <IcChevronD size={13} />
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={() => setOpen(false)} up={up} className={layerClassName}>
          {title ? <div className="pop-title">{title}</div> : null}
          <div className="pop-list">
            {options.map((o) => (
              <button
                key={o.value || "__ph__"}
                type="button"
                className={`pop-item ${o.value === value ? "on" : ""}`}
                disabled={o.disabled}
                onClick={() => {
                  if (o.disabled) return;
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.icon ? <span className="pi-icon">{o.icon}</span> : null}
                <span className="pi-text">
                  <span className="pi-label">{o.label}</span>
                  {o.desc ? <span className="pi-desc">{o.desc}</span> : null}
                </span>
                {o.value === value ? <IcCheck size={15} /> : null}
              </button>
            ))}
          </div>
        </PopLayer>
      ) : null}
    </div>
  );
}
