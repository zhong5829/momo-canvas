# MOMO 高清增强与内容分区融合实施规格

> 文档用途：指导 GLM 或其他编码代理在现有 MOMO 画布软件中实现本地高清增强节点。
>
> 文档范围：只负责位图修复、4K/8K/16K 放大、内容分区增强、人像保真、文字与色块清晰化以及印刷位图输出。
>
> 关联文档：`MOMO_IMAGE_VECTORIZATION_IMPLEMENTATION.md`
>
> 核验日期：2026-07-31
>
> **落地状态（2026-08-01）**：四档管线（极速 SPAN / 海报·文化墙 NomosESRGAN+Lite / 人像 RealPLKSR+SCRFD+FaceUpDAT / 专业印刷 RealPLKSR+DAT2·16 位）、条件 DeJPG、Session LRU 缓存、OOM Tile 降级、双频段融合 + 人脸掩膜降权 + ROI 羽化贴回均已实现并测试通过（`src-tauri/src/sr.rs`/`face.rs`/`model_cache.rs`，47 项 Rust 测试全绿）。GFPGAN/CodeFormer 为可选模型按需下载。SAM2/SAM2.1 内容分区需 Python/PyTorch 线路，**暂缓**。

## 1. 实施前提

编码代理必须先阅读 MOMO 当前源码，识别并复用：

- 画布节点协议与节点注册。
- 图片、文字、矢量、组和蒙版的数据模型。
- 资产存储、内容哈希和资产血缘。
- 后台任务、Worker、进度、取消和错误系统。
- 撤销、重做和项目持久化。
- 当前 ONNX 模型加载、Tile 和融合实现。
- 当前 `fusion_pipeline_runs_twice` 等测试实际断言内容。
- 当前模型注册表中的模型 ID、架构、倍率、文件哈希和运行后端。

不得只根据测试名称或显示名称推断实际模型。实施前必须确认当前使用的是：

- `4xNomosWebPhoto_RealPLKSR` 还是 ESRGAN 变体。
- 原始 `4x-UltraSharp`、`UltraSharpV2 Lite` 还是完整 `UltraSharpV2 DAT2`。
- 标准和专业档是否真的使用不同权重、不同 ROI 或不同模型。

## 2. 核心结论

### 2.1 两个节点保持独立

MOMO 使用两个独立节点：

```text
MOMO 高清增强
MOMO 智能矢量化
```

高清节点不生成 SVG，矢量化节点不承担 4K/8K/16K 高清模型推理。

两者通过以下数据衔接：

```text
originalAssetId
enhancedAssetId
vectorGuideAssetId
analysisMapAssetId
assetLineage
```

### 2.2 高清节点不是固定双模型

海报和文化墙包含照片、人物、插画、文字、几何边框、平坦色块和渐变。整图统一运行 `NomosWebPhoto + UltraSharp` 不能覆盖这些内容。

正确方案是：

```text
一次内容分析
  -> 按区域选择算法
  -> 一个区域只运行必要的模型
  -> 最后内容感知合成
```

### 2.3 模型数量不是质量指标

“两个模型运行两次”只证明多模型调用，不证明：

- 两个模型不同。
- 两个模型都对最终结果有贡献。
- 遮罩覆盖正常。
- 高频融合没有产生光晕。
- 平坦色块没有被注入噪声。
- 中文笔画没有被改变。

目标是按内容选择正确算法，不是让所有模型都运行。

### 2.4 印刷输出和矢量参考不同

高清节点输出最终印刷位图，同时可输出专用矢量引导图和分析资产供矢量化节点参考：

```text
image：允许受控锐化的最终位图
vectorGuide：最多2x、无最终锐化的保结构矢量引导图
analysisMap：文字、色块、插画、照片、人像、边缘等掩膜
```

`vectorGuide` 只辅助边缘定位；颜色、拓扑、连通关系和大轮廓仍以原图或轻度清理后的结构源为准。矢量化节点不能把最终 CAS/USM 锐化图作为唯一结构源，必须通过资产血缘回溯原图。

## 3. 产品目标

高清节点主要服务于：

- 海报、文化墙、宣传栏和打卡装置。
- 微信、网页和旧素材修复。
- AI 生成插画和头像。
- 人物照片、活动照片和建筑照片。
- 中文标题、标语、Logo和规则边框。
- 4K、8K、16K 位图输出。
- 12GB 至 16GB 显存设备本地运行。

输出应做到：

- 照片自然，不产生过量假纹理。
- 人像默认保持身份，不擅自重建五官。
- 中文文字边缘清楚，内容不被模型篡改。
- 文化墙色块内部干净、边缘明确。
- 插画线条锐利但没有明显白边或双边。
- 标准模式速度足够作为日常默认。
- 专业模式适合最终印刷输出。

## 4. 非目标与诚实边界

首版不承诺：

