// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'editeur : une fenetre = un pair. Le texte est un Y.Text porte par un canal du
// vault ; chaque frappe part chiffree, signee, a la position causale de la
// chaine. Le robot tape a des endroits tires au sort, avec une graine — ce que
// deux fenetres font au meme instant est exactement le cas que le CRDT doit
// absorber.
import { joinDemo } from './src/demo-peer'
import { Prng, seedFromUrl } from './src/prng'
import { digest, mountShell, type Bot } from './src/ui'

const params = new URLSearchParams(location.search)
const slot = params.get('slot') ?? '?'
const rate = Number(params.get('rate') ?? 700)
const seed = seedFromUrl(`editor-${slot}`)

const ta = document.querySelector('#doc') as HTMLTextAreaElement
const peer = await joinDemo({ channel: 'edgesync-demo/doc/texte' })
const ytext = peer.crdt.text()
document.title = `EdgeSync · ${peer.transport.localId}${peer.founder ? ' (fondateur)' : ''}`

// ── liaison textarea <-> Y.Text ────────────────────────────────────────────
// Un diff prefixe/suffixe : la saisie humaine produit une seule op, comme une
// vraie liaison d'editeur. Sans cela, chaque frappe reecrirait tout le document.
let applying = false

function pull(): void {
  const next = ytext.toString()
  if (ta.value === next) return
  const caret = ta.selectionStart
  const before = ta.value
  applying = true
  ta.value = next
  applying = false
  // On ne recale que grossierement : la fenetre est une demo, pas un editeur.
  const delta = next.length - before.length
  const pos = caret > before.length - 1 && delta > 0 ? caret + delta : caret
  ta.setSelectionRange(Math.min(pos, next.length), Math.min(pos, next.length))
}

ta.addEventListener('input', () => {
  if (applying) return
  const old = ytext.toString()
  const now = ta.value
  let start = 0
  while (start < old.length && start < now.length && old[start] === now[start]) start++
  let end = 0
  while (end < old.length - start && end < now.length - start
    && old[old.length - 1 - end] === now[now.length - 1 - end]) end++
  const removed = old.length - start - end
  const added = now.slice(start, now.length - end)
  peer.crdt.doc.transact(() => {
    if (removed > 0) ytext.delete(start, removed)
    if (added) ytext.insert(start, added)
  })
})

ytext.observe(() => { pull(); render() })
pull()

// ── le robot ───────────────────────────────────────────────────────────────
const rng = new Prng(seed)
const MOTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
let n = 0
let timer: number | undefined

const bot: Bot = {
  start() {
    if (timer !== undefined) return
    timer = setInterval(() => bot.step(), rate) as unknown as number
  },
  stop() {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  },
  running: () => timer !== undefined,
  step() {
    // Ecrire sans droit d'ecriture ne sert a rien : l'op ne serait ni scellee ni
    // acceptee. Le robot attend son admission, comme un humain patient.
    if (peer.access() === undefined) return
    const len = ytext.length
    if (len > 4000) { ytext.delete(0, 2000); return }
    if (len > 20 && rng.chance(0.15)) {
      const at = rng.int(len - 10)
      ytext.delete(at, 1 + rng.int(9))
      return
    }
    const at = rng.int(len + 1)
    ytext.insert(at, `${rng.pick(MOTS)}-${peer.transport.localId}.${++n} `)
  },
}

function render(): void {
  const el = document.querySelector('#len') as HTMLElement
  el.textContent = `${ytext.length} caracteres · ${digest(ytext.toString()).slice(0, 8)}`
}

mountShell({
  peer, bot, seed,
  state: () => ({ summary: `${ytext.length} car.`, digest: digest(ytext.toString()) }),
})
render()
setInterval(render, 500)

if (params.get('bot') === '1') bot.start()
