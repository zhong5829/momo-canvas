/**
 * 导演台双语资产册（MOMO_ASSET_CATALOG_V1）解析器。
 *
 * 资产册是项目唯一素材源的可读清单：每项一张真实图片、一份中文提示词、
 * 一份英文提示词，并可声明使用分段。站位图还能携带双语空间锁；图片槽不足时
 * 执行层只丢弃站位图本身，仍保留文字空间约束。
 */

export type DirectorAssetCatalogEntry = {
  id: string;
  name: string;
  file: string;
  type: string;
  role: "appearance" | "spatialLayout";
  /** 全片顺序中的 1-based 分段号；空数组表示只入资产库、不自动绑定 */
  segments: number[];
  /** 所有使用分段共用的静态 Picture 顺序；分段专用顺序优先于它。 */
  referenceOrder?: number;
  /** 少数资产在不同分段占不同槽位时使用：分段号 → 1-based Picture 顺序。 */
  segmentReferenceOrders: Record<number, number>;
  promptZh: string;
  promptEn: string;
  spatialLockZh?: string;
  spatialLockEn?: string;
};

export type DirectorAssetCatalog = {
  version: "MOMO_ASSET_CATALOG_V1";
  entries: DirectorAssetCatalogEntry[];
  warnings: string[];
};

const cleanInline = (v: string) => v.trim().replace(/^`|`$/g, "").trim();

/** Markdown 图片路径只接受资产册目录内的相对路径，防止误读其它项目。 */
export function normalizeCatalogRelativePath(raw: string): string | null {
  let value = cleanInline(raw).replace(/^<|>$/g, "").trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非 URL 编码路径原样继续。
  }
  value = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || /^([a-z]:|\/|\\)/i.test(value) || /(^|\/)\.\.(\/|$)/.test(value)) return null;
  return value;
}

function parseSegments(raw: string): number[] {
  if (/全部|all/i.test(raw)) return [-1];
  const out = new Set<number>();
  for (const range of raw.matchAll(/(\d{1,3})\s*[-–—~至]\s*(\d{1,3})/g)) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a > 0 && b >= a && b - a <= 200) for (let n = a; n <= b; n++) out.add(n);
  }
  const withoutRanges = raw.replace(/\d{1,3}\s*[-–—~至]\s*\d{1,3}/g, " ");
  for (const m of withoutRanges.matchAll(/\d{1,3}/g)) {
    const n = Number(m[0]);
    if (n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 参考顺序支持两种写法：
 * - `2` 或 `全部=2`：所有使用分段均为 Picture 2；
 * - `01=2, 03=4`：按分段单独声明。
 */
function parseReferenceOrder(raw: string): { referenceOrder?: number; segmentReferenceOrders: Record<number, number> } {
  const segmentReferenceOrders: Record<number, number> = {};
  let referenceOrder: number | undefined;
  const pairRe = /(?:第\s*)?(\d{1,3})(?:\s*段)?\s*[:=→]\s*(\d{1,2})/gi;
  for (const m of raw.matchAll(pairRe)) {
    const segment = Number(m[1]);
    const order = Number(m[2]);
    if (segment > 0 && order > 0) segmentReferenceOrders[segment] = order;
  }
  const all = raw.match(/(?:全部|all)\s*[:=→]\s*(\d{1,2})/i);
  if (all && Number(all[1]) > 0) referenceOrder = Number(all[1]);
  if (!Object.keys(segmentReferenceOrders).length && !referenceOrder) {
    const only = raw.trim().match(/^0*(\d{1,2})$/);
    if (only && Number(only[1]) > 0) referenceOrder = Number(only[1]);
  }
  return { referenceOrder, segmentReferenceOrders };
}

/** 没写参考顺序的旧资产册按常用 H3 顺序降级，保证场景不会排到人物后面。 */
function fallbackReferenceOrder(entry: Pick<DirectorAssetCatalogEntry, "type" | "role">): number {
  if (entry.role === "spatialLayout") return 4;
  if (/场景|环境|scene|location|environment/i.test(entry.type)) return 1;
  if (/人物|角色|群像|character|person|subject|team/i.test(entry.type)) return 2;
  if (/道具|物品|装备|武器|prop|item|equipment|weapon/i.test(entry.type)) return 3;
  return 5;
}

/** 返回某分段中该资产应占的 1-based Picture 顺序。 */
export function catalogReferenceOrder(entry: DirectorAssetCatalogEntry, segmentNumber: number): number {
  return entry.segmentReferenceOrders[segmentNumber] ?? entry.referenceOrder ?? fallbackReferenceOrder(entry);
}

function section(body: string, heads: RegExp): string {
  const lines = body.split(/\r?\n/);
  let active = false;
  const out: string[] = [];
  for (const line of lines) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      if (active) break;
      active = heads.test(h[1].trim());
      continue;
    }
    if (active) out.push(line);
  }
  return out.join("\n").trim();
}

