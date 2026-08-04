// 公开发行模型准备器：纯 Node.js，下载/复用后同时校验字节数与 SHA-256。
// 只处理 production-models.json 白名单，不会删除用户本地的其他模型。
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(import.meta.url), '..', '..')
const manifest = (await import('./production-models.json', { with: { type: 'json' } })).default
const modelDir = join(rootDir, 'models', 'sr')
const verifyOnly = process.argv.includes('--verify-only')
mkdirSync(modelDir, { recursive: true })

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function valid(path, model) {
  return existsSync(path) && statSync(path).size === model.size && await sha256(path) === model.sha256
}

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  await pipeline(response.body, createWriteStream(path))
}

for (const model of manifest.models) {
  const target = join(modelDir, model.fileName)
  if (await valid(target, model)) {
    console.log(`[模型] 已校验 ${model.fileName}`)
    continue
  }
  if (verifyOnly) throw new Error(`生产模型缺失或校验失败：${model.fileName}`)
  const part = `${target}.part`
  rmSync(part, { force: true })
  let lastError
  for (const url of model.urls) {
    try {
      console.log(`[模型] 下载 ${model.fileName} ← ${new URL(url).host}`)
      await download(url, part)
      if (!await valid(part, model)) throw new Error('大小或 SHA-256 不匹配')
      mkdirSync(dirname(target), { recursive: true })
      renameSync(part, target)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      rmSync(part, { force: true })
      console.warn(`[模型] 下载源失败：${error}`)
    }
  }
  if (lastError) throw new Error(`无法准备 ${model.fileName}：${lastError}`)
}

console.log(`[模型] 生产白名单 ${manifest.models.length} 个模型全部通过校验`)
