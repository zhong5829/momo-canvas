// 把 Tauri 打包产物同步到项目根目录的 APP/ 文件夹
// 包含：① 安装包（msi/nsis，连带 .sig）  ② 便携版目录（release 主 exe + models/ 内嵌模型 + portable.txt 标记）
// 背景：Tauri 2 不支持自定义 bundle 输出目录，也不提供官方 portable target；
//       便携版 = 内嵌前端资源的 release 主 exe，依赖系统 WebView2，拷走即用。
//       超清模型经 tauri.conf.json bundle.resources 内嵌（NSIS 释放到 exe 同级 models/）；
//       便携 zip 不走安装器，由本脚本把 models/sr 塞到 exe 同级，保持同一 resourceDir 约定。
// 用法：
//   pnpm app:dist   → tauri build 完成后自动调用本脚本
//   node scripts/collect-app.mjs  → 仅收集已存在的产物
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(import.meta.url), '..', '..')
const bundleDir = join(rootDir, 'src-tauri', 'target', 'release', 'bundle')
const releaseDir = join(rootDir, 'src-tauri', 'target', 'release')
const appDir = join(rootDir, 'APP')

const conf = JSON.parse(readFileSync(join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const productName = conf.productName || 'app'
const version = conf.version || ''
const dataDir = conf.identifier || 'app'

if (!existsSync(bundleDir)) {
  console.error(`[收集] 未找到打包目录：${relative(rootDir, bundleDir)}`)
  console.error('[收集] 请先运行 pnpm app:dist（或 pnpm tauri build）进行打包。')
  process.exit(1)
}

// 递归列出目录下所有文件（保留相对子目录结构）
const listFiles = (dir, base = dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) listFiles(p, base, acc)
    else acc.push({ src: p, rel: relative(base, p) })
  }
  return acc
}

// 每次重建 APP，保证目录永远等于最新一次构建的产物（不留旧版本残留）
if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })

const copyOne = (src, dst) => {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return (statSync(src).size / 1024 / 1024).toFixed(2)
}

// ① 安装包：msi / nsis（连带 .sig 签名）。bundle 目录会累积历次版本，按当前版本号过滤，确保 APP/ 只留本次
const bundleFiles = listFiles(bundleDir).filter(({ rel }) => !version || rel.includes(version))
console.log('[收集] 安装包：')
for (const { src, rel } of bundleFiles) {
  const size = copyOne(src, join(appDir, rel))
  console.log(`  - ${rel}  (${size} MB)`)
}

// ② 便携版：release 顶层主 exe（前端资源已内嵌，单文件免安装）
const portableExes = readdirSync(releaseDir)
  .filter(n => n.toLowerCase().endsWith('.exe'))
  .map(n => join(releaseDir, n))
  .filter(p => statSync(p).isFile())

if (portableExes.length > 0) {
  const portableDir = join(appDir, 'portable')
  mkdirSync(portableDir, { recursive: true })
  console.log('[收集] 便携版（免安装，双击即用，需系统 WebView2）：')
  portableExes.forEach((src, i) => {
    const outName = i === 0 ? `${productName}.exe` : `${productName}-${i + 1}.exe`
    const size = copyOne(src, join(portableDir, outName))
    console.log(`  - portable/${outName}  (${size} MB)`)
  })
  // 内嵌超清模型：bundle.resources 只覆盖安装版（NSIS 释放到 exe 同级 models/），
  // 便携 zip 是裸 exe，必须手动塞 models/ 才能走 resourceDir 内嵌解析（与安装版同一约定）
  const modelsSrc = join(rootDir, 'models', 'sr')
  const modelManifest = JSON.parse(readFileSync(join(rootDir, 'scripts', 'production-models.json'), 'utf8'))
  if (existsSync(modelsSrc)) {
    for (const model of modelManifest.models) {
      const src = join(modelsSrc, model.fileName)
      if (!existsSync(src) || statSync(src).size !== model.size) {
        throw new Error(`生产模型缺失或大小不符：${model.fileName}（请先运行 pnpm models:prepare）`)
      }
      const size = copyOne(src, join(portableDir, 'models', model.fileName))
      console.log(`  - portable/models/${model.fileName}  (${size} MB)`)
    }
    copyOne(join(rootDir, 'models', 'THIRD_PARTY_MODELS.txt'), join(portableDir, 'models', 'THIRD_PARTY_MODELS.txt'))
    console.log('  - portable/models/THIRD_PARTY_MODELS.txt')
  } else {
    console.warn('[收集] 警告：未找到 models/sr，便携版超清模型将首跑时联网下载')
  }
  // 便携版使用说明
  const readme = [
    `${productName} · 便携版`,
    '==============================',
    `直接双击 ${productName}.exe 即可运行，无需安装。`,
    '',
    '运行依赖：Windows 系统自带的 WebView2 运行时（Win10 1803+ / Win11 通常已预装）。',
    `运行数据保存在：%APPDATA%\\${dataDir}\\`,
    '',
    '注意：models/ 文件夹是超清放大的本地模型，必须与 exe 放在同一目录，',
    '移动 exe 时请连同 models/ 一起拷贝（否则首次使用超清放大时会重新联网下载）。',
  ].join('\n') + '\n'
  writeFileSync(join(portableDir, '便携版说明.txt'), readme, 'utf8')
  console.log('  - portable/便携版说明.txt')
  // 便携版标记：updater 靠它区分安装版/便携版（services/updater.ts isPortable）
  writeFileSync(join(portableDir, 'portable.txt'), 'portable\n', 'utf8')
  console.log('  - portable/portable.txt（便携版标记，更新判定用）')
}

console.log(`[收集] 完成 → ${relative(rootDir, appDir)}/`)