function meta(body: string, labels: string[]): string {
  const alt = labels.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const m = body.match(new RegExp(`^\\s*[-*]\\s*(?:${alt})\\s*[:：]\\s*(.+?)\\s*$`, "im"));
  return cleanInline(m?.[1] ?? "");
}

/**
 * 识别格式：`## ID | 名称` + Markdown 图片 + 元数据 + 中英文三级标题。
 * 缺图片、缺任一语言提示词的条目不会导入，并以 warning 返回给 UI。
 */
export function parseDirectorAssetCatalog(markdown: string): DirectorAssetCatalog {
  const warnings: string[] = [];
  const version = /MOMO_ASSET_CATALOG_V1/.test(markdown) ? "MOMO_ASSET_CATALOG_V1" : "MOMO_ASSET_CATALOG_V1";
  const marks = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  const entries: DirectorAssetCatalogEntry[] = [];
  for (let i = 0; i < marks.length; i++) {
    const rawHead = marks[i][1].trim();
    const start = (marks[i].index ?? 0) + marks[i][0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? markdown.length) : markdown.length;
    const body = markdown.slice(start, end);
    const [rawId, ...nameParts] = rawHead.split(/[|｜]/).map((x) => x.trim());
    const id = rawId || `ASSET-${i + 1}`;
    const name = nameParts.join(" | ") || rawId;
    const image = body.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? meta(body, ["文件", "File"]);
    const file = normalizeCatalogRelativePath(image ?? "");
    const promptZh = section(body, /^(中文提示词|Chinese Prompt 中文)$/i);
    const promptEn = section(body, /^(英文提示词|English Prompt)$/i);
    if (!file || !promptZh || !promptEn) {
      warnings.push(`${id}「${name}」缺少安全相对图片路径、中文提示词或英文提示词，已跳过`);
      continue;
    }
    const type = meta(body, ["类型", "Type"]) || "图片";
    const roleRaw = meta(body, ["用途", "Role"]);
    const role = /站位|空间|layout|spatial/i.test(`${type} ${roleRaw}`) ? "spatialLayout" : "appearance";
    const segmentRaw = meta(body, ["使用分段", "Segments"]);
    const order = parseReferenceOrder(meta(body, ["参考顺序", "槽位顺序", "Reference Order", "Picture Order"]));
    entries.push({
      id,
      name,
      file,
      type,
      role,
      segments: parseSegments(segmentRaw),
      referenceOrder: order.referenceOrder,
      segmentReferenceOrders: order.segmentReferenceOrders,
      promptZh,
      promptEn,
      spatialLockZh: meta(body, ["中文空间锁", "Spatial Lock ZH"]) || undefined,
      spatialLockEn: meta(body, ["英文空间锁", "Spatial Lock EN"]) || undefined,
    });
  }
  if (!marks.length) warnings.push("没有找到 `## 资产编号 | 资产名称` 条目");
  return { version, entries, warnings };
}
