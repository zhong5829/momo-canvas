/**
 * 错误边界 — 把子树渲染异常兜在局部，避免整棵 React 树卸载白屏。
 * 全仓此前没有任何 ErrorBoundary，一个渲染期 throw 就是整窗白屏（导演台生成页事故）。
 */
import { Component, type ReactNode } from "react";

type Props = {
  /** 出错时显示的区域名称（如「该页签」） */
  name?: string;
  children: ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error(`[ErrorBoundary] ${this.props.name ?? "区域"}渲染异常:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="err-boundary">
          <div className="eb-title">{this.props.name ?? "该区域"}出错了</div>
          <div className="eb-msg">{error.message || String(error)}</div>
          <button className="btn sm" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
