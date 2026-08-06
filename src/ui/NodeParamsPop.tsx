/**
 * 通用「触发按钮 + 浮层」参数弹窗壳 — 统一底部栏 chip 弹卡与节点工具栏按钮弹窗两种用法。
 * 底座 PopLayer 已带点外 / Esc 关闭与视口自动翻转；卡片样式复用 .gd-param-pop。
 *
 * - 默认触发器：底部栏的 .gd-chip（传 icon/label/title，up 由调用方决定）。
 *   例：<NodeParamsPop icon label title up>…表单…</NodeParamsPop>
 * - 自定义触发器：传 trigger={({open,toggle}) => <button className="nt-btn">…</button>}，
 *   用于节点悬浮工具条按钮。触发器会被本组件的 .pop-wrap 包裹，PopLayer 据此锚定 / 点外关闭。
 *   例：<NodeParamsPop trigger={({open,toggle}) => <button className={`nt-btn ${open?"on":""}`} onClick={toggle}>设置</button>}>…</NodeParamsPop>
 */
import { useRef, useState, type ReactNode } from "react";
import { PopLayer } from "./PopSelect";
import { IcChevronD } from "./icons";

export function NodeParamsPop({
  icon,
  label,
  title,
  up,
  layerClassName,
  className,
  trigger,
  children,
}: {
  icon?: ReactNode;
  label?: string;
  title?: string;
  /** 强制向上弹；不传则按视口剩余空间自动翻转（底部栏场景不传也会向上） */
  up?: boolean;
  /** 弹层附加类名（调宽等），默认 .gd-param-pop 已在 className 里 */
  layerClassName?: string;
  className?: string;
  /** 自定义触发器（如节点工具栏的 nt-btn）；不传则用默认 gd-chip */
  trigger?: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggle = () => setOpen((v) => !v);
  return (
    <div ref={wrapRef} className={`pop-wrap ${className ?? ""}`}>
      {trigger ? (
        trigger({ open, toggle })
      ) : (
        <button type="button" className={`gd-chip ${open ? "open" : ""}`} title={title ?? label} onClick={toggle}>
          {icon}
          {label ? <span className="gd-chip-lab">{label}</span> : null}
          <IcChevronD size={12} className="chev" />
        </button>
      )}
      {open ? (
        <PopLayer
          anchorRef={wrapRef}
          onClose={() => setOpen(false)}
          up={up}
          className={`gd-param-pop gp-scope ${layerClassName ?? ""}`}
        >
          {children}
        </PopLayer>
      ) : null}
    </div>
  );
}
