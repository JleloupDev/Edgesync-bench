// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les mini-apps, sans navigateur. C'est le meme code que les fenetres du mur
// (joinDemo + RelayTransport + le vrai relais), prive de son DOM : ce qui est
// verifie ici, c'est le protocole de bout en bout sur un lien reel, pas une
// simulation en memoire.
//
// Ce que le bus en processus ne peut pas montrer et que ceci montre : le
// decoupage en trames par le lien, l'ordre d'arrivee reel, et surtout la
// PARTITION — un pair coupe qui continue d'ecrire, puis revient.
import { describe, it, expect, afterEach } from 'vitest'
import { Access } from 'edgesync-protocol'
import { startRelay } from '../apps/relay'
import { joinDemo, type DemoPeer } from '../apps/src/demo-peer'

const CANAL = 'edgesync-demo/doc/texte'
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined })

async function swarm(n: number): Promise<{ peers: DemoPeer[]; founder: DemoPeer }> {
  const port = 9000 + Math.floor(Math.random() * 900)
  const relay = startRelay(port)
  const url = `ws://127.0.0.1:${port}`
  await settle(50)

  // Le premier connecte fonde : il doit etre seul a cet instant.
  const founder = await joinDemo({ url, channel: CANAL })
  const rest: DemoPeer[] = []
  for (let i = 1; i < n; i++) rest.push(await joinDemo({ url, channel: CANAL }))
  const peers = [founder, ...rest]

  stop = () => { for (const p of peers) p.dispose(); relay.close() }
  await settle(300)
  return { peers, founder }
}

describe('mini-apps sur le relais — un pair par fenetre', () => {
  it('cinq pairs inconnus sont admis en UN lot, puis convergent', async () => {
    const { peers, founder } = await swarm(5)

    expect(founder.founder).toBe(true)
    expect(peers.slice(1).every((p) => p.access() === undefined)).toBe(true)

    const admis = founder.admitPending()
    expect(admis).toBe(4)
    await settle(600)

    // Une seule epoque pour quatre admissions (D35).
    expect(founder.chain.height()).toBe(1)
    expect(founder.access()).toBe(Access.Manage) // manage par le groupe des owners
    for (const p of peers.slice(1)) expect(p.access()).toBe(Access.Write)

    for (const p of peers) p.crdt.text().insert(0, `${p.transport.localId} `)
    await settle(700)

    const textes = peers.map((p) => p.crdt.text().toString())
    expect(new Set(textes).size).toBe(1)
    for (const p of peers) expect(textes[0]).toContain(p.transport.localId)
  })

  it('un pair coupe ecrit dans son coin, et rattrape tout au retour', async () => {
    const { peers, founder } = await swarm(3)
    founder.admitPending()
    await settle(600)

    const [, b, c] = peers
    b.transport.setOffline(true)
    await settle(100)

    b.crdt.text().insert(0, 'hors-ligne ')
    c.crdt.text().insert(0, 'en-ligne ')
    await settle(400)

    // Pendant la coupure, chacun n'a que le sien.
    expect(b.crdt.text().toString()).toContain('hors-ligne')
    expect(b.crdt.text().toString()).not.toContain('en-ligne')
    expect(c.crdt.text().toString()).not.toContain('hors-ligne')

    b.transport.setOffline(false)
    await settle(900)

    const textes = peers.map((p) => p.crdt.text().toString())
    expect(new Set(textes).size).toBe(1)
    expect(textes[0]).toContain('hors-ligne')
    expect(textes[0]).toContain('en-ligne')
  })

  it('le revoque n ecrit plus chez les autres, et le contenu reste convergent', async () => {
    const { peers, founder } = await swarm(3)
    founder.admitPending()
    await settle(600)

    const [, b, c] = peers
    b.crdt.text().insert(0, 'avant ')
    await settle(400)

    founder.revoke(b.identity.signPub)
    await settle(700)
    expect(b.access()).toBeUndefined()

    b.crdt.text().insert(0, 'apres ')
    await settle(500)

    // Le revoque garde ce qu'il avait — irreductible, et assume. Mais rien de ce
    // qu'il ecrit ensuite n'entre chez les autres.
    expect(c.crdt.text().toString()).toContain('avant')
    expect(c.crdt.text().toString()).not.toContain('apres')
    expect(founder.crdt.text().toString()).toBe(c.crdt.text().toString())
  })

  it('un deuxieme canal du meme vault n echange aucune cle', async () => {
    const { peers, founder } = await swarm(2)
    founder.admitPending()
    await settle(600)
    const [a, b] = peers

    const avant = b.transport.stats.recv
    // Meme chaine, meme keyring : la cle du canal se derive, elle ne se demande pas.
    a.crdt.text().insert(0, 'canal applicatif ')
    await settle(500)
    expect(b.crdt.text().toString()).toBe('canal applicatif ')
    expect(b.transport.stats.recv - avant).toBeLessThan(12)
  })
})
