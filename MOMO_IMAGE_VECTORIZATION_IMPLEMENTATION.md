# MOMO 图像转矢量与多格式导出实施规格

> 文档用途：指导 GLM 或其他编码代理在现有 MOMO 画布软件中实现“智能矢量化”功能。
>
> 文档范围：只覆盖图像转矢量、矢量结果进入画布、矢量质量验证以及 SVG、PDF、EPS、AI、CDR 导出。
>
> 关联文档：`MOMO_SUPER_RESOLUTION_IMPLEMENTATION.md`
>
> 核验日期：2026-07-31
>
> **落地状态（2026-08-01）**：四档质量（极速单候选 / 标准 3 候选 / 高保真 5 候选 / 少节点简化候选）、resvg 渲染评分选优（颜色 RMSE + Sobel 边缘 IoU + 锚点预算）、黑白线稿 Otsu/固定阈值变体、analysisMap 消费（flatRatio/edgeDensity 微调 + 高压缩提示）、椭圆/圆角矩形图元、EPS 独立导出（usvg→PostScript，渐变降级纯填充）均已实现并测试通过（`src-tauri/src/vec.rs`/`vec_score.rs`/`geom.rs`/`export.rs`）。StarVector（1B/8B VLM）与 diffvg（PyTorch 可微光栅化）需 Python/PyTorch 线路，**暂缓**；SAM2 同。

## 1. 实施前提

GLM 必须首先阅读 MOMO 当前源码和关联文档，识别以下现有能力：

- 画布节点协议和节点注册方式。
- 图层、组、路径、文字、图片和蒙版的数据模型。
- 资产存储和内容哈希。
- 后台任务、进度、取消和 Worker。
- 撤销、重做和项目持久化。
- 超清增强节点的输入、输出和资产血缘。
- SVG、PDF或其他矢量导入导出能力。
- Windows 原生模块、子进程和 IPC 边界。

本文档定义目标和边界，不要求为了实现矢量化而替换 MOMO 已有画布架构。已有类型、服务或任务系统能够满足要求时必须复用。

## 2. 已核验结论

以下结论已经根据模型、算法和软件厂商文档重新核验。

### 2.1 VTracer 适合作为默认追踪核心

