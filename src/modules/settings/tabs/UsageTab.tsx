/**
 * 设置面板 · 用量与稳定性页
 */
import { Row } from "../../../ui/kit";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useSettings } from "../../../core/stores/settingsStore";
import { useUsage } from "../../../core/stores/usageStore";

export function UsageTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  // rangeUsage/todayCost 每次返回新对象/需计算，不能做 selector（会无限重渲染）；读一次即可（切回此 tab 重新挂载会刷新）
  const range = useUsage.getState().rangeUsage(7);
  const todayCost = useUsage.getState().todayCost();
  const retry = settings.retry;
  const budget = settings.budget;
  const num = (v: string) => Number(v) || 0;
  const maxCost = Math.max(0.01, ...range.rows.map((r) => r.cost));
  const calls7 = range.rows.reduce((s, r) => s + r.calls, 0);
  const fails7 = range.rows.reduce((s, r) => s + r.fails, 0);
  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">用量与花费</div>
        <div className="set-page-d">
          每次生成（图/视频/音频）自动按模型单价记账、按天聚合预估花费；价格为粗略估算，不作为计费依据。
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-h">用量统计（近 7 天）</div>
        <div className="set-stats">
          <div className="set-stat">
            <b>¥{todayCost.toFixed(2)}</b>
            <span>今日花费</span>
          </div>
          <div className="set-stat">
            <b>¥{range.total.toFixed(2)}</b>
            <span>近 7 天累计</span>
          </div>
          <div className="set-stat">
            <b>{calls7}</b>
            <span>近 7 天调用（次）</span>
          </div>
          <div className="set-stat">
            <b>{fails7}</b>
            <span>近 7 天失败（次）</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 12 }}>
          {range.rows.length ? (
            range.rows.map((r) => (
              <div key={r.day} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ flex: "0 0 42px", color: "var(--text-2)" }}>{r.day.slice(5)}</span>
                <span
                  style={{
                    height: 10,
                    width: `${Math.max(3, (r.cost / maxCost) * 160)}px`,
                    borderRadius: 5,
                    background: "color-mix(in srgb, var(--accent) 60%, transparent)",
                  }}
                />
                <span style={{ color: "var(--text-2)" }}>
                  ¥{r.cost.toFixed(2)} · {r.calls} 次{r.fails ? ` · 失败 ${r.fails}` : ""}
                </span>
              </div>
            ))
          ) : (
            <div className="set-hint">还没有用量记录（生成图片/视频后这里会出现数据）</div>
          )}
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-h">预算护栏（0 = 不限制）</div>
        <Row gap={12} style={{ alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            日预算上限 ¥
            <input
              className="input"
              type="number"
              style={{ width: 100 }}
              value={budget.dailyCap}
              onChange={(e) => update("budget", { ...budget, dailyCap: num(e.target.value) })}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            超此花费二次确认 ¥
            <input
              className="input"
              type="number"
              style={{ width: 100 }}
              value={budget.confirmOverCost}
              onChange={(e) => update("budget", { ...budget, confirmOverCost: num(e.target.value) })}
            />
          </label>
        </Row>
        <p className="set-hint" style={{ marginTop: 8 }}>
          超日预算会阻断并报错；超确认阈值弹窗确认。Token 类（对话/分镜）按实际记账、暂不预拦。
        </p>
      </div>

      <div className="set-card">
        <div className="set-card-h">失败重试（中转站 429 / 5xx / 网络抖动）</div>
        <Row gap={12} style={{ alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            幂等请求重试
            <input
              className="input"
              type="number"
              style={{ width: 70 }}
              value={retry.idempotentMax}
              onChange={(e) => update("retry", { ...retry, idempotentMax: num(e.target.value) })}
            />
            次
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            生成类重试
            <input
              className="input"
              type="number"
              style={{ width: 70 }}
              value={retry.submitMax}
              onChange={(e) => update("retry", { ...retry, submitMax: num(e.target.value) })}
            />
            次
          </label>
        </Row>
        <p className="set-hint" style={{ marginTop: 8 }}>
          幂等请求（轮询/搜索/下载）自动重试，无扣费风险；生成类重试有重复扣费风险，默认关，按需开启。
        </p>
      </div>

      <div className="set-card">
        <div className="set-card-h">备用模型（主模型重试耗尽后换卡再试一次）</div>
        <Row gap={12} style={{ flexDirection: "column", alignItems: "stretch" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ flex: "0 0 64px" }}>绘画备用</span>
            <ModelPicker role="image" value={retry.fallbackImage || undefined} onChange={(v) => update("retry", { ...retry, fallbackImage: v || "" })} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ flex: "0 0 64px" }}>视频备用</span>
            <ModelPicker role="video" value={retry.fallbackVideo || undefined} onChange={(v) => update("retry", { ...retry, fallbackVideo: v || "" })} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ flex: "0 0 64px" }}>音频备用</span>
            <ModelPicker role="audio" value={retry.fallbackAudio || undefined} onChange={(v) => update("retry", { ...retry, fallbackAudio: v || "" })} />
          </label>
        </Row>
        <p className="set-hint" style={{ marginTop: 8 }}>
          留空 = 不兜底。建议选与主模型同家族的备用，跨家族时面板参数会自动适配。
        </p>
      </div>
    </div>
  );
}
