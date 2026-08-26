/**
 * 设置面板 · 联网搜索页
 */
import { Field, Row } from "../../../ui/kit";
import { PopSelect } from "../../../ui/PopSelect";
import { useSettings } from "../../../core/stores/settingsStore";
import { SEARCH_PROVIDERS } from "../../../core/services/webSearch";
import { openExternal } from "../../../core/external";
import { IcGlobe } from "../../../ui/icons";
import { type SearchProvider, type Settings } from "../../../core/types";
import { SecHelp } from "../shared";

export function SearchTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const patch = (part: Partial<Settings["search"]>) => update("search", { ...settings.search, ...part });
  const p = settings.search.provider;
  const meta = SEARCH_PROVIDERS.find((x) => x.value === p);
  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">联网搜索</div>
        <div className="set-page-d">开启创作助手上的 🌐 后，提问会先联网检索再作答并给出来源。</div>
      </div>
      <div className="set-card">
        <div className="set-card-h">
          搜索接口
          <span className="sec-h-tail">
            <SecHelp>
              模型自带联网能力（GLM / MiniMax / 混元等）时优先用模型自己的搜索，失败自动降级到这里配置的搜索接口。
              推荐国内直连的智谱 / 博查 / LangSearch（都有免费额度或价格很低）。
            </SecHelp>
          </span>
        </div>
        <Field label="搜索服务商">
          <Row gap={8} style={{ alignItems: "center" }}>
            <PopSelect
              style={{ width: 260 }}
              value={p}
              options={SEARCH_PROVIDERS.map((x) => ({ value: x.value, label: x.label, desc: x.desc }))}
              onChange={(v) => patch({ provider: v as SearchProvider })}
            />
            {meta ? (
              <button
                className="btn sm"
                title={`打开 ${meta.site}（注册 / 获取 API Key）`}
                onClick={() => void openExternal(meta.site)}
              >
                <IcGlobe size={13} /> 官网 ↗
              </button>
            ) : null}
          </Row>
        </Field>
        {meta?.needs !== "baseUrl" ? (
          <Field label="API Key" hint={meta ? `到 ${meta.site.replace(/^https?:\/\//, "")} 注册获取（${meta.desc}）` : undefined}>
            <input className="input" type="password" value={settings.search.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value.trim() })} />
          </Field>
        ) : (
          <Field label="实例地址" hint="例如 http://127.0.0.1:8080（需开启 JSON 输出）">
            <input className="input" value={settings.search.baseUrl} placeholder="http://127.0.0.1:8080"
              onChange={(e) => patch({ baseUrl: e.target.value.trim() })} />
          </Field>
        )}
        <Field label="结果条数">
          <PopSelect
            style={{ width: 140 }}
            value={String(settings.search.maxResults)}
            options={[3, 5, 8, 10].map((n) => ({ value: String(n), label: `${n} 条` }))}
            onChange={(v) => patch({ maxResults: Number(v) })}
          />
        </Field>
      </div>
    </div>
  );
}
