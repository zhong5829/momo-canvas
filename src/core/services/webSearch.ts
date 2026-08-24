/**
 * 联网搜索服务 — 多提供商适配（大陆可直连/有免费额度的优先）
 *  - 智谱搜索   https://open.bigmodel.cn  /api/paas/v4/web_search（国内直连，注册送额度）
 *  - 博查Bocha  https://open.bochaai.com  /v1/web-search（国内直连，按次计费）
 *  - LangSearch https://langsearch.com    /v1/web-search（国内可用，免费）
 *  - Tavily     https://tavily.com        /search（每月免费额度）
 *  - Serper     https://serper.dev        谷歌结果（注册送 2500 次）
 *  - Jina       https://jina.ai           s.jina.ai（注册送免费 Token）
 *  - SearXNG    自建实例 /search?format=json（免 Key）
 */
import type { SearchCfg, SearchHit, SearchProvider } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

/** 提供商元信息（设置页展示 + 官网跳转共用） */
export const SEARCH_PROVIDERS: {
  value: SearchProvider;
  label: string;
  desc: string;
  /** 官网/控制台地址（设置页一键跳转去注册拿 Key） */
  site: string;
  needs: "key" | "baseUrl";
}[] = [
  { value: "zhipu", label: "智谱搜索", desc: "国内直连 · 注册送免费额度", site: "https://open.bigmodel.cn", needs: "key" },
  { value: "bocha", label: "博查 Bocha", desc: "国内直连 · 按次计费（便宜）", site: "https://open.bochaai.com", needs: "key" },
  { value: "langsearch", label: "LangSearch", desc: "国内可用 · 免费", site: "https://langsearch.com", needs: "key" },
  { value: "tavily", label: "Tavily", desc: "每月 1000 次免费额度", site: "https://tavily.com", needs: "key" },
  { value: "serper", label: "Serper（谷歌结果）", desc: "注册送 2500 次免费", site: "https://serper.dev", needs: "key" },
  { value: "jina", label: "Jina 搜索", desc: "注册送免费 Token 额度", site: "https://jina.ai/api-dashboard", needs: "key" },
  { value: "searxng", label: "SearXNG", desc: "自建实例 · 免 Key", site: "https://docs.searxng.org", needs: "baseUrl" },
];

const needKey = (name: string) => new Error(`请在「设置 → 联网搜索」填写 ${name} API Key（服务商旁有官网入口，注册即可获取）`);

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function webSearch(cfg: SearchCfg, query: string): Promise<SearchHit[]> {
  const n = cfg.maxResults || 5;
  switch (cfg.provider) {
    case "zhipu": {
      if (!cfg.apiKey) throw needKey("智谱");
      const resp = await xfetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ search_engine: "search_std", search_query: query, count: n }),
      });
      if (!resp.ok) throw new Error(`智谱搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      return (j.search_result ?? []).slice(0, n).map((r: any) => ({
        title: r.title ?? r.link,
        url: r.link ?? r.url ?? "",
        snippet: (r.content ?? "").slice(0, 300),
      }));
    }
    case "bocha": {
      if (!cfg.apiKey) throw needKey("博查");
      const resp = await xfetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ query, count: n, summary: true }),
      });
      if (!resp.ok) throw new Error(`博查搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      const items = j.data?.webPages?.value ?? [];
      return items.map((r: any) => ({
        title: r.name ?? r.url,
        url: r.url,
        snippet: (r.summary ?? r.snippet ?? "").slice(0, 300),
      }));
    }
    case "langsearch": {
      if (!cfg.apiKey) throw needKey("LangSearch");
      const resp = await xfetch("https://api.langsearch.com/v1/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ query, summary: true, count: n }),
      });
      if (!resp.ok) throw new Error(`LangSearch 搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      const items = j.data?.webPages?.value ?? [];
      return items.map((r: any) => ({
        title: r.name ?? r.url,
        url: r.url,
        snippet: (r.summary ?? r.snippet ?? "").slice(0, 300),
      }));
    }
    case "tavily": {
      if (!cfg.apiKey) throw needKey("Tavily");
      const resp = await xfetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: n }),
      });
      if (!resp.ok) throw new Error(`Tavily 搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      return (j.results ?? []).map((r: any) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.content ?? "").slice(0, 300),
      }));
    }
    case "serper": {
      if (!cfg.apiKey) throw needKey("Serper");
      const resp = await xfetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: n, hl: "zh-cn" }),
      });
      if (!resp.ok) throw new Error(`Serper 搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      return (j.organic ?? []).slice(0, n).map((r: any) => ({
        title: r.title ?? r.link,
        url: r.link,
        snippet: (r.snippet ?? "").slice(0, 300),
      }));
    }
    case "jina": {
      if (!cfg.apiKey) throw needKey("Jina");
      const resp = await xfetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: "application/json",
          // 只要标题/摘要不要全文，省 Token 也省时间
          "X-Respond-With": "no-content",
        },
      });
      if (!resp.ok) throw new Error(`Jina 搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      return (j.data ?? []).slice(0, n).map((r: any) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.description ?? r.content ?? "").slice(0, 300),
      }));
    }
    case "searxng": {
      if (!cfg.baseUrl) throw new Error("请在「设置 → 联网搜索」填写 SearXNG 实例地址");
      const u = `${trimBase(cfg.baseUrl)}/search?q=${encodeURIComponent(query)}&format=json`;
      const resp = await xfetch(u);
      if (!resp.ok) throw new Error(`SearXNG 搜索失败 ${resp.status}`);
      const j = await resp.json();
      return (j.results ?? []).slice(0, n).map((r: any) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.content ?? "").slice(0, 300),
      }));
    }
  }
}

/** 把搜索结果拼成可注入对话的上下文块 */
export function searchContext(hits: SearchHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`);
  return `以下是与用户问题相关的实时网络搜索结果，请结合它们回答，并在引用处标注 [序号]：\n\n${lines.join("\n\n")}`;
}
