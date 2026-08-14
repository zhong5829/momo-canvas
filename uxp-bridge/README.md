# MOMO Bridge for Premiere Pro (UXP)

MOMO 导演台与 Adobe Premiere Pro 的桥接插件。从 MOMO 导出的项目清单 JSON 一键创建 Premiere 素材箱、序列和标记。

## 安装

1. 安装 [Adobe UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/dev-tool/)
2. 打开 UXP Developer Tool → 「Add Plugin」→ 选择本目录的 `manifest.json`
3. 点「Load」加载插件
4. 在 Premiere Pro 的「窗口 → 扩展」里找到「MOMO Bridge」面板

## 使用流程

1. 在 MOMO 导演台剪辑页：
   - 点「导出 Premiere XML」生成 FCP7 XML
   - 点「导出项目清单」生成 `_项目清单.json`
   - 把采用版本的视频素材放在同一个文件夹
2. 在 Premiere 的 MOMO Bridge 面板：
   - 点「选择 MOMO 项目清单 JSON」加载项目信息
   - 点「导入素材 + 创建序列」选择素材文件夹
   - 插件会自动创建素材箱、导入视频、创建时间线序列并写入标记

## 边界

- 本插件不读写 `.prproj` 私有格式，只通过 UXP 公开 API 创建素材箱/序列/轨道/标记
- 精确的轨道排列（V1/A1-A5）建议用 MOMO 导出的 FCP7 XML 直接「导入」
- 本插件的优势是：可视化选择素材文件夹 + 自动建箱 + 写入场景标记

## 文件结构

```
uxp-bridge/
├─ manifest.json    UXP 插件清单
├─ index.html       面板 UI
├─ main.js          逻辑（读取清单 → 创建素材箱/序列/标记）
└─ README.md        本文件
```