[VTracer](https://github.com/visioncortex/vtracer) 支持彩色位图转 SVG，并提供 Rust、Python 和 Node.js/WASM 接口。当前 1.0 系列增加或公开了：

- `stacked` 与无缝 `cutout` 层级模式。
- 共享边界的无缝色块拼接。
- 固定调色板和最大颜色数。
- `--simplify` 曲线简化。
- 彩色聚类、黑白追踪和 watershed 聚类。
- `poster`、`photo`、`bw` 预设。
- 输出优化。

注意：当前仓库展示的 1.0 包版本仍可能是预发布版本，例如 `1.0.0-alpha.2`。实施时必须固定具体版本或提交哈希，并用 MOMO 测试集验证后再升级。

### 2.2 StarVector 不能作为照片和普通插画默认模型

[StarVector](https://github.com/joanrod/star-vector) 提供 1B 和 8B 图像转 SVG 模型，适合：

- 图标。
- Logo。
- 字形。
- 技术图。
- 图表和示意图。

StarVector 官方明确说明其模型没有针对自然图片和普通插画训练。因此：

- 不用于写实人物照片默认路径。
- 不用于 AI 头像和文化墙插画默认路径。
- 仅作为 Logo、图标和技术图的可选候选生成器。
- 所有生成 SVG 必须解析、清洗、重新渲染和评分，不能直接信任模型文本输出。

### 2.3 SAM 2 不适合作为 Windows 首版强依赖

[SAM 2](https://github.com/facebookresearch/sam2) 可以用于交互式或自动分割，但官方在 Windows 上强烈建议使用 WSL，并依赖 PyTorch 和可选 CUDA 扩展。因此：

- SAM 2.1 可以作为专业模式或可选分割适配器。
- Windows 首版默认路径应使用现有 MOMO 分割能力或可直接部署的轻量 ONNX 模型。
- 用户点击、框选或画笔遮罩必须能够替代自动分割。
- 矢量化主流程不能因 SAM 2 缺失而不可用。

### 2.4 高清放大不是所有输入的固定第一步

强锐化和生成式超分会制造纹理，导致：

- 色块碎片增多。
- 锚点数量增加。
- 边缘出现双线或光晕。
- 人像毛发和皮肤产生难以编辑的小路径。

矢量化应同时保留：

```text
structureSource：原图或仅做去压缩/降噪的结构源
vectorGuide：可选的轻量保结构边缘引导图
```

结构、颜色和拓扑以 `structureSource` 为准；`vectorGuide` 只辅助确定边缘。不得无条件将 UltraSharp 等强纹理结果作为唯一追踪输入。

### 2.5 原生 AI 与 CDR 不能由改扩展名实现

- AI 是 Adobe 专有格式。[Adobe AI 格式说明](https://www.adobe.com/creativecloud/file-types/image/vector/ai-file.html)指出完整 AI 文件应由 Illustrator 创建和保存。
- Illustrator 的脚本接口支持 `Document.saveAs()` 和 `IllustratorSaveOptions`，可以在已安装 Illustrator 时保存原生 AI。[IllustratorSaveOptions](https://ai-scripting.docsforadobe.dev/jsobjref/IllustratorSaveOptions/)
- CorelDRAW SDK 支持导入非原生文件和 `Document.SaveAs()`，可以在已安装 CorelDRAW 时保存原生 CDR。[Layer.Import](https://community.coreldraw.com/sdk/api/draw/26/m/layer.import?lang=js)、[Document.SaveAs](https://community.coreldraw.com/sdk/api/draw/26/m/document.saveas?lang=vba)
- `libcdr` 是 CDR 读取/导入方向的库，不是可依赖的现代 CDR 写出器。

因此：

- 无 Illustrator 时，禁用“原生 AI”，提供 SVG、PDF、EPS。
- 无 CorelDRAW 时，禁用“原生 CDR”，提供 SVG、PDF。
- 不允许把 PDF 改名为 `.ai`。
- 不允许把 SVG 或 ZIP 改名为 `.cdr`。

### 2.6 EPS 是兼容格式，不是现代母版格式

[Adobe EPS 说明](https://helpx.adobe.com/illustrator/using/importing-eps-dcs-autocad-files.html)指出 EPS 不支持现代透明度。导出 EPS 时可能需要：

- 展开透明度。
- 展开部分描边。
- 将不兼容效果栅格化。
- 将文字转曲。

MOMO 的内部矢量文档应是唯一权威母版。规范化 SVG 是开放交换和恢复快照，不应替代内部文档保存 CMYK、专色或 MOMO 专有编辑信息。EPS 只作为兼容交付格式。

## 3. 产品目标

在 MOMO 中增加完全本地运行的“智能矢量化”能力，主要服务于：

- 文化墙装饰元素。
- Logo、标志、印章和剪影。
- 打卡框、展板边框和几何装饰。
- AI 生成的扁平头像和卡通头像。
- 扁平插画、党建素材和图标。
- 扫描线稿、手绘线稿和黑白图案。
- 扁平位图海报中的可恢复图形。

处理结果应：

- 可以作为 MOMO 原生矢量对象继续编辑。
- 尽量使用矩形、圆、椭圆、线段、文字等语义对象。
- 避免不必要的小碎片和过多锚点。
- 保持图层、组、遮罩和对象名称。
- 能导出 SVG、PDF、EPS。
- 在检测到对应软件时，能导出原生 AI 和 CDR。

## 4. 非目标与诚实边界

首版不承诺：

- 将写实照片转换为节点很少且照片级还原的纯矢量。
- 自动准确恢复低清中文的原字体、字距和排版。
- 从严重模糊图中恢复真实 Logo 结构。
- 在没有 Illustrator 时生成完整原生 AI。
- 在没有 CorelDRAW 时生成完整原生 CDR。
- 保证所有渐变网格、混合模式和专有特效在所有格式中完全一致。

写实照片应提供两个明确选项：

```text
矢量肖像：主动降低颜色和细节，输出风格化矢量
保留照片：主体使用裁剪后的位图，外框和装饰转矢量
```

不能把包含嵌入位图的 SVG 宣传成“全部已经矢量化”。

## 5. 产品形态

### 5.1 独立节点

节点显示名称：

```text
MOMO 智能矢量化
```

节点端口：

```text
输入：
- image：必需，位图资产
- originalImage：可选，高清增强前的原始资产
- vectorGuide：可选，高清节点输出的保结构边缘引导资产
- analysisMap：可选，高清增强节点输出的内容分析资产
- mask：可选，用户指定的处理区域
- palette：可选，品牌或项目调色板

输出：
- vectorDocument：MOMO 原生矢量文档
- preview：矢量结果预览
- qualityReport：质量、节点数和兼容性报告
- exportArtifact：可选的导出文件引用
```

### 5.2 快捷入口

提供：

```text
右键图片 -> 智能矢量化
右键图片 -> 高清并矢量化
工具栏 -> 矢量化
```

快捷入口内部创建或复用节点，不实现第二套处理逻辑。

### 5.3 与超清增强的关系

推荐节点组合：

```text
图片 -> MOMO 超清增强 -> MOMO 智能矢量化
```

两个节点是独立功能。矢量化节点可以直接处理普通图片；收到高清节点输出时，则优先通过资产血缘找到原图和分析资产：

```text
enhancedAsset.sourceAssetId -> originalAsset
enhancedAsset.vectorGuideAssetId -> MomoVectorGuideMetadata
enhancedAsset.analysisMapAssetId -> MomoEnhanceAnalysisMap
```

矢量化节点使用：

- 原图或只做去压缩/降噪的图作为结构源。
- `vectorGuide`作为可选边缘定位、圆角识别和局部控制点微调参考。
- 最终高清结果只作为预览参考，不自动成为追踪源。
- `analysisMap` 中的文字、Logo、几何、色块、插画、人像和边缘掩膜作为可选先验。
- 不重复运行完整超清流水线。
- 不把最终 CAS/USM 锐化图作为唯一结构源或唯一追踪输入。
- 缺少或不兼容 `vectorGuide` 时，从结构源生成临时轻量边缘源或直接使用原图边缘。
- 缺少或不兼容 `analysisMap` 时，在矢量节点内部独立完成轻量分析。

“高清并矢量化”快捷功能应自动创建两个节点，连接 `image`、`vectorGuide` 和 `analysisMap`，并保留 `originalImage` 或等价资产血缘。最终 `image` 只用于结果预览和必要的混合输出，不自动成为结构源。

`vectorGuide` 复用必须满足：

- `schemaVersion` 受支持。
- `sourceAssetId` 与当前结构源血缘一致。
- `sourceToGuideTransform` 和 `guideToSourceTransform` 互逆并通过边界检查。
- 最多放大2x且最长边不超过4096像素。
- 元数据声明未执行最终锐化、生成式修复和纹理增强。
- 图像资产存在，尺寸、Alpha和颜色信息可解析。

不满足时丢弃 `vectorGuide` 并写入质量报告，不应导致矢量化失败。

`analysisMap` 复用必须满足：

- `schemaVersion` 受支持。
- `sourceAssetId` 与当前资产血缘一致。
- `modelSpaceTransform` 可逆且坐标映射通过边界检查。
- 掩膜尺寸、通道和引用资产有效。
- 分析算法版本仍在缓存兼容范围内。

任何一项不满足时只丢弃分析先验，不应导致矢量化任务失败。

## 6. 节点界面

### 6.1 主参数

| 参数 | 选项 | 默认值 |
|---|---|---|
| 内容类型 | 自动、Logo、打卡框、扁平插画、AI头像、线稿、矢量肖像 | 自动 |
| 质量模式 | 极速、标准、高保真、少节点 | 标准 |
| 颜色数量 | 自动、2、4、8、16、24、32、64 | 自动 |
| 细节 | 0 至 100 | 45 |
| 平滑 | 0 至 100 | 55 |
| 节点优化 | 0 至 100 | 60 |
| 背景 | 自动移除、保留、透明 | 自动移除 |
| 文字 | 保护、OCR重建、转轮廓、忽略 | 保护 |
| 输出 | 生成画布对象、导出文件、两者 | 生成画布对象 |

### 6.2 高级参数

- 聚类：自动、颜色、watershed、黑白。
- 层级：stacked、cutout。
- 曲线：spline、polygon、pixel。
- 小碎片阈值。
- 简化容差。
- 最大对象数。
- 最大锚点数。
- 固定调色板。
- 色差阈值。
- 几何图元识别强度。
- 是否启用 StarVector Logo 候选。
- 是否启用可微精修。
- 文字识别置信度阈值。
- 是否将文字转曲。
- 是否保留透明通道。
- 导出色彩模式。

### 6.3 预览

必须提供：

- 原图与矢量结果滑动对比。
- 轮廓视图。
- 填色视图。
- 锚点视图。
- 图层视图。
- 透明背景视图。
- 误差热力图，可放在高级模式。

调整颜色、细节、平滑或节点优化时，尽量复用已完成的分割缓存，不应每次从头运行所有算法。

## 7. 总体算法架构

```text
输入与资产血缘解析
  -> 原图结构源/vectorGuide双源准备
  -> 轻量内容分析
  -> 文字、二维码、主体和几何区域检测
  -> 按内容类型拆分组件
  -> 每个组件生成一个或多个矢量候选
  -> 重新渲染候选并评分
  -> 按组件选择最佳候选
  -> 对象级组装和图层排序
  -> 共享边界与曲线简化
  -> 文字、二维码和图元重建
  -> SVG 安全清洗与内部文档转换
  -> 视觉与拓扑验证
  -> 写入 MOMO 矢量资产
  -> 可选多格式导出
```

这里的“多算法融合”是组件级和对象级选择，不是将两个 SVG 的控制点直接平均。

## 8. 输入准备

### 8.1 已经是矢量时

如果输入来源本身是：

- MOMO 矢量图层。
- SVG。
- 可解析的矢量 PDF。
- 原生文字和形状组成的画布对象。

则不应栅格化后重新追踪。应直接导入、规范化和优化现有矢量。

### 8.2 位图预处理

按需执行：

- 去 JPEG 块效应。
- 轻量降噪。
- 白平衡和透明背景整理。
- 2x 边缘增强。
- 颜色空间统一。

不默认执行：

- 强生成式超分。
- 多次锐化。
- 人脸生成式重建。
- 大幅纹理增强。

### 8.3 双源结构

```ts
interface VectorizationSources {
  structureSourceAssetId: string;
  vectorGuideAssetId?: string;
  originalAssetId: string;
  enhancedAssetId?: string;
  analysisMapAssetId?: string;
  alphaMaskAssetId?: string;
}
```

结构源决定：

- 颜色。
- 图层关系。
- 区域连通性。
- 大轮廓。

`vectorGuide`只辅助：

- 边缘亚像素定位。
- 小圆角识别。
- 线条方向。
- 局部控制点微调。

### 8.4 矢量引导资产适配

矢量节点读取 `MomoVectorGuideMetadata`，但不直接依赖高清节点内部模型。适配过程：

```text
验证schema和资产血缘
  -> 验证正反坐标变换
  -> 验证尺寸、Alpha和处理声明
  -> 映射为内部边缘参考
  -> 只参与边缘定位和候选评分
```

禁止：

- 使用 `vectorGuide` 覆盖结构源颜色。
- 使用 `vectorGuide` 改变区域连通关系或洞结构。
- 在 `vectorGuide` 上直接进行全图VTracer并跳过原图验证。
- 因引导图更锐利而无条件增加路径或锚点。
- 从最终4K/8K/16K锐化图伪造 `vectorGuide`。

缺少上游 `vectorGuide` 时，矢量节点可从结构源按相同上限生成任务级临时引导图。临时图只进入任务缓存，不写回高清节点，也不改变节点依赖关系。

### 8.5 高清分析资产适配

矢量节点只依赖一个稳定的共享契约，不直接依赖高清节点内部的模型或实现。适配器读取 `MomoEnhanceAnalysisMap` 后转换为矢量节点自己的分析先验：

```ts
interface VectorizationAnalysisPrior {
  sourceAssetId: string;
  sourceToAnalysis: Matrix3x3;
  textMaskAssetId?: string;
  logoMaskAssetId?: string;
  geometryMaskAssetId?: string;
  flatColorMaskAssetId?: string;
  illustrationMaskAssetId?: string;
  portraitMaskAssetId?: string;
  edgeMaskAssetId?: string;
  degradation?: {
    jpegScore: number;
    noiseScore: number;
    blurScore: number;
    ringingScore: number;
  };
}
```

复用规则：

- 文字掩膜用于保护文字、触发 OCR 或原生文字恢复。
- 几何和色块掩膜提高图元拟合、调色板量化和共享边界候选的优先级。
- 插画掩膜进入 VTracer cutout/watershed 路径。
- 人像掩膜只用于主体分层，不代表适合完整矢量化。
- 边缘掩膜只帮助定位，不能覆盖结构源的颜色、连通性和拓扑。
- 用户提供的 `mask` 优先级高于自动分析掩膜。

## 9. 内容分析与路由

分析输出：

```ts
interface VectorizationAnalysis {
  contentType:
    | "logo"
    | "frame"
    | "flat-illustration"
    | "portrait-illustration"
    | "line-art"
    | "photo"
    | "mixed";
  confidence: number;
  estimatedColorCount: number;
  edgeDensity: number;
  gradientRatio: number;
  textRegions: Region[];
  qrRegions: Region[];
  foregroundRegions: Region[];
  geometryRegions: Region[];
  warnings: string[];
}
```

路由规则：

| 内容 | 默认核心 |
|---|---|
| 单色 Logo、印章、剪影 | 二值化候选 + Potrace/VTracer BW + 图元识别 |
| 彩色 Logo | 调色板量化 + VTracer cutout + 图元识别 + 可选 StarVector |
| 打卡框 | 线条/矩形/圆角检测 + 装饰元素 VTracer |
| 扁平插画 | 颜色量化 + VTracer cutout/watershed |
| AI 卡通头像 | 主体分割 + 颜色量化 + VTracer cutout |
| 线稿 | 自适应阈值 + Potrace/VTracer BW |
| 写实人物 | 风格化调色板 + 主体分割，或保留照片 |
| 混合海报 | 文字、照片、图形分层处理 |

## 10. 矢量候选生成

### 10.1 VTracer 候选

VTracer 是默认生产路径。

推荐初始配置：

| 模式 | preset | clustering | hierarchical | mode | maxColors | simplify |
|---|---|---|---|---|---:|---:|
| Logo单色 | bw | bw | stacked | spline | 2 | 1.0 |
| Logo彩色 | poster | color-cluster | cutout | spline | 8 | 1.0 |
| 打卡框 | poster | color-cluster | cutout | spline | 8 至 16 | 1.0 |
| 扁平插画 | poster | watershed | cutout | spline | 16 至 32 | 1.5 |
| AI头像 | poster | watershed | cutout | spline | 16 至 32 | 1.5 至 2.0 |
| 少节点 | poster | watershed | cutout | spline | 8 至 16 | 2.0 至 2.5 |
| 高保真 | photo | watershed | stacked | spline | 32 至 64 | 0.75 至 1.25 |

数值是初始建议，必须通过 MOMO 固定测试集调优。

### 10.2 黑白候选

对单色图形生成多个二值候选：

- Otsu 阈值。
- 自适应阈值。
- 基于 Alpha 的阈值。
- 用户指定阈值。

每个候选运行 Potrace 或 VTracer BW，再通过重新渲染评分选择。

[Potrace](https://potrace.sourceforge.net/)适合将二值位图转换为平滑曲线，但不直接承担彩色分层。

### 10.3 几何图元候选

使用 OpenCV 或等价实现检测：

- 直线。
- 平行线。
- 矩形。
- 圆角矩形。
- 圆和椭圆。
- 规则多边形。
- 对称结构。

候选应拟合为真正的：

```text
rect
roundedRect
circle
ellipse
line
polygon
```

而不是将所有对象都保存为高节点数的 path。

几何候选只有在重新渲染误差小于阈值时才能替换追踪路径。

### 10.4 StarVector 候选

只在以下类型中启用：

- Logo。
- 图标。
- 字形。
- 技术示意图。
- 图表。

优先使用 1B 模型。8B 模型不作为 12GB 至 16GB 显存设备的默认常驻模型。

输出处理：

1. 限制最大生成长度。
2. 解析 SVG。
3. 只保留允许的元素和属性。
4. 移除脚本、事件和外部引用。
5. 检查视口和坐标范围。
6. 重新渲染。
7. 与其他候选共同评分。

StarVector 不用于自然照片和普通插画候选。

### 10.5 可微精修候选

[diffvg](https://github.com/BachiLi/diffvg)提供可微 2D 矢量栅格化，可用于优化控制点、颜色和透明度。

MOMO 中的定位：

- 只用于高保真或专业模式。
- 从 VTracer 或几何结果初始化。
- 只精修选定组件。
- 设置最大迭代数和时间预算。
- 加入节点数量与曲率正则。
- 不从随机数百条路径开始重建整张复杂海报。

可微优化不能无条件增加路径数量。

## 11. 文字、Logo字形和二维码

### 11.1 MOMO 原生文字

如果资产血缘能够定位到 MOMO 原生文字图层：

- 直接复用文字内容、字体、字号、字距和变换。
- 不做 OCR。
- 不追踪文字轮廓，除非用户选择“文字转曲”。

### 11.2 扁平位图文字

使用本地 OCR 检测和识别。[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)提供移动端和服务端模型以及本地模型路径配置。

处理规则：

- 检测与识别分开。
- 默认只检测并保护文字区域。
- OCR 识别结果必须带置信度。
- 中文内容、字体和排版变化时必须要求用户确认。
- 不根据低置信度结果静默替换原文。
- 找不到原字体时显示候选字体，不自动假装一致。

### 11.3 Logo字形

Logo 中的定制字形通常不是普通字体：

- 默认作为图形轮廓追踪。
- OCR 只用于提示可能的文字内容。
- 不自动替换为系统字体。

### 11.4 二维码

- 检测并解码。
- 解码成功后重新生成标准矢量二维码。
- 解码失败时保留原区域并警告。
- 不使用超分或轮廓追踪伪造二维码模块。

## 12. 多候选评分与融合

### 12.1 重新渲染

所有候选必须通过同一个受控矢量渲染器，在至少两个分辨率重新渲染：

- 预览分辨率。
- 目标验证分辨率。

不能只比较 SVG 文本长度或路径数量。

### 12.2 评分维度

建议初始评分：

```text
score =
  0.28 * silhouetteScore
+ 0.22 * edgeScore
+ 0.18 * colorScore
+ 0.12 * structureScore
+ 0.10 * topologyScore
+ 0.10 * editabilityScore
- complexityPenalty
```

其中：

- `silhouetteScore`：主体轮廓一致性。
- `edgeScore`：边缘距离或边缘重合。
- `colorScore`：Lab/OKLab 色差。
- `structureScore`：主要组件位置和尺寸。
- `topologyScore`：洞、闭合区域、共享边界和层次。
- `editabilityScore`：图元、分组、文字和节点经济性。
- `complexityPenalty`：路径、锚点、小碎片、自相交和文件大小惩罚。

权重必须通过测试集调优，不应作为不可修改常量散落在代码中。

### 12.3 对象级选择

正确方式：

```text
圆形组件 -> 选择圆形拟合候选
大色块 -> 选择 VTracer 候选
图标组件 -> 比较 VTracer 与 StarVector
自由曲线 -> 选择 VTracer，再可选 diffvg 精修
文字 -> 选择 MOMO 文字或 OCR 结果
二维码 -> 选择重新生成结果
```

禁止：

- 将两个 SVG 的控制点逐点平均。
- 将两个候选全图透明叠加后称为融合。
- 把评分较差的候选细节无条件复制到最佳候选。

## 13. 节点与曲线优化

执行顺序：

1. 删除小于阈值的孤立色块。
2. 合并色差小且相邻的区域。
3. 将近似几何路径替换为原生图元。
4. 建立共享边界。
5. 轮廓简化。
6. 二次或三次 Bezier 重拟合。
7. 合并同色、同层且相邻的路径。
8. 修复方向、洞和填充规则。
9. 检查自相交。
10. 重新渲染并比较误差。
11. 在误差预算内继续减少节点。
12. 运行 SVG 结构优化。

### 13.1 简化误差必须使用源坐标

简化容差应相对于输入结构源坐标，而不是最终 16K 输出坐标。否则同一个图在不同导出尺寸下会得到不同的路径结构。

### 13.2 节点预算

提供软预算，不直接硬截断：

| 模式 | 路径数量软预算 | 锚点软预算 |
|---|---:|---:|
| Logo | 128 | 1,500 |
| 打卡框 | 256 | 3,000 |
| 少节点插画 | 512 | 8,000 |
| 标准插画 | 1,500 | 25,000 |
| 高保真 | 5,000 | 100,000 |

超过预算时：

- 提高简化容差。
- 合并相近颜色。
- 删除低贡献碎片。
- 显示复杂度警告。

不能为了满足预算破坏主要轮廓或文字。

## 14. MOMO 内部矢量文档

矢量算法不得直接把任意 SVG 字符串作为最终画布状态。必须解析并转换为受控的内部中间表示。

```ts
interface MomoVectorDocument {
  schemaVersion: 1;
  documentId: string;
  width: number;
  height: number;
  unit: "px" | "mm" | "pt";
  colorMode: "rgb" | "cmyk";
  colorProfile?: VectorColorProfile;
  artboards: VectorArtboard[];
  layers: VectorLayer[];
  resources: VectorResources;
  metadata: VectorDocumentMetadata;
}

interface VectorLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  children: VectorElement[];
}

type VectorElement =
  | VectorPath
  | VectorRectangle
  | VectorEllipse
  | VectorLine
  | VectorPolygon
  | VectorText
  | VectorGroup
  | VectorImage
  | VectorClipGroup;
```

每个元素至少包含：

- 稳定 ID。
- 名称。
- 变换矩阵。
- 填充和描边。
- 透明度。
- 可见状态。
- 包围盒。
- 来源组件 ID。
- 来源算法。
- 质量分数。

`MomoVectorDocument` 是唯一权威母版，必须作为项目资产持久化。规范化 SVG 是开放交换和恢复快照；AI、CDR、EPS、PDF 都是派生交付格式。

SVG 本身不应承担 MOMO 的全部印刷语义。以下信息必须优先保存在内部文档中：

- CMYK 数值。
- 专色名称和替代色。
- ICC 配置引用。
- 可编辑文字和字体匹配状态。
- 对象来源算法和质量分数。
- MOMO 特有的节点参数与资产血缘。

## 15. 节点配置结构

根据 MOMO 现有类型系统调整，不重复定义已有类型。

```ts
type VectorizationPreset =
  | "fast"
  | "balanced"
  | "high-fidelity"
  | "few-nodes";

type VectorizationContentMode =
  | "auto"
  | "logo"
  | "frame"
  | "flat-illustration"
  | "portrait-illustration"
  | "line-art"
  | "photo";

interface MomoVectorizeNodeConfig {
  schemaVersion: 1;
  preset: VectorizationPreset;
  contentMode: VectorizationContentMode;
  colors: "auto" | 2 | 4 | 8 | 16 | 24 | 32 | 64;
  detail: number;
  smoothing: number;
  nodeOptimization: number;
  background: "auto" | "remove" | "keep" | "transparent";
  textMode: "protect" | "ocr" | "outline" | "ignore";
  paletteAssetId?: string;
  geometryDetection: "auto" | "on" | "off";
  semanticCandidate: "auto" | "on" | "off";
  differentiableRefine: "auto" | "on" | "off";
  limits: {
    maxPaths?: number;
    maxAnchors?: number;
    maxSeconds?: number;
  };
  export?: VectorExportConfig;
}
```

## 16. 缓存和任务

复用 `MOMO_SUPER_RESOLUTION_IMPLEMENTATION.md` 中的任务、Worker、取消、进度、临时文件和内容哈希设计。

建议阶段：

```text
ANALYZE_INPUT
PREPARE_SOURCES
DETECT_CONTENT
SEGMENT_COMPONENTS
GENERATE_CANDIDATES
SCORE_CANDIDATES
ASSEMBLE_DOCUMENT
SIMPLIFY_PATHS
VALIDATE_VECTOR
WRITE_ASSET
EXPORT_FORMAT
COMPLETE
```

缓存层级：

- 输入分析缓存。
- OCR 和分割缓存。
- VTracer 分割缓存。
- 单组件候选缓存。
- 候选重新渲染缓存。
- 最终矢量文档缓存。
- 各格式导出缓存。

修改导出格式不应重新运行矢量化。

缓存键至少包含：

```text
inputAssetHash
originalAssetHash
vectorGuideHashOrNone
vectorGuideSchemaVersion
analysisMapHashOrNone
analysisMapSchemaVersion
normalizedVectorizationConfig
algorithmVersions
modelIdsAndHashes
paletteHash
engineVersion
```

## 17. 性能与显存

### 17.1 默认路径

VTracer、颜色量化、轮廓分析、几何拟合和 SVG 优化主要使用 CPU。12GB 至 16GB 显存不是默认路径的硬要求。

GPU 只在以下阶段按需使用：

- 可选分割模型。
- 可选 StarVector-1B。
- 可选 diffvg 精修。
- 可选轻量边缘增强。

### 17.2 模型生命周期

- GPU 模型按阶段串行加载。
- 不同时常驻超分、SAM、StarVector 和 diffvg。
- 优先复用 MOMO 已经加载的 OCR 或分割会话。
- StarVector 只在符合内容类型时加载。
- 模型用完后按内存策略释放。
- 所有模型运行在 Worker，不能阻塞画布 UI。

### 17.3 目标耗时

目标是工程验收范围，不是固定承诺：

| 输入 | 极速 | 标准 | 高保真 |
|---|---:|---:|---:|
| 简单 Logo | 0.2 至 2 秒 | 1 至 4 秒 | 3 至 15 秒 |
| 打卡框 | 0.5 至 3 秒 | 2 至 8 秒 | 5 至 30 秒 |
| 扁平插画 | 1 至 5 秒 | 3 至 15 秒 | 10 至 60 秒 |
| AI 卡通头像 | 2 至 8 秒 | 5 至 25 秒 | 20 秒至 2 分钟 |
| 写实矢量肖像 | 3 至 15 秒 | 10 至 45 秒 | 30 秒至数分钟 |

必须记录实际：

- 输入尺寸。
- 组件数。
- 颜色数。
- 路径数。
- 锚点数。
- 分割耗时。
- 候选生成耗时。
- 精修耗时。
- 导出耗时。
- 峰值显存和内存。

## 18. SVG 安全与规范化

所有外部或模型生成 SVG 都按不可信输入处理。

允许列表建议：

```text
svg
g
path
rect
circle
ellipse
line
polyline
polygon
text
tspan
defs
linearGradient
radialGradient
stop
clipPath
mask
image
```

默认移除：

- `script`。
- `foreignObject`。
- `iframe`。
- 所有 `on*` 事件属性。
- 外部网络 URL。
- JavaScript URL。
- 未授权本地文件引用。
- 未知命名空间对象。
- 递归引用。
- 超出限制的数据 URI。

解析器必须设置：

- 最大 XML 大小。
- 最大元素数。
- 最大嵌套深度。
- 最大路径命令数。
- 禁止外部实体。
- 禁止 DTD。

规范化后再转换为 `MomoVectorDocument`。

## 19. 导出架构

矢量化节点输出内部文档。导出是同一节点可调用的独立服务：

```text
MomoVectorDocument
  -> ExportPreflight
  -> Normalized SVG
  -> SvgExporter
  -> PdfExporter
  -> EpsExporter
  -> IllustratorExporter
  -> CorelDrawExporter
```

接口：

```ts
interface VectorExporter {
  readonly format: VectorExportFormat;
  probe(): Promise<VectorExporterCapability>;
  preflight(
    document: MomoVectorDocument,
    options: VectorExportConfig
  ): Promise<VectorExportPreflight>;
  export(
    document: MomoVectorDocument,
    destination: string,
    options: VectorExportConfig,
    signal: AbortSignal
  ): Promise<VectorExportResult>;
}

type VectorExportFormat = "svg" | "pdf" | "eps" | "ai" | "cdr";
```

### 19.1 导出能力状态

```ts
interface VectorExporterCapability {
  available: boolean;
  mode: "native" | "standalone" | "host-application" | "unavailable";
  provider?: string;
  providerVersion?: string;
  limitations: string[];
}
```

UI 示例：

| 格式 | 状态 |
|---|---|
| SVG | 可用 |
| PDF | 可用 |
| EPS | 可用，透明效果可能展开 |
| AI | 已连接 Illustrator |
| CDR | 需要安装或启动 CorelDRAW |

## 20. 导出前检查

每次导出先生成报告：

- 页面和画板尺寸。
- 单位。
- RGB/CMYK。
- ICC 配置。
- 字体是否缺失。
- 字体是否允许嵌入。
- 是否存在位图。
- 是否存在透明度。
- 是否存在蒙版。
- 是否存在不支持的渐变。
- 是否存在混合模式。
- 是否存在过多路径或锚点。
- 是否需要文字转曲。
- 是否需要描边展开。
- 是否需要透明度扁平化。

用户可以选择：

```text
最大可编辑性
最大兼容性
印刷输出
```

## 21. SVG 导出

SVG 是 MOMO 的默认交换格式。

要求：

- 输出规范化 SVG。
- 保留 `viewBox`。
- 保留图层和组名称。
- 保留对象 ID。
- 保留可编辑文字或按用户选择转曲。
- 支持嵌入位图，但报告必须说明并非全矢量。
- 外部资源默认嵌入或打包，不留下失效路径。
- 导出后重新解析并渲染验证。

最后可运行 [SVGO](https://github.com/svg/svgo)或等价 AST 优化，但必须：

- 保留 `viewBox`。
- 保留 MOMO 所需 ID 和图层信息。
- 不使用会改变视觉结果的激进插件。
- 对优化前后结果重新渲染比较。

## 22. PDF 导出

PDF 应支持：

- 矢量路径。
- 文字嵌入或转曲。
- 图层，后端支持时。
- 透明度。
- 剪切路径。
- RGB 与 CMYK 工作流。
- ICC 输出意图，后端支持时。

默认优先现代 PDF，而不是 EPS。

文化墙印刷可提供 PDF/X 预设，但只有在导出库真正支持：

- PDF/X 元数据。
- 输出意图。
- ICC 配置。
- 字体规则。
- 透明度规则。

并通过预检后才能标记为 PDF/X。不得只修改文件名或元数据冒充 PDF/X。

[Adobe PDF/X 说明](https://helpx.adobe.com/illustrator/using/creating-pdf-files.html)推荐 PDF/X-4 用于保留透明度的现代印刷工作流。

## 23. EPS 导出

独立导出路径可以使用：

- 已有成熟 EPS/PostScript 导出库。
- 或经过版本固定和打包验证的 [Inkscape CLI](https://wiki.inkscape.org/wiki/Using_the_Command_Line)。

Inkscape CLI 支持通过扩展名或 `--export-type=eps` 导出 EPS。

EPS 导出副本必须执行兼容降级：

1. 复制内部文档。
2. 按用户设置将文字转曲。
3. 展开不兼容描边。
4. 处理透明度。
5. 将不支持效果转为高分辨率局部位图。
6. 保留普通路径、填充和基础渐变。
7. 导出 EPS。
8. 重新打开或渲染验证。

必须显示：

```text
EPS 是兼容交付格式，部分透明效果可能被展开或栅格化。
```

## 24. 原生 AI 导出

### 24.1 可用条件

只有在检测到可自动化的 Adobe Illustrator 时启用“原生 AI”。

Adobe 官方说明 Illustrator 支持 Visual Basic、AppleScript、JavaScript 和 ExtendScript 自动化。[Illustrator脚本说明](https://helpx.adobe.com/ca/illustrator/desktop/automate-visualize-data/automate-actions/install-and-run-scripts.html)

### 24.2 推荐流程

首版：

```text
MomoVectorDocument
  -> 规范化 SVG
  -> 独立 HostApplication Worker
  -> Illustrator 打开 SVG
  -> 设置画板、颜色和图层
  -> Document.saveAs()
  -> IllustratorSaveOptions(pdfCompatible=true)
  -> 保存 .ai
  -> 关闭临时文档
  -> 校验文件
```

后续如 SVG 导入不能完整恢复图层，可改为：

- 通过脚本逐层创建 Illustrator 对象。
- 或生成结构化 PDF 后再补充图层。

### 24.3 要求

- 不在 MOMO UI 主进程内控制 Illustrator。
- 设置启动、打开、保存和关闭超时。
- 检测并处理应用对话框。
- 用户已有 Illustrator 文档不得被关闭或修改。
- 使用唯一临时目录和唯一文档名。
- 保存后检查文件存在且非零。
- 可选执行重新打开验证。
- 出错时保留 `MomoVectorDocument` 母版和规范化 SVG 快照。

### 24.4 无 Illustrator

显示：

```text
原生 AI 导出需要本机安装 Adobe Illustrator。
可改用 SVG、PDF 或 EPS，这些格式可以被 Illustrator 打开。
```

不要生成扩展名为 `.ai` 的普通 PDF。

## 25. 原生 CDR 导出

### 25.1 可用条件

只有在检测到可自动化的 CorelDRAW 时启用“原生 CDR”。

CorelDRAW 官方接口支持：

- `Layer.Import` 或 `ImportEx` 导入支持的非原生文件。
- `Document.SaveAs` 使用 `cdrCDR` 保存原生 CDR。
- `StructImportOptions.MaintainLayers` 等导入选项。

### 25.2 推荐流程

```text
MomoVectorDocument
  -> 规范化 SVG
  -> 独立 HostApplication Worker
  -> 启动或连接 CorelDRAW
  -> 创建空白文档
  -> 设置页面尺寸和单位
  -> 按层导入 SVG 或分层 SVG
  -> 恢复图层名称和顺序
  -> Document.SaveAs(..., cdrCDR)
  -> 关闭临时文档
  -> 校验 CDR
```

为了提高图层保真，可以：

- 每个 MOMO 顶层图层导出一个临时 SVG。
- CorelDRAW 中创建对应图层。
- 将临时 SVG 导入指定图层。
- 最后保存一个 CDR。

### 25.3 要求

- 自动检测 CorelDRAW 版本和可用 COM/VGCore 接口。
- 不写死一个 ProgID。
- 不接管用户当前活动文档。
- 不关闭用户已经打开的 CorelDRAW 实例。
- 独立 Worker 设置超时和看门狗。
- 处理首次启动、许可、字体和导入对话框。
- CorelDRAW 启动阻塞时允许用户取消。
- 保存后检查文件并可选重新打开验证。

### 25.4 无 CorelDRAW

显示：

```text
原生 CDR 导出需要本机安装 CorelDRAW。
建议导出 SVG 或 PDF；CorelDRAW 可以导入这些格式继续编辑。
```

## 26. 导出配置

```ts
interface VectorExportConfig {
  format: "svg" | "pdf" | "eps" | "ai" | "cdr";
  destination?: string;
  compatibility: "editability" | "maximum" | "print";
  text: "editable" | "outline";
  embedImages: boolean;
  embedFonts: boolean;
  colorMode: "document" | "rgb" | "cmyk";
  colorProfileId?: string;
  preserveLayers: boolean;
  flattenTransparency: "auto" | "never" | "always";
  rasterFallbackDpi: number;
}
```

建议默认值：

| 格式 | 文字 | 图层 | 透明度 | 位图回退 |
|---|---|---|---|---|
| SVG | 可编辑 | 保留组 | 保留 | 嵌入 |
| PDF | 嵌入字体 | 尽量保留 | 保留 | 300 DPI |
| EPS | 转曲或询问 | 有限 | 展开 | 300 DPI |
| AI | 可编辑 | 保留 | 保留 | 嵌入 |
| CDR | 可编辑 | 保留 | 尽量保留 | 嵌入 |

## 27. 导出结果验证

### 27.1 通用验证

- 文件存在。
- 文件大小合理。
- 文件头与格式一致。
- 可以重新解析或重新打开。
- 页面尺寸正确。
- 图层数量在合理范围。
- 文字策略符合配置。
- 外部资源没有丢失。
- 重新渲染与 MOMO 母版相似。

### 27.2 禁止仅检查扩展名

必须检查真实格式。示例：

- `.pdf` 应有 PDF 文件头。
- `.eps` 应有 PostScript/EPS 文件头。
- `.ai` 必须由 Illustrator 成功保存并通过验证。
- `.cdr` 必须由 CorelDRAW 成功保存并通过验证。

### 27.3 往返测试

测试环境具备对应软件时执行：

```text
MOMO -> AI -> Illustrator重新打开 -> 导出PNG -> 与基准比较
MOMO -> CDR -> CorelDRAW重新打开 -> 导出PNG -> 与基准比较
MOMO -> EPS -> Inkscape/Illustrator重新打开 -> 与基准比较
```

往返测试同时统计：

- 图层保留率。
- 文字可编辑率。
- 路径数量变化。
- 颜色差异。
- 页面尺寸差异。
- 视觉差异。

## 28. 质量报告

```ts
interface VectorizationQualityReport {
  classification: VectorizationContentMode;
  classificationConfidence: number;
  sourceUsage: {
    structureSourceAssetId: string;
    vectorGuideAssetId?: string;
    analysisMapAssetId?: string;
    usedVectorGuide: boolean;
    usedAnalysisMap: boolean;
    fallbackReasons: string[];
  };
  pathCount: number;
  anchorCount: number;
  layerCount: number;
  editableTextCount: number;
  outlinedTextCount: number;
  embeddedRasterCount: number;
  selfIntersectionCount: number;
  tinyFragmentCount: number;
  visualScores: {
    silhouette: number;
    edge: number;
    color: number;
    topology: number;
    total: number;
  };
  warnings: VectorizationWarning[];
  exportCompatibility: Record<VectorExportFormat, CompatibilityReport>;
}
```

用户友好状态：

```text
可直接使用
建议检查文字
建议检查复杂边缘
包含位图
节点较多
不适合完整矢量化
```

“可直接使用”必须由质量阈值、结构检查和内容类型共同决定，不能仅由算法运行成功决定。

## 29. 错误码

```text
VECTOR_INPUT_UNSUPPORTED
VECTOR_SOURCE_LINEAGE_MISSING
VECTOR_ANALYSIS_FAILED
VECTOR_SEGMENTATION_FAILED
VECTOR_TRACE_FAILED
VECTOR_SVG_INVALID
VECTOR_SVG_UNSAFE
VECTOR_TOO_COMPLEX
VECTOR_OCR_LOW_CONFIDENCE
VECTOR_QR_DECODE_FAILED
VECTOR_CANCELLED
VECTOR_WORKER_CRASHED
VECTOR_EXPORT_UNSUPPORTED
VECTOR_EXPORT_HOST_MISSING
VECTOR_EXPORT_HOST_TIMEOUT
VECTOR_EXPORT_DIALOG_BLOCKED
VECTOR_EXPORT_WRITE_FAILED
VECTOR_EXPORT_VALIDATION_FAILED
```

错误必须带恢复建议。

## 30. 测试集

固定测试集至少包括：

- 单色圆形 Logo。
- 有洞和负形的 Logo。
- 彩色渐变 Logo。
- 中文定制字形 Logo。
- 红色党建打卡框。
- 金色圆角文化墙边框。
- 多层扁平插画。
- AI 卡通头像。
- 写实 AI 头像。
- 透明 PNG。
- JPEG 压缩网图。
- 黑白扫描线稿。
- 带阴影和透明度的图形。
- 中文小字海报。
- 二维码。
- 已经是 SVG 的输入。

每个样本保存：

- 原图。
- 结构源。
- 边缘源。
- 候选结果。
- 最终 SVG。
- 节点和路径统计。
- 质量报告。
- 标准和少节点模式结果。
- 格式往返截图。

## 31. 单元测试

- 内容类型路由。
- 调色板量化。
- 二值候选选择。
- 几何图元拟合。
- 简化容差。
- 共享边界。
- 洞和填充规则。
- 自相交检测。
- 候选评分。
- 对象级候选选择。
- SVG 安全清洗。
- SVG 到内部文档转换。
- 内部文档序列化。
- 缓存键。
- `vectorGuide`元数据校验与坐标往返。
- 配置迁移。
- 导出能力探测。
- 格式文件头检查。
- HostApplication Worker 超时。

## 32. 集成测试

- 创建矢量化节点。
- 快捷入口自动创建节点。
- 高清增强结果能够回溯原图。
- 兼容的 `vectorGuide` 能被复用并准确映射回源坐标。
- `vectorGuide` 缺失、损坏、过期或版本不兼容时自动回退到结构源边缘。
- `vectorGuide` 不能覆盖结构源的颜色、拓扑和连通关系。
- 使用 `vectorGuide` 后固定测试集的边缘误差改善，路径和锚点数量不异常增加。
- 兼容的 `analysisMap` 能被复用且源坐标映射正确。
- `analysisMap` 缺失、损坏、过期或版本不兼容时自动回退到本地分析。
- 最终 CAS/USM 锐化图不会成为唯一结构源。
- 高清节点与矢量节点能够分别单独运行、缓存和取消。
- 矢量结果作为画布对象可编辑。
- 撤销和重做。
- 保存项目并重新打开。
- 修改导出格式不重新矢量化。
- Worker 崩溃不影响画布主进程。
- OCR 低置信度要求确认。
- StarVector 不对自然照片自动启用。
- 没有 Illustrator 时禁用原生 AI。
- 没有 CorelDRAW 时禁用原生 CDR。
- EPS 透明度预检。
- AI 和 CDR 自动化超时能够取消。

## 33. 视觉验收

重点检查：

- 外轮廓是否准确。
- 负形和洞是否正确。
- 共享边界是否有缝。
- 圆和直线是否平滑。
- 圆角是否稳定。
- 小碎片是否过多。
- 锚点是否集中在真实拐点。
- 中文文字是否被错误替换。
- Logo 定制字形是否被系统字体替换。
- 透明区域是否正确。
- 渐变是否发生明显色带。
- 图层顺序是否正确。
- AI/CDR往返后是否丢层。

## 34. 分阶段实施

### 阶段一：VTracer 单核心闭环

- 读取仓库并输出接入分析。
- 建立 `MomoVectorizeEngine` 接口。
- 建立节点和快捷入口。
- 接入 VTracer 固定版本。
- 实现 poster、bw、cutout、颜色和简化参数。
- 解析 SVG 为内部矢量文档。
- 生成可编辑画布对象。
- 实现预览、进度、取消和缓存。
- 独立导出 SVG。
- 完成单元测试和视觉基准。

### 阶段二：多算法与节点优化

- 加入原图结构源/`vectorGuide`双源。
- 加入`MomoVectorGuideMetadata`适配器、校验、坐标映射、临时回退和缓存。
- 加入 `MomoEnhanceAnalysisMap` 适配器、校验、坐标映射和回退。
- 加入内容分析和路由。
- 加入多个二值候选。
- 加入几何图元识别。
- 加入对象级候选评分。
- 加入 OCR 文字保护和二维码重建。
- 加入节点预算和复杂度报告。
- 加入 PDF 和 EPS 导出。

### 阶段三：专业候选与原生格式

- Logo/图标可选 StarVector-1B。
- 可选分割模型。
- 局部 diffvg 精修。
- Illustrator HostApplication Worker。
- CorelDRAW HostApplication Worker。
- 原生 AI 和 CDR 往返验证。
- 印刷预检和高级颜色管理。

## 35. GLM 第一轮指令

```text
请阅读 MOMO 项目源码、
MOMO_SUPER_RESOLUTION_IMPLEMENTATION.md 和
MOMO_IMAGE_VECTORIZATION_IMPLEMENTATION.md。

先不要修改代码。

请完成：
1. 识别 MOMO 技术栈和桌面运行环境。
2. 找出节点注册、画布矢量对象、资产血缘、Worker、任务、缓存、撤销重做和持久化实现。
3. 找出现有 SVG、PDF 和图片导入导出能力。
4. 判断 VTracer 应使用 Rust 原生库、CLI、Python绑定还是 Node.js/WASM。
5. 判断内部画布数据是否已经能够表示路径、图元、文字、组、图层、渐变和剪切蒙版。
6. 判断超清增强结果如何回溯原始资产，并核对 MomoVectorGuideMetadata 与 MomoEnhanceAnalysisMap 的接口、坐标系和缓存版本。
7. 设计 vectorGuide 缺失、损坏、过期或版本不兼容时的结构源边缘回退。
8. 设计 analysisMap 缺失、损坏、过期或版本不兼容时的独立分析回退。
9. 列出阶段一需要修改和新增的文件。
10. 给出风险、依赖、测试和分阶段计划。
11. 不要假设当前存在 Illustrator 或 CorelDRAW。
12. 明确哪些功能可以独立实现，哪些需要宿主软件。
```

## 36. GLM 阶段一实施指令

```text
按照确认后的计划实现图像转矢量阶段一。

要求：
- 复用 MOMO 现有节点、资产、任务、Worker、缓存和撤销重做机制。
- 固定 VTracer 版本或提交哈希。
- 完成位图 -> VTracer -> 安全SVG -> MOMO内部矢量文档 -> 可编辑画布对象的闭环。
- 支持 Logo、海报、黑白和少节点预设。
- 支持预览、进度、取消、错误和缓存。
- 原图不被覆盖。
- 矢量化节点不依赖高清节点也能独立运行。
- 收到 vectorGuide 时完成版本、血缘、引用资产、处理声明和正反坐标变换校验；不可用时回退到结构源边缘并写入报告。
- vectorGuide只参与边缘定位和评分，不能覆盖结构源颜色、拓扑和连通关系。
- 收到 analysisMap 时完成版本、血缘、引用资产和坐标变换校验；不可用时静默回退到本地轻量分析并写入报告。
- 不把最终 CAS/USM 锐化图作为唯一结构源。
- SVG解析采用安全允许列表。
- 相同输入和参数命中缓存。
- 实现SVG导出并重新解析验证。
- 补充单元测试、集成测试和固定视觉样本。
- 运行类型检查、测试和构建。
- 最后列出修改文件、测试结果、已知限制和阶段二接入点。
```

## 37. 阶段一验收标准

- 位图可以从节点或快捷入口转换为矢量。
- 输出是 MOMO 可编辑矢量对象，不只是预览位图。
- 原始资产保持不变。
- 简单 Logo、打卡框和扁平插画能够正常处理。
- 支持颜色数、平滑、细节和节点优化。
- 支持透明背景。
- SVG 不含脚本和外部危险引用。
- 超大输入在后台 Worker 中处理，不会阻塞 UI。
- 用户可以取消任务。
- 保存项目并重开后结果仍有效。
- SVG 导出后可以重新解析和渲染。
- 缺少`vectorGuide`和`analysisMap`时仍能独立完成矢量化。
- 测试、类型检查和构建通过。

## 38. 最终产品定义

用户看到：

```text
MOMO 智能矢量化
```

技术定义：

```text
面向 Logo、打卡框、文化墙元素和扁平插画的
内容感知、多候选、可验证的本地图像转矢量引擎
```

默认标准模式：

```text
原图结构源
  + 可选保结构vectorGuide
  + 可选analysisMap
  -> 内容分析
  -> 文字、二维码和主体检测
  -> VTracer cutout/watershed
  + 几何图元候选
  -> 重新渲染评分
  -> 对象级最佳候选选择
  -> 共享边界和曲线简化
  -> MOMO内部矢量文档
  -> SVG/PDF/EPS
  -> 可选 Illustrator/CorelDRAW 原生导出
```

产品宣传必须区分：

- “全部矢量”。
- “包含嵌入位图”。
- “文字可编辑”。
- “文字已转曲”。
- “原生 AI/CDR”。
- “Illustrator/CorelDRAW兼容格式”。

不得把兼容格式、嵌入位图或改扩展名文件宣传成完整原生矢量文件。

## 39. 主要资料

- VTracer：https://github.com/visioncortex/vtracer
- Potrace：https://potrace.sourceforge.net/
- StarVector：https://github.com/joanrod/star-vector
- SAM 2：https://github.com/facebookresearch/sam2
- diffvg：https://github.com/BachiLi/diffvg
- PaddleOCR：https://github.com/PaddlePaddle/PaddleOCR
- SVGO：https://github.com/svg/svgo
- Inkscape CLI：https://wiki.inkscape.org/wiki/Using_the_Command_Line
- Adobe AI格式：https://www.adobe.com/creativecloud/file-types/image/vector/ai-file.html
- Illustrator脚本保存选项：https://ai-scripting.docsforadobe.dev/jsobjref/IllustratorSaveOptions/
- CorelDRAW Import API：https://community.coreldraw.com/sdk/api/draw/26/m/layer.import?lang=js
- CorelDRAW SaveAs API：https://community.coreldraw.com/sdk/api/draw/26/m/document.saveas?lang=vba
- Adobe EPS透明度说明：https://helpx.adobe.com/illustrator/using/importing-eps-dcs-autocad-files.html
- Adobe PDF/X说明：https://helpx.adobe.com/illustrator/using/creating-pdf-files.html