- 从严重模糊的小图恢复真实不存在的细节。
- 单靠超分模型准确恢复缺失中文笔画。
- 默认使用生成式人脸修复而不改变身份。
- 将任意低清照片无损恢复成真实 16K。
- 让两个或更多全图模型无条件运行。
- 把肉眼锐化等同于真实分辨率提升。

以下情况必须显示警告：

- 人脸小于推荐尺寸。
- OCR 对文字内容置信度低。
- 目标倍率大于 8 倍。
- 输入存在严重运动模糊。
- 用户开启生成式人脸重建。
- 最终结果可能包含 AI 生成细节。

## 5. 产品形态

### 5.1 节点名称

```text
MOMO 高清增强
```

### 5.2 节点端口

```text
输入：
- image：必需，位图或可栅格化画布内容
- mask：可选，用户指定增强区域
- palette：可选，品牌或项目调色板

输出：
- image：最终高清位图资产
- vectorGuide：可选，供矢量节点使用的保结构边缘引导资产
- analysisMap：可选，供下游节点复用的分析资产
- report：处理、质量、性能和警告报告
```

`vectorGuide` 和 `analysisMap` 是中间资产，不应在普通用户界面显示为普通图片或自动插入画布。只有调试模式显示预览。

### 5.3 快捷入口

提供：

```text
右键图片 -> 高清增强
右键图片 -> 高清并矢量化
工具栏 -> 高清增强
```

“高清并矢量化”内部自动创建两个独立节点并连接，不实现第三套算法。

### 5.4 非破坏编辑

- 永远不覆盖原图。
- 输出新资产。
- 保存输入、输出和原图血缘。
- 支持撤销、重做、取消和重新运行。
- 参数变化使对应缓存失效，但不删除仍被引用的旧资产。

## 6. 节点界面

### 6.1 主参数

| 参数 | 选项 | 默认值 |
|---|---|---|
| 目标尺寸 | 4K、8K、16K、自定义、印刷尺寸 | 4K |
| 模式 | 极速、海报/文化墙、人像、专业印刷 | 海报/文化墙 |
| 内容类型 | 自动、照片、插画、海报、人像 | 自动 |
| 文字保护 | 自动、开、关 | 自动 |
| 色块保护 | 自动、开、关 | 自动 |
| 人像保护 | 自动、开、关 | 自动 |
| 细节强度 | 0 至 100 | 45 |
| 锐化强度 | 0 至 100 | 20 |
| 输出格式 | PNG、TIFF、JPEG | PNG |

### 6.2 高级参数

- 推理后端：自动、CUDA、TensorRT、DirectML、NCNN Vulkan。
- 精度：自动、FP16、FP32。
- Tile：自动或固定值。
- Tile 重叠。
- 显存上限。
- 主模型、插画模型和人像模型。
- 细节分支最大 ROI 覆盖率。
- 多频段融合权重。
- 光晕抑制强度。
- OCR 置信度阈值。
- 人脸重建：关闭、保真增强、AI重建。
- 是否保存调试分支图。
- 是否输出 `vectorGuide` 和 `analysisMap`。

普通用户不直接面对模型文件名。

### 6.3 状态

```text
等待输入
分析内容
准备模型
修复压缩
增强照片
增强插画
处理文字和色块
处理人像
融合结果
精确缩放
写入输出
已完成
已取消
显存不足并重试
模型缺失
输入不支持
```

### 6.4 预览

- 参数调整使用最长边 1280 至 2048 的代理图。
- 优先处理当前视口区域。
- 提供原图与结果滑动对比。
- 调试模式显示内容掩膜和各分支结果。
- 预览必须明确标记，不能冒充最终渲染。
- 最终任务在后台运行，用户可以继续编辑画布。

## 7. 数据接口

### 7.1 分析资产

```ts
interface MomoEnhanceAnalysisMap {
  schemaVersion: 1;
  sourceAssetId: string;
  analysisWidth: number;
  analysisHeight: number;
  masks: {
    text?: MaskAssetRef;
    logo?: MaskAssetRef;
    geometry?: MaskAssetRef;
    flatColor?: MaskAssetRef;
    gradient?: MaskAssetRef;
    illustration?: MaskAssetRef;
    photo?: MaskAssetRef;
    portrait?: MaskAssetRef;
    skin?: MaskAssetRef;
    face?: MaskAssetRef;
    edge?: MaskAssetRef;
  };
  degradation: {
    jpegScore: number;
    noiseScore: number;
    blurScore: number;
    ringingScore: number;
  };
  regions: EnhanceRegion[];
  modelSpaceTransform: Matrix3x3;
}
```

要求：

- 掩膜使用统一源坐标。
- 记录分析图到原图的变换。
- 大掩膜可以压缩或分块存储。
- 下游矢量节点可以复用，但不能强依赖其存在。
- 分析算法版本变化时缓存失效。

### 7.2 矢量引导资产

