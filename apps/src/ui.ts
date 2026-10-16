// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La coquille commune aux mini-apps : la barre d'etat, le panneau du fondateur,
// et le canal de commande utilise par le mur (postMessage). Rien de tout ceci
// n'est du protocole — c'est ce qui rend le protocole VISIBLE.
import { toHex } from 'edgesync-protocol'
import { ACCESS_LABEL, type DemoPeer } from './demo-peer'

export interface Bot {
  start(): void
  stop(): void
  running(): boolean
  step(): void
}

export interface ShellOpts {
  peer: DemoPeer
  /** Ce que le mur compare entre fenetres : un resume court et une empreinte. */
  state: () => { summary: string; digest: string }
  bot: Bot
  seed: number
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement

export function mountShell(o: ShellOpts): { refresh: () => void } {
  const { peer } = o
  const bar = $('#bar')
  const panel = $('#panel')

  const btnBot = button('robot', () => { o.bot.running() ? o.bot.stop() : o.bot.start(); refresh() })
  const btnNet = button('hors ligne', () => { peer.transport.setOffline(!peer.transport.isOffline()); refresh() })
  const btnAdmit = button('admettre les pairs', () => { peer.admitPending(); refresh() })
  const auto = checkbox('auto-admettre', true)

  bar.append(
    tag('span', 'id', `${peer.transport.localId}${peer.founder ? ' · fondateur' : ''}`),
    tag('span', 'acc', '—'),
    tag('span', 'chain', 'h=0'),
    tag('span', 'net', '0 pairs'),
    tag('span', 'wire', '0 o'),
    tag('span', 'seed', `graine ${o.seed}`),
    btnBot, btnNet,
  )
  if (peer.founder) bar.append(btnAdmit, auto.label)

  function refresh(): void {
    const acc = peer.access()
    set('acc', acc === undefined ? 'aucun droit' : ACCESS_LABEL[acc], acc === undefined ? 'warn' : 'ok')
    set('chain', `chaine h=${peer.chain.height()}`)
    const off = peer.transport.isOffline()
    set('net', off ? 'HORS LIGNE' : `${peer.transport.peers().length} pairs`, off ? 'warn' : '')
    const s = peer.transport.stats
    set('wire', `${fmt(s.bytesSent)} ↑ / ${fmt(s.bytesRecv)} ↓`)
    btnBot.textContent = o.bot.running() ? 'robot ⏸' : 'robot ▶'
    btnBot.classList.toggle('on', o.bot.running())
    btnNet.textContent = off ? 'reconnecter' : 'couper le reseau'
    btnNet.classList.toggle('on', off)
    if (peer.founder) renderPanel()
  }

  function renderPanel(): void {
    const rows = peer.knownPeers()
    panel.innerHTML = ''
    if (!rows.length) { panel.textContent = 'aucun pair vu'; return }
    for (const p of rows) {
      const row = document.createElement('div')
      row.className = 'row'
      row.append(
        tag('code', '', p.link),
        tag('code', 'dim', p.short),
        tag('span', p.access === undefined ? 'warn' : 'ok',
          p.access === undefined ? 'non membre' : ACCESS_LABEL[p.access]),
      )
      if (p.access !== undefined) {
        row.append(button('revoquer', () => { peer.revoke(p.signPub); refresh() }))
      }
      panel.append(row)
    }
  }

  // Le fondateur admet tout seul : sans cela, dix fenetres resteraient dix
  // inconnus. C'est le SEUL raccourci de la demo, et il est visible (case a
  // cocher) — le protocole, lui, n'a pas de porte ouverte.
  setInterval(() => { if (peer.founder && auto.input.checked) peer.admitPending() }, 1200)
  setInterval(refresh, 500)

  // Canal de commande du mur.
  addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { type?: string; cmd?: string }
    if (m?.type !== 'edgesync:cmd') return
    if (m.cmd === 'bot-on') o.bot.start()
    else if (m.cmd === 'bot-off') o.bot.stop()
    else if (m.cmd === 'offline') peer.transport.setOffline(true)
    else if (m.cmd === 'online') peer.transport.setOffline(false)
    else if (m.cmd === 'state') {
      const st = o.state()
      parent.postMessage({
        type: 'edgesync:state',
        id: peer.transport.localId,
        founder: peer.founder,
        access: peer.access(),
        height: peer.chain.height(),
        head: toHex(peer.chain.head()).slice(0, 8),
        offline: peer.transport.isOffline(),
        peers: peer.transport.peers().length,
        bytes: peer.transport.stats.bytesSent + peer.transport.stats.bytesRecv,
        ...st,
      }, '*')
    }
    refresh()
  })

  refresh()
  return { refresh }
}

function set(cls: string, text: string, mod = ''): void {
  const el = document.querySelector(`#bar .${cls}`) as HTMLElement | null
  if (!el) return
  el.textContent = text
  el.className = `${cls} ${mod}`
}

function tag(name: string, cls: string, text: string): HTMLElement {
  const el = document.createElement(name)
  el.className = cls
  el.textContent = text
  return el
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.onclick = onClick
  return b
}

function checkbox(label: string, checked: boolean): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  const l = document.createElement('label')
  l.append(input, document.createTextNode(` ${label}`))
  return { label: l, input }
}

export function fmt(n: number): string {
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Kio`
  return `${(n / 1048576).toFixed(1)} Mio`
}

/** Empreinte courte d'un etat applicatif : c'est elle que le mur compare. */
export function digest(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(16).padStart(16, '0')
}
