// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un seul processus pour la demo : il compile les pages, il les sert, et il porte
// le relais. Aucune configuration de bundler a maintenir — le banc doit pouvoir
// se lancer d'une commande, sinon personne ne le lancera.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'
import { startRelay } from './relay'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)
const WATCH = process.argv.includes('--watch')
const require_ = createRequire(import.meta.url)

// Yjs est present deux fois (celui du banc, celui d'EdgeSync). Deux instances
// dans une meme page, ce sont deux mondes qui ne se reconnaissent pas : on force
// la resolution sur une seule.
const YJS = require_.resolve('yjs')

const ctx = await esbuild.context({
  entryPoints: ['editor.ts', 'crud.ts', 'wall.ts'].map((f) => join(ROOT, f)),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: join(ROOT, 'dist'),
  sourcemap: true,
  alias: { yjs: YJS },
  logLevel: 'warning',
})
await ctx.rebuild()
if (WATCH) await ctx.watch()
else await ctx.dispose()

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const rel = path === '/' ? 'wall.html' : path.slice(1)
  const file = resolvePath(ROOT, rel)
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('non'); return }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end('introuvable')
  }
})

startRelay(server)
server.listen(PORT, () => {
  console.log(`\n  le mur        http://localhost:${PORT}/?n=10&app=editor`)
  console.log(`  la base CRUD  http://localhost:${PORT}/?n=6&app=crud`)
  console.log(`  un seul pair  http://localhost:${PORT}/editor.html?slot=0\n`)
  if (WATCH) console.log('  (rechargement a chaud actif)\n')
})