```ts
interface MomoVectorGuideMetadata {
  schemaVersion: 1;
  sourceAssetId: string;
  imageAssetId: string;
  width: number;
  height: number;
  sourceToGuideTransform: Matrix3x3;
  guideToSourceTransform: Matrix3x3;
  processing: {
    scale: number;
    dejpeg: boolean;
    denoiseStrength: number;
    edgePreserving: true;
    finalSharpenApplied: false;
    generativeRestorationApplied: false;
    textureEnhancementApplied: false;
  };
  algorithmVersions: Record<string, string>;
}
```

生成规则：

- 来源是原图经过必要的轻度去压缩、保边降噪和 Alpha 整理后的结构图。
- 默认最多放大 2x，最长边不超过 4096 像素；大于上限时生成受控代理并保存可逆坐标变换。
- 不执行最终 CAS/USM。
- 不执行人脸生成式修复。
- 不注入皮肤、毛发、纸张或插画纹理。
- 不做调色板重映射，不改变区域连通关系。
- 不用 OCR 猜测结果静默替换原始文字笔画。
- 内部使用无损格式并保留 Alpha。
- `sourceToGuideTransform` 与 `guideToSourceTransform` 必须互逆并通过边界检查。
- `emitVectorGuide=auto` 时仅在下游端口连接、快捷功能需要或调试模式启用时生成。
- 生成失败不应阻止最终高清位图输出，但必须在报告中记录并让矢量节点回退。

建议尺寸策略：

```text
sourceLongEdge < 2048:
  guideLongEdge = min(sourceLongEdge * 2, 4096)

2048 <= sourceLongEdge <= 4096:
  guideLongEdge = sourceLongEdge

sourceLongEdge > 4096:
  guideLongEdge = 4096
```

`vectorGuide` 不是第二张最终效果图，也不能被宣传为4K/8K/16K输出。

### 7.3 节点配置

```ts
type EnhancePreset =
  | "fast"
  | "poster"
  | "portrait"
  | "professional";

interface MomoEnhanceNodeConfig {
  schemaVersion: 3;
  preset: EnhancePreset;
  contentMode: "auto" | "photo" | "illustration" | "poster" | "portrait";
  target:
    | { mode: "longEdge"; pixels: number }
    | { mode: "size"; width: number; height: number }
    | { mode: "print"; widthMm: number; heightMm: number; dpi: number };
  textProtection: "auto" | "on" | "off";
  flatColorProtection: "auto" | "on" | "off";
  portraitProtection: "auto" | "on" | "off";
  faceRestoration: "off" | "identity-safe" | "generative";
  detailStrength: number;
  sharpenStrength: number;
  outputFormat: "png" | "tiff" | "jpeg";
  emitVectorGuide: "auto" | "on" | "off";
  emitAnalysisMap: boolean;
  runtime: {
    backend: "auto" | "cuda" | "tensorrt" | "directml" | "ncnn";
    precision: "auto" | "fp16" | "fp32";
    tileSize: "auto" | number;
    tileOverlap: "auto" | number;
    vramLimitMB?: number;
  };
}
```

配置迁移：

- `schemaVersion: 2` 升级到 `3` 时，`emitVectorGuide` 默认写入 `"auto"`。
- 旧项目打开后不得因缺少该字段自动生成额外资产或改变最终 `image`。
- 保存项目时写入新版本，撤销和重做必须保留端口连接与配置值。

## 8. 总体流水线

```text
输入与资产血缘解析
  -> 解码、颜色和 Alpha 预处理
  -> 退化分析
  -> 内容分类与区域掩膜
  -> 按需 1x 去压缩/降噪
  -> 从保结构结果生成可选 vectorGuide
  -> 照片分支
  -> 插画分支
  -> 文字与 Logo 分支
  -> 几何与色块分支
  -> 人像分支
  -> 内容感知多频段融合
  -> 光晕与振铃抑制
  -> 精确缩放到目标尺寸
  -> 轻量输出锐化
  -> 恢复 Alpha 与色彩信息
  -> 写入 image、vectorGuide、analysisMap 和 report
```

不得无条件执行所有阶段。

`vectorGuide` 在最终多频段融合、精确放大和输出锐化之前分叉。禁止从最终 `image` 反向生成 `vectorGuide`。

## 9. 内容分析

分析应先在缩略图上执行，再把区域映射回原图。

至少识别：

- 图片、插画或混合海报。
- 文字区域。
- Logo和二维码区域。
- 规则几何边框。
- 平坦色块。
- 渐变区域。
- 照片区域。
- 人物、人脸和皮肤区域。
- 高纹理区域。
- 平滑区域。

来源优先级：

1. MOMO 原生画布图层与对象类型。
2. 输入文件中的矢量或文字信息。
3. 轻量检测模型。
4. 传统图像分析。

如果输入来自 MOMO 原生文字或矢量对象，不要把这些区域当作普通位图交给超分模型。

