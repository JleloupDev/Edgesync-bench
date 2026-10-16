// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La petite base CRUD : un Y.Map d'articles, chacun un Y.Map de champs. Ce n'est
// pas un deuxieme protocole — c'est un DEUXIEME CANAL du meme vault, sur la meme
// chaine et le meme keyring. Aucune cle n'est echangee pour lui : K_doc se derive
// de K_vault (D29/ADR-0016). C'est ce que cette app demontre.
import * as Y from 'yjs'
import { joinDemo } from './src/demo-peer'
import { Prng, seedFromUrl } from './src/prng'
import { digest, mountShell, type Bot } from './src/ui'

const params = new URLSearchParams(location.search)
const slot = params.get('slot') ?? '?'
const rate = Number(params.get('rate') ?? 900)
const seed = seedFromUrl(`crud-${slot}`)

const peer = await joinDemo({ channel: 'edgesync-demo/base/articles' })
const items = peer.crdt.doc.getMap('articles') as unknown as Y.Map<Y.Map<unknown>>
document.title = `EdgeSync CRUD · ${peer.transport.localId}${peer.founder ? ' (fondateur)' : ''}`

const rng = new Prng(seed)
const NOMS = ['cafe', 'the', 'sucre', 'farine', 'sel', 'riz', 'huile', 'miel', 'poivre']
let n = 0

function create(nom = `${rng.pick(NOMS)}-${peer.transport.localId}.${++n}`, qte = 1 + rng.int(9)): void {
  const id = `${peer.transport.localId}-${Date.now().toString(36)}-${n}`
  const item = new Y.Map<unknown>()
  peer.crdt.doc.transact(() => {
    item.set('nom', nom)
    item.set('qte', qte)
    item.set('fait', false)
    item.set('par', peer.transport.localId)
    items.set(id, item)
  })
}

const snapshot = () => [...items.entries()]
  .map(([id, m]) => ({ id, nom: String(m.get('nom') ?? ''), qte: Number(m.get('qte') ?? 0), fait: !!m.get('fait'), par: String(m.get('par') ?? '') }))
  .sort((a, b) => a.id.localeCompare(b.id))

// ── rendu ──────────────────────────────────────────────────────────────────
const tbody = document.querySelector('#items tbody') as HTMLElement
const readonly = () => (peer.access() ?? -1) < 2

function render(): void {
  const rows = snapshot()
  tbody.innerHTML = ''
  for (const r of rows) {
    const tr = document.createElement('tr')
    if (r.fait) tr.className = 'fait'

    const cbTd = document.createElement('td')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = r.fait
    cb.disabled = readonly()
    cb.onchange = () => items.get(r.id)?.set('fait', cb.checked)
    cbTd.append(cb)

    const nomTd = document.createElement('td')
    const nom = document.createElement('input')
    nom.value = r.nom
    nom.disabled = readonly()
    // Champ par champ : deux pairs qui changent le nom et la quantite du meme
    // article ne s'ecrasent pas. C'est tout l'interet du Y.Map par article.
    nom.oninput = () => items.get(r.id)?.set('nom', nom.value)
    nomTd.append(nom)

    const qteTd = document.createElement('td')
    qteTd.className = 'num'
    const moins = document.createElement('button')
    moins.textContent = '−'
    moins.disabled = readonly()
    moins.onclick = () => items.get(r.id)?.set('qte', Math.max(0, r.qte - 1))
    const plus = document.createElement('button')
    plus.textContent = '+'
    plus.disabled = readonly()
    plus.onclick = () => items.get(r.id)?.set('qte', r.qte + 1)
    qteTd.append(moins, document.createTextNode(` ${r.qte} `), plus)

    const parTd = document.createElement('td')
    parTd.className = 'dim'
    parTd.textContent = r.par

    const delTd = document.createElement('td')
    const del = document.createElement('button')
    del.textContent = '✕'
    del.disabled = readonly()
    del.onclick = () => items.delete(r.id)
    delTd.append(del)

    tr.append(cbTd, nomTd, qteTd, parTd, delTd)
    tbody.append(tr)
  }
  const count = document.querySelector('#count') as HTMLElement
  count.textContent = `${rows.length} articles · ${digest(JSON.stringify(rows)).slice(0, 8)}`
}

items.observeDeep(() => render())
;(document.querySelector('#add') as HTMLButtonElement).onclick = () => {
  const input = document.querySelector('#nom') as HTMLInputElement
  create(input.value || undefined)
  input.value = ''
}

// ── le robot ───────────────────────────────────────────────────────────────
let timer: number | undefined
const bot: Bot = {
  start() { if (timer === undefined) timer = setInterval(() => bot.step(), rate) as unknown as number },
  stop() { if (timer !== undefined) { clearInterval(timer); timer = undefined } },
  running: () => timer !== undefined,
  step() {
    if ((peer.access() ?? -1) < 2) return
    const rows = snapshot()
    if (rows.length === 0 || rng.chance(0.35)) return create()
    const r = rng.pick(rows)
    const item = items.get(r.id)
    if (!item) return
    if (rng.chance(0.12)) items.delete(r.id)
    else if (rng.chance(0.4)) item.set('qte', Math.max(0, r.qte + (rng.chance(0.5) ? 1 : -1)))
    else if (rng.chance(0.5)) item.set('fait', !r.fait)
    else item.set('nom', `${rng.pick(NOMS)}-${peer.transport.localId}.${++n}`)
  },
}

mountShell({
  peer, bot, seed,
  state: () => {
    const rows = snapshot()
    return { summary: `${rows.length} articles`, digest: digest(JSON.stringify(rows)) }
  },
})
render()
setInterval(render, 500)

if (params.get('bot') === '1') bot.start()
