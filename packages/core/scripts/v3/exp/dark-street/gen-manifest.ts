/**
 * gen-manifest.ts
 *
 * 扫描 暗街/ 目录下所有 .md 文件的 YAML frontmatter，生成 manifest.json。
 * 在新增/重命名/修改 frontmatter 后跑一次：
 *
 *   ts-node gen-manifest.ts
 *   # 或
 *   tsx gen-manifest.ts
 */

import * as fs from "fs"
import * as path from "path"
import type { FileMeta } from "./loader"

const ROOT = __dirname
const SKIP_DIRS = new Set(["_原始", "node_modules", ".git"])

/** 极简 YAML parser，只处理本项目 frontmatter 用到的语法。 */
function parseFrontmatter(content: string): FileMeta | null {
  if (!content.startsWith("---\n")) return null
  const end = content.indexOf("\n---", 4)
  if (end === -1) return null
  const yaml = content.slice(4, end)

  const meta: any = {}
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.match(/^([a-zA-Z_]\w*):\s*(.*)$/)
    if (!m) continue
    const [, key, val] = m

    if (val === "true") meta[key] = true
    else if (val === "false") meta[key] = false
    else if (/^\[.*\]$/.test(val)) {
      // 数组：[a, b, c] 或 [1, 2]
      meta[key] = val
        .slice(1, -1)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => (/^-?\d+$/.test(s) ? parseInt(s, 10) : s))
    } else {
      meta[key] = val
    }
  }
  return meta as FileMeta
}

function* walk(dir: string, base = ""): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(base, ent.name)
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      yield* walk(path.join(dir, ent.name), rel)
    } else if (ent.name.endsWith(".md")) {
      yield rel
    }
  }
}

function main() {
  const manifest: Record<string, FileMeta> = {}
  let skipped = 0

  for (const rel of walk(ROOT)) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf-8")
    const meta = parseFrontmatter(content)
    if (meta) {
      manifest[rel] = meta
    } else {
      skipped++
      console.warn(`[skip] no frontmatter: ${rel}`)
    }
  }

  const sortedKeys = Object.keys(manifest).sort()
  const sorted: Record<string, FileMeta> = {}
  for (const k of sortedKeys) sorted[k] = manifest[k]

  const outPath = path.join(ROOT, "manifest.json")
  fs.writeFileSync(outPath, JSON.stringify(sorted, null, 2) + "\n", "utf-8")
  console.log(`✓ ${outPath}: ${Object.keys(sorted).length} entries (${skipped} skipped)`)
}

main()
