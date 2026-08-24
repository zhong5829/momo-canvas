/**
 * 轻量 UI 组件
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { IcClose } from "./icons";

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

/** 数字输入框（本地文本态）：编辑期间允许空串/中间态自由输入，失焦或回车按 [min,max] 钳制提交。
 *  专治「onChange 即钳制导致永远输不进去」（如下限 16 时清空或打 "5" 都被立刻弹回 16）。
 *  击键时若已是合法数字会实时同步（不钳制），预览类消费方即刻刷新；边界钳制只在提交时发生。 */
export function NumInput({
  value,
  min,
  max,
  step,
  className,
  placeholder,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  placeholder?: string;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (n: number) => {
    let v = Math.round(n);
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const commit = (t: string | null) => {
    setText(null);
    if (t === null || t.trim() === "") return; // 空提交 = 放弃，回显原值
    const n = Number(t);
    if (Number.isFinite(n)) onCommit(clamp(n));
  };
  return (
    <input
      className={className}
      type="number"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={text ?? value}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const n = Number(t);
        if (t.trim() !== "" && Number.isFinite(n)) onCommit(Math.round(n));
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** 文字徽章：描边方框内嵌短文字（4K / PNG / TIFF 等选项图标，替代彩色圆点） */
export function TxBadge({ t, wide }: { t: string; wide?: boolean }) {
  return <span className={`tx-badge ${wide ? "wide" : ""}`}>{t}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Row({ children, gap = 10, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: "flex", alignItems: "center", gap, ...style }}>{children}</div>;
}

/** 方格选项组：圆角方形按钮（图标 + 名称），替代下拉菜单 */
export function OptGrid({
  options,
  value,
  onChange,
  cols = 3,
}: {
  options: { value: string; label: string; icon?: ReactNode }[];
  value: string;
  onChange: (v: string) => void;
  cols?: number;
}) {
  return (
    <div className="opt-grid nodrag" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {options.map((o) => (
        <button key={o.value} className={`opt-cell ${value === o.value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          {o.icon ? <span className="oc-ic">{o.icon}</span> : null}
          <span className="oc-lab">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = 720,
  footer,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ""}`} style={{ width }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--panel-border)",
          }}
        >
          <div style={{ fontSize: "var(--fs-title)", fontWeight: 700 }}>{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IcClose />
          </button>
        </div>
        <div style={{ padding: 20, overflowY: "auto", flex: 1 }}>{children}</div>
        {footer ? (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              padding: "12px 20px 16px",
              borderTop: "1px solid var(--panel-border)",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