## 10. 退化修复分支

按需执行：

- JPEG 去块。
- 轻量降噪。
- 去色带。
- 轻度去模糊。

推荐可选模型：

- [1x-DeJPG RealPLKSR](https://openmodeldb.info/models/1x-DeJPG-realplksr-otf)
- 轻量本地去JPEG模型。

规则：

- 干净 PNG 不运行 DeJPG。
- 平坦色块使用更保守的降噪。
- 小字附近避免强去噪导致笔画粘连。
- 人脸附近避免过度平滑皮肤细节。

## 11. 照片分支

默认照片模型：

- [4x-NomosWebPhoto RealPLKSR](https://openmodeldb.info/models/4x-NomosWebPhoto-RealPLKSR)

该模型明确面向摄影和网页压缩、噪声、镜头模糊等退化，适合：

- 活动照片。
- 建筑照片。
- 网页下载照片。
- 文化墙中的照片区域。

不适合无条件处理：

- 纯色背景。
- 中文文字。
- 规则边框。
- Logo。
- 卡通头像。

标准模式中只对照片区域或主导照片图运行。

## 12. 插画和装饰分支

候选模型：

- 原始 `4x-UltraSharp`，作为兼容备用。
- [UltraSharpV2](https://openmodeldb.info/models/4x-UltraSharpV2) Lite，适合标准模式评估。
- UltraSharpV2 DAT2，适合专业模式评估。

注意：

- 完整 UltraSharpV2 是 DAT2 架构。
- Lite 版本是 RealPLKSR 架构。
- 原始 UltraSharp 是 ESRGAN/RRDBNet 家族。
- 模型注册表必须记录真实架构，不能全部标成 ESRGAN。

插画分支只处理：

- 装饰插画。
- 高纹理图形。
- 建筑线条。
- 卡通内容。
- 用户指定区域。

标准模式不把插画模型跑完整张混合海报。

## 13. 文字和 Logo 分支

### 13.1 原生文字

如果输入来自 MOMO 文字图层：

- 不进入超分模型。
- 按目标尺寸重新渲染。
- 保留字体、字号、字距、行距、变换和颜色。
- 在最终位图合成阶段覆盖回背景。

### 13.2 扁平位图文字

处理顺序：

```text
文字检测
  -> 判断字体是否可恢复
  -> OCR 仅提供内容与置信度
  -> 字体可匹配时允许用户确认后重绘
  -> 定制字形使用 SDF/轮廓方式重建边缘
  -> 无法确认时保护原字形，不静默替换
```

SDF 即有符号距离场。适合大标题、标语和规则字形的高分辨率边缘重建。

禁止：

- 用 UltraSharp 猜测缺失中文笔画并称为内容恢复。
- 低置信度 OCR 自动覆盖原文。
- 对定制 Logo 字形自动替换系统字体。

### 13.3 Logo与二维码

- Logo优先使用原矢量资产。
- 扁平Logo可以使用轮廓/SDF增强。
- 二维码解码成功后重新生成。
- 二维码不进入GAN超分。

## 14. 几何、边框与平坦色块分支

该分支是文化墙和打卡装置的关键，不依赖第三个神经超分模型。

处理：

```text
保边降噪
  -> OKLab颜色聚类或调色板吸附
  -> 直线、矩形、圆角、圆和轮廓检测
  -> SDF或高分辨率轮廓重建
  -> 重新填色
```

推荐传统算法：

- Guided Filter。
- Bilateral Filter。
- Scharr梯度。
- Canny边缘。
- Hough直线与圆。
- 距离变换和SDF。
- 连通域和轮廓拟合。

规则：

- 色块内部不注入高频纹理。
- 边缘只增强一个主轮廓，避免双边。
- 渐变区域不做强颜色量化。
- 规则图形优先重建几何，不追踪像素锯齿。

## 15. 人像分支

### 15.1 默认身份保守

默认流程：

```text
全图照片分支
  -> 人脸与皮肤检测
  -> 人脸ROI保真增强
  -> 皮肤降低高频权重
  -> 眼睛、眉毛、嘴唇适度增强
  -> 羽化合成
```

默认不使用生成式人脸先验。

### 15.2 人脸尺寸路由

| 输入人脸宽度 | 默认策略 |
|---:|---|
| 大于 256 px | 普通照片超分，不启用生成式修复 |
| 128 至 256 px | 保真人脸ROI增强 |
| 小于 128 px | 警告质量有限，允许用户选择AI重建 |
| 严重模糊或遮挡 | 保留原结果并提示，不自动虚构 |

阈值是初始值，必须通过测试集调优。

### 15.3 人脸模型候选

- [4xFaceUpDAT](https://openmodeldb.info/models/4x-FaceUpDAT)：面向人脸的 4x DAT 超分，不是默认生成式五官重建器。
- [CodeFormer](https://github.com/sczhou/CodeFormer)：可选生成式修复，较大 fidelity weight 偏向保真。
- [GFPGAN](https://github.com/TencentARC/GFPGAN)：使用预训练 GAN 人脸先验，只作为可选修复。

实施要求：

- 先验证 FaceUpDAT 的 ONNX 转换或当前运行时兼容性。
- CodeFormer/GFPGAN 默认关闭。
- 生成式修复必须标记“AI重建”。
- 保存未修复版本供对比。
- 生成结果只以可调权重融合回ROI。
- 头发和服装由全图模型处理，不纳入小脸裁剪。

### 15.4 人像质量验证

至少检查：

- 人脸关键点漂移。
- ArcFace或等价身份相似度。
- 肤色变化。
- 眼睛、牙齿和耳朵形状异常。
- 人脸边缘和头发拼接痕迹。
- 生成式修复前后人工A/B。

## 16. 内容感知融合

### 16.1 不是普通透明叠加

推荐受约束高频注入：

```text
base = 主结构结果
detailHigh = HighPass(detail) - HighPass(base)

weight =
  edgeConfidence
  * contentClassWeight
  * degradationConfidence
  * haloSuppression

final = base + clamp(weight * detailHigh)
```

### 16.2 内容权重

| 内容 | 细节权重 |
|---|---:|
| 插画轮廓 | 高 |
| 建筑纹理 | 中高 |
| 普通照片纹理 | 中 |
| 人脸五官 | 中低且受保护 |
| 皮肤、天空 | 低 |
| 平坦色块内部 | 接近零 |
| 文字 | 不参与，最终重绘 |
| Logo和二维码 | 不参与GAN高频融合 |

### 16.3 光晕抑制

融合前后计算：

- 边缘两侧 overshoot/undershoot。
- 双边数量。
- 局部对比度变化。
- 黑白边缘宽度。

检测到明显光晕时：

- 降低细节权重。
- 缩窄边缘掩膜。
- 限制高频幅度。
- 回退到结构分支。

### 16.4 遮罩处理

- 在源坐标中扩张 4 至 8 px。
- 输出空间羽化 8 至 24 px。
- 人脸ROI羽化更宽。
- Tile边缘使用 Hann 或余弦权重。
- 禁止硬边拼接。

## 17. 最终锐化

- CAS或轻量USM只执行一次。
- 在精确目标缩放之后执行。
- 默认强度 10% 至 20%。
- 文字已重绘区域不重复锐化。
- 平坦色块内部不锐化。
- 皮肤和天空降低强度。
- 检测到光晕时自动减弱。

`sharpenStrength=100`不能等于无限制锐化，UI值应映射到安全范围。

## 18. 分辨率策略

默认长边：

| 名称 | 长边 |
|---|---:|
| 4K | 3840 |
| 8K | 7680 |
| 16K | 15360 |

```text
scale = targetLongEdge / sourceLongEdge

scale <= 1:
  只执行可选修复和缩小

1 < scale <= 2:
  优先使用2x模型或一次保真放大后精确缩放

2 < scale <= 4:
  使用一次4x模型后精确缩放

4 < scale <= 8:
  仅在需要时使用2x保真 -> 4x内容模型

scale > 8:
  显示低可信度警告
```

禁止默认连续执行：

```text
4x-UltraSharp -> 4x-UltraSharp
```

本节4K/8K/16K策略只适用于最终 `image`。`vectorGuide` 始终遵循第7.2节的最多2x和最长边4096限制，不能为了矢量化生成16K中间图。

## 19. 预设

### 19.1 极速

```text
轻量分析
  -> 根据主内容选择一个轻量模型
  -> 原生文字重绘
  -> 轻量CAS
```

- 不运行双模型全图。
- 可评估 UltraSharpV2 Lite、RealPLKSR 或 SPAN。
- 适合预览和较低配置设备。

### 19.2 海报/文化墙

```text
条件DeJPG
  -> 照片ROI：NomosWebPhoto
  -> 插画ROI：UltraSharpV2 Lite或兼容模型
  -> 文字：原生重绘/OCR确认/SDF
  -> 边框和色块：几何与保边算法
  -> 内容感知融合
  -> 轻量CAS
```

这是 MOMO 默认模式。

### 19.3 人像

```text
条件DeJPG
  -> 全图照片模型
  -> 人脸和皮肤掩膜
  -> 可选FaceUpDAT ROI
  -> 身份保护融合
  -> 轻量锐化
```

生成式人脸修复默认关闭。

### 19.4 专业印刷

```text
完整内容分析
  -> 高质量照片与插画模型
  -> 人像保真分支
  -> 文字和几何重建
  -> 多频段融合
  -> 光晕抑制
  -> 16位无损输出
```

专业模式不等于所有模型全图运行。

## 20. 模型注册表

```json
{
  "id": "nomos-web-photo-realplksr-x4",
  "displayName": "MOMO Photo x4",
  "task": "super-resolution",
  "contentTags": ["photo", "web-photo"],
  "scale": 4,
  "architecture": "RealPLKSR",
  "format": "onnx",
  "precision": ["fp16", "fp32"],
  "path": "由 localModelRegistry 按 AppData/models > 安装包内嵌(resourceDir/models) > 自动下载 解析，注册表只存稳定 id + fileName",
  "sha256": "REPLACE_WITH_REAL_HASH",
  "recommendedTile": 512,
  "enabled": true
}
```

> 落地说明（2026-08-01）：实际注册表在 `src/core/localModelRegistry.ts`，字段为 `id/displayName/task/scale/architecture/format/fileName/size/sha256/url/recommendedTile/tags/optional`，不存 path；必需模型（8 个 ~230MB）经 `tauri.conf.json` 的 `bundle.resources`（`../models/sr/*` → `models/`）内嵌进安装包与便携 zip，运行时解析顺序 AppData 副本 > 内嵌 > 自动下载。

要求：

- 节点保存稳定模型ID，不保存绝对路径。
- 启动或首次使用时校验SHA-256。
- 架构字段必须真实。
- 模型版本变化进入缓存键。
- 每个模型声明适用内容和禁用内容。
- 不允许把“Text”标签当成中文内容正确性保证。

## 21. 性能与显存

### 21.1 后端优先级

1. ONNX Runtime CUDA。
2. TensorRT，可在后续加入缓存。
3. ONNX Runtime DirectML。
4. NCNN Vulkan。
5. CPU降级。

### 21.2 精度

- NVIDIA默认FP16。
- 不支持时回退FP32。
- 中间过程不写有损JPEG。
- Alpha单独高质量缩放。
- 16K避免同时保留多个全尺寸GPU副本。

### 21.3 自适应Tile

| 当前可用显存 | 输入Tile |
|---:|---:|
| 少于4GB | 192 |
| 4至6GB | 256 |
| 6至9GB | 384 |
| 9至13GB | 512 |
| 13GB以上 | 640或768 |

默认重叠：

- 标准：32输入像素。
- 专业：48输入像素。
- 人像ROI适当扩大上下文。

发生OOM：

1. 释放临时张量。
2. Tile降低一级。
3. 自动重试一次。
4. 再失败切换低显存模式或提示用户。
5. 不允许MOMO主进程崩溃。

### 21.4 ROI推理

- 第二神经模型默认只处理ROI。
- ROI按模型要求对齐和扩张。
- 重叠ROI合并后再推理。
- 记录实际ROI覆盖率。
- ROI覆盖过高时根据预设决定全图运行或回退单模型。

### 21.5 模型生命周期

- GPU模型按阶段串行加载。
- 同时常驻不超过两个模型。
- 优先保留当前主模型。
- 可选模型空闲后释放。
- 超分、StarVector和生成式人脸模型不得无条件同时常驻。

## 22. 任务、缓存和调试

任务阶段：

```text
ANALYZE_INPUT
BUILD_MASKS
RESTORE_DEGRADATION
BUILD_VECTOR_GUIDE
UPSCALE_PHOTO
UPSCALE_ILLUSTRATION
REBUILD_TEXT_AND_GEOMETRY
ENHANCE_PORTRAIT
FUSE_CONTENT
SUPPRESS_HALOS
RESIZE_EXACT
SHARPEN_OUTPUT
WRITE_ASSETS
COMPLETE
```

缓存：

- 分析缓存。
- `vectorGuide` 缓存。
- OCR、文字和人脸检测缓存。
- 各分支ROI缓存。
- 模型输出缓存。
- 融合缓存。
- 最终输出缓存。

`vectorGuide`缓存键至少包含：

```text
sourceAssetHash
guideSchemaVersion
guideTargetSize
degradationConfig
alphaAndColorConfig
algorithmVersions
engineVersion
```

最终 `image` 的目标4K/8K/16K尺寸和锐化参数不得污染 `vectorGuide` 缓存键；只有真正影响引导图像素或坐标的参数才使其失效。

调试模式输出：

```text
primary.png
vector-guide.png
illustration-detail.png
photo-mask.png
illustration-mask.png
text-mask.png
flat-color-mask.png
face-mask.png
edge-mask.png
high-frequency.png
fused-before-sharpen.png
final.png
```

报告至少记录：

- 真实模型ID和SHA。
- `vectorGuide` 是否生成、尺寸、倍率、算法版本和回退原因。
- 每个模型调用次数。
- 每个分支耗时。
- ROI数量和覆盖率。
- 遮罩平均值和最大值。
- 高频注入能量。
- 峰值显存。
- Tile数量。
- 是否发生OOM重试。

## 23. 颜色、Alpha和输出

- 保留或明确转换ICC配置。
- 统一RGB通道顺序和数值范围。
- Alpha通常不进入照片超分模型。
- 恢复预乘或非预乘Alpha时遵循MOMO渲染约定。
- 中间结果使用内存或无损临时格式。
- PNG和TIFF为默认最终格式。
- JPEG只作为可选交付格式。
- 16K使用流式或Tile编码。

印刷尺寸模式：

```text
pixelsX = widthMm / 25.4 * dpi
pixelsY = heightMm / 25.4 * dpi
```

在开始任务前显示预计像素、内存和耗时等级。

## 24. 错误码

```text
ENHANCE_INPUT_UNSUPPORTED
ENHANCE_MODEL_MISSING
ENHANCE_MODEL_INVALID
ENHANCE_BACKEND_UNAVAILABLE
ENHANCE_GPU_OOM
ENHANCE_CANCELLED
ENHANCE_WORKER_CRASHED
ENHANCE_OUTPUT_WRITE_FAILED
ENHANCE_TEXT_LOW_CONFIDENCE
ENHANCE_FACE_TOO_SMALL
ENHANCE_FACE_IDENTITY_RISK
ENHANCE_ANALYSIS_FAILED
ENHANCE_MASK_INVALID
ENHANCE_FUSION_NO_EFFECT
```

用户消息简洁，详细日志写入开发报告。

## 25. 必须补充的测试

### 25.1 模型和融合真实性

- 模型ID、架构和SHA断言。
- 两次推理确实使用不同会话。
- 禁用细节分支后，目标ROI结果发生可测变化。
- 细节分支不能改变非ROI平滑区域。
- 遮罩覆盖率不能意外接近零。
- 权重为零时输出等于结构分支。
- 权重变化时输出单调变化。

`fusion_pipeline_runs_twice` 只能保留为调用测试，不能作为融合质量测试。

### 25.2 文字和色块

- 中文OCR字符准确率增强后不下降。
- 原生文字重绘内容与源对象一致。
- SDF重建没有双边。
- 平坦色块方差不明显增加。
- 色块平均颜色差在阈值内。
- 规则直线和圆角不出现波动。

### 25.3 人像

- 人脸关键点漂移。
- 身份相似度。
- 肤色差异。
- 头发与脸部拼接。
- 生成式修复默认关闭。
- 用户关闭人脸增强时结果不运行人脸模型。

### 25.4 光晕与边缘

- 黑白阶跃边缘overshoot。
- 边缘宽度。
- 双边数量。
- 斜线锯齿。
- Tile接缝。
- 高对比中文笔画粘连。

### 25.5 与矢量化衔接

- `vectorGuide` 的源资产、正反坐标变换、尺寸和 Alpha 正确。
- `vectorGuide` 不包含最终 CAS/USM、生成式人脸修复或纹理增强。
- `vectorGuide` 最多2x且最长边不超过4096像素。
- `analysisMap`坐标映射正确。
- 矢量节点能够回溯`originalAssetId`。
- 矢量节点不把最终CAS图当作唯一源。
- 使用`vectorGuide`后，固定测试集的轮廓误差改善，且VTracer路径和锚点数量不异常增加。
- 缺少`vectorGuide`或`analysisMap`时矢量节点仍可独立运行。

## 26. 固定视觉测试集

至少包含：

- 中文党建文化墙。
- 大标题和小字混合海报。
- 红金色平坦色块。
- 圆角打卡框。
- 带渐变和阴影的装饰插画。
- 微信压缩活动照片。
- 建筑照片。
- 正常清晰人像。
- 小脸合影。
- 严重模糊人脸。
- AI卡通头像。
- 透明PNG。
- Logo和二维码。

每个样本保存：

- 原图。
- `vectorGuide`。
- 当前版本结果。
- 新极速、海报、人像、专业结果。
- 各内容掩膜。
- 光晕局部图。
- 文字局部图。
- 运行时间和峰值显存。

## 27. 分阶段实施

### 阶段一：确认当前实现

- 输出当前模型ID、架构、SHA和后端。
- 阅读`fusion_pipeline_runs_twice`真实断言。
- 增加分支、遮罩和融合调试输出。
- 建立固定文化墙、海报和人像测试集。
- 不立即增加新模型。

### 阶段二：海报/文化墙核心

- 增加`vectorGuide`输出、元数据、缓存和坐标变换。
- 增加`analysisMap`。
- 增加文字、色块、几何和渐变区域分析。
- 实现原生文字重绘。
- 实现SDF文字与轮廓重建。
- 实现保边色块处理。
- 将第二模型改为ROI推理。
- 加入光晕抑制。

### 阶段三：模型升级

- 评估UltraSharpV2 Lite作为标准插画模型。
- 评估UltraSharpV2 DAT2作为专业插画模型。
- 保留NomosWebPhoto照片分支。
- 用真实测试集决定模型，不按标签决定。

### 阶段四：人像

- 建立人像测试和身份指标。
- 首先验证NomosWebPhoto默认结果。
- 验证FaceUpDAT运行时与ONNX一致性。
- 实现身份保守ROI融合。
- 最后加入可选CodeFormer/GFPGAN。

## 28. GLM 第一轮指令

```text
请阅读 MOMO 项目源码、
MOMO_SUPER_RESOLUTION_IMPLEMENTATION.md 和
MOMO_IMAGE_VECTORIZATION_IMPLEMENTATION.md。

先不要修改代码。

请完成：
1. 列出当前高清增强节点涉及的文件和调用链。
2. 输出极速、标准、专业档实际加载的模型ID、架构、文件路径和SHA。
3. 阅读 fusion_pipeline_runs_twice，说明它真实证明了什么、没有证明什么。
4. 找出当前内容遮罩、融合权重、Tile、缓存和任务实现。
5. 判断是否已经能保存原图血缘、vectorGuide和analysisMap。
6. 列出当前对文字、色块、几何、人脸分别做了什么。
7. 使用固定样本输出主模型、细节模型、掩膜、高频和最终结果。
8. 给出阶段二的文件级实施计划和测试计划。
9. 不要先增加第三个模型。
10. 不要修改与本功能无关的代码。
```

## 29. GLM 阶段二实施指令

```text
按照确认后的计划实现“海报/文化墙核心”。

要求：
- 保持高清增强和智能矢量化为两个独立节点。
- 高清节点输出image、可选vectorGuide、可选analysisMap和report。
- vectorGuide从轻度去压缩和保边降噪结果分叉，最多2x、最长边4096，不执行最终CAS/USM、生成式人脸修复或纹理增强。
- vectorGuide记录原图血缘、正反坐标变换、算法版本和处理声明；失败时不阻止image输出。
- analysisMap包含文字、色块、几何、插画、照片、人像和边缘掩膜。
- 原生文字按目标尺寸重绘。
- 扁平文字和规则轮廓提供SDF重建路径。
- 平坦色块使用保边降噪和颜色整理，不注入神经高频。
- 第二神经模型默认只处理插画ROI。
- 高频融合加入内容权重和光晕抑制。
- 最终CAS只执行一次，且跳过文字和色块内部。
- 增加模型身份、遮罩覆盖、分支贡献、光晕、文字和色块测试。
- 保持现有项目结构、任务、缓存、撤销重做和持久化方式。
- 运行类型检查、cargo test、其他现有测试和构建。
- 最后列出修改文件、测试结果、性能变化和已知限制。
```

## 30. 验收标准

- 高清节点与矢量节点保持独立。
- 海报/文化墙成为默认预设。
- 原生文字不进入GAN超分。
- 中文大标题边缘清楚且内容不变。
- 平坦色块内部不增加明显纹理。
- 插画边缘清楚且没有明显白边。
- 标准模式第二模型使用ROI而不是无条件全图。
- 人像默认不启用生成式修复。
- `vectorGuide`可以被下游复用，最多2x、最长边不超过4096且不包含最终锐化。
- `vectorGuide`坐标变换可逆，缺失时不影响最终高清位图输出。
- `analysisMap`可以被下游复用且坐标正确。
- 相同输入和参数命中缓存。
- OOM自动降低Tile，主进程不崩溃。
- 调试报告能证明每个模型和分支的实际贡献。
- 测试、类型检查和构建通过。

## 31. 最终产品定义

用户名称：

```text
MOMO 高清增强
```

技术定义：

```text
面向海报、文化墙、打卡装饰、照片和人像的
内容感知、多模型、多算法、本地高清增强引擎
```

默认海报/文化墙流程：

```text
退化分析
  -> 内容分区
  -> 分叉生成保结构vectorGuide
  -> 照片使用NomosWebPhoto
  -> 插画使用UltraSharpV2 Lite候选
  -> 文字使用重绘/OCR确认/SDF
  -> 边框和色块使用几何与保边算法
  -> 人像使用身份保守分支
  -> 内容感知多频段融合
  -> 光晕抑制
  -> 精确尺寸
  -> 轻量输出锐化
```

## 32. 主要资料

- NomosWebPhoto RealPLKSR：https://openmodeldb.info/models/4x-NomosWebPhoto-RealPLKSR
- UltraSharpV2：https://openmodeldb.info/models/4x-UltraSharpV2
- UltraSharp：https://huggingface.co/Kim2091/UltraSharp
- 1x-DeJPG RealPLKSR：https://openmodeldb.info/models/1x-DeJPG-realplksr-otf
- SPAN：https://github.com/hongyuanyu/SPAN
- Real-ESRGAN：https://github.com/xinntao/Real-ESRGAN
- FaceUpDAT：https://openmodeldb.info/models/4x-FaceUpDAT
- CodeFormer：https://github.com/sczhou/CodeFormer
- GFPGAN：https://github.com/TencentARC/GFPGAN
- PaddleOCR：https://github.com/PaddlePaddle/PaddleOCR
