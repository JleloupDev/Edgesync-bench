// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le mur : N fenetres du meme vault, cote a cote. Chacune est un pair complet et
// independant — meme code, meme protocole, aucune memoire partagee, seulement le
// relais entre elles.
//
// Le bouton « verifier la convergence » reprend la discipline de compare(users)
// chez Yjs : on arrete les robots, on remet tout le monde en ligne, on laisse le
// reseau se vider, ET SEULEMENT ALORS on compare. Comparer des pairs qui tapent
// encore ne prouve rien.
const params = new URLSearchParams(location.search)
const N = Math.max(1, Math.min(24, Number(params.get('n') ?? 10)))
const APP = params.get('app') === 'crud' ? 'crud' : 'editor'
const RATE = params.get('rate') ?? (APP === 'crud' ? '900' : '700')
const BOT = params.get('bot') ?? '1'
const SEED = Number(params.get('seed') ?? 1)

const grid = document.querySelector('#grid') as HTMLElement
const verdict = document.querySelector('#verdict') as HTMLElement
const table = document.querySelector('#states') as HTMLElement

const url = (i: number) => `/${APP}.html?slot=${i}&bot=${BOT}&rate=${RATE}&seed=${SEED + i * 7919}`
const cells: HTMLIFrameElement[] = []

function addFrame(i: number): HTMLIFrameElement {
  const box = document.createElement('div')
  box.className = 'cell'
  const cap = document.createElement('div')
  cap.className = 'cap'
  cap.textContent = i === 0 ? `#${i} · fondateur` : `#${i}`
  const f = document.createElement('iframe')
  f.src = url(i)
  box.append(cap, f)
  grid.append(box)
  cells.push(f)
  return f
}

/** Le premier connecte fonde le vault : il doit etre seul au moment ou il arrive. */
async function boot(): Promise<void> {
  const first = addFrame(0)
  await founderReady(first)
  for (let i = 1; i < N; i++) addFrame(i)
}

function founderReady(f: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = setInterval(() => {
      f.contentWindow?.postMessage({ type: 'edgesync:cmd', cmd: 'state' }, '*')
      if (Date.now() - t0 > 4000) { clearInterval(tick); resolve() }
    }, 150)
    const on = (ev: MessageEvent) => {
      if ((ev.data as { type?: string })?.type !== 'edgesync:state') return
      clearInterval(tick)
      removeEventListener('message', on)
      resolve()
    }
    addEventListener('message', on)
  })
}

const broadcast = (cmd: string) => {
  for (const f of cells) f.contentWindow?.postMessage({ type: 'edgesync:cmd', cmd }, '*')
}

interface StateMsg {
  type: string; id: string; founder: boolean; access?: number; height: number
  head: string; offline: boolean; peers: number; bytes: number; summary: string; digest: string
}

function collect(ms = 900): Promise<StateMsg[]> {
  return new Promise((resolve) => {
    const got: StateMsg[] = []
    const on = (ev: MessageEvent) => {
      const m = ev.data as StateMsg
      if (m?.type === 'edgesync:state') got.push(m)
    }
    addEventListener('message', on)
    broadcast('state')
    setTimeout(() => { removeEventListener('message', on); resolve(got) }, ms)
  })
}

async function checkConvergence(): Promise<void> {
  verdict.className = 'verdict wait'
  verdict.textContent = 'robots arretes, reseau retabli, on laisse le trafic se vider…'
  broadcast('bot-off')
  broadcast('online')
  await new Promise((r) => setTimeout(r, 2500))
  const states = await collect()
  states.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  const groups = new Map<string, number>()
  for (const s of states) groups.set(s.digest, (groups.get(s.digest) ?? 0) + 1)
  const members = states.filter((s) => s.access !== undefined)
  const ok = groups.size === 1 && states.length === cells.length

  verdict.className = `verdict ${ok ? 'ok' : 'ko'}`
  verdict.textContent = ok
    ? `converge — ${states.length}/${cells.length} fenetres, meme empreinte ${[...groups.keys()][0].slice(0, 12)}, ${members.length} membres`
    : `DIVERGENT — ${groups.size} etats distincts sur ${states.length} fenetres (${cells.length} attendues)`

  table.innerHTML = '<tr><th>pair</th><th>droit</th><th>chaine</th><th>tete</th><th>etat</th><th>empreinte</th><th>fil</th></tr>'
  const first = states[0]?.digest
  for (const s of states) {
    const tr = document.createElement('tr')
    if (s.digest !== first) tr.className = 'ko'
    const acc = ['pull', 'read', 'write', 'manage'][s.access ?? -1] ?? '—'
    for (const cell of [
      s.id + (s.founder ? ' ⚑' : ''), acc, `h=${s.height}`, s.head, s.summary,
      s.digest.slice(0, 12), `${(s.bytes / 1024).toFixed(0)} Kio`,
    ]) {
      const td = document.createElement('td')
      td.textContent = String(cell)
      tr.append(td)
    }
    table.append(tr)
  }
}

const bind = (sel: string, fn: () => void) => {
  (document.querySelector(sel) as HTMLButtonElement).onclick = fn
}
bind('#play', () => broadcast('bot-on'))
bind('#pause', () => broadcast('bot-off'))
bind('#check', () => { void checkConvergence() })
bind('#cut', () => {
  // Une partition au hasard, jamais le fondateur : couper l'arbitre est un autre
  // scenario (interessant, mais celui-la se regarde a part).
  const i = 1 + Math.floor(Math.random() * (cells.length - 1))
  cells[i]?.contentWindow?.postMessage({ type: 'edgesync:cmd', cmd: 'offline' }, '*')
  verdict.className = 'verdict wait'
  verdict.textContent = `fenetre #${i} coupee du reseau — elle continue d'ecrire dans son coin`
})
bind('#heal', () => { broadcast('online'); verdict.textContent = 'tout le monde est en ligne' })
bind('#windows', () => { for (let i = 0; i < N; i++) window.open(url(i), `edgesync-${i}`, 'width=640,height=520') })
bind('#reset', () => location.reload())

document.querySelector('#title')!.textContent =
  `${N} fenetres · ${APP === 'crud' ? 'base CRUD' : 'editeur de texte'} · un pair par fenetre`

void boot()
