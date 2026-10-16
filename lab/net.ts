// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le reseau du laboratoire. Le `Bus` d'EdgeSync livre en microtache, dans
// l'ordre, sans jamais rien perdre : c'est un reseau de reve, et un reseau de
// reve ne trouve rien.
//
// Ici, rien ne part tout seul. Chaque trame attend son tick, la livraison se
// fait dans un ordre TIRE (Fisher-Yates seme), et le reseau sait perdre, retenir
// et couper. Toute la non-determinisme du banc passe par une seule graine — un
// echec se rejoue avec `--seed`.
//
// C'est le modele de tests/testHelper.js chez Yjs (files par destinataire,
// flushRandomMessage, disconnectRandom) porte sur ITransport, plus ce que Yjs
// n'a pas a simuler : la perte, et la coupure asymetrique.
import type { ITransport, MessageHandler, PeerHandler } from 'edgesync-protocol'
import { Prng } from '../src/prng'

export interface NetOpts {
  /** bornes de latence, en ticks */
  latence: [number, number]
  /** probabilite de perte pure par trame */
  perte: number
}

interface Frame { from: string; to: string; bytes: Uint8Array; at: number }

export class SimNet {
  private readonly nodes = new Map<string, SimTransport>()
  private queue: Frame[] = []
  private readonly coupes = new Set<string>()
  private readonly capture: Uint8Array[] = []
  /** Une trame par type, gardee sans limite de temps : un espion patient ne
   *  jette rien, et les demandes ACL sont rares. */
  private readonly parType = new Map<number, Uint8Array[]>()

  tick = 0
  readonly stats = { emises: 0, livrees: 0, perdues: 0, octets: 0 }

  constructor(readonly rng: Prng, readonly opts: NetOpts = { latence: [1, 3], perte: 0 }) {}

  transport(id: string): SimTransport {
    const t = new SimTransport(id, this)
    return t
  }

  /** Brancher APRES la construction des Sessions (comme InProcessTransport). */
  register(t: SimTransport): void {
    const autres = [...this.nodes.values()]
    this.nodes.set(t.localId, t)
    for (const o of autres) {
      o.firePeerUp(t.localId)
      t.firePeerUp(o.localId)
    }
  }

  send(from: string, to: string, bytes: Uint8Array): void {
    this.stats.emises++
    this.stats.octets += bytes.length
    // Le rejoueur puise la-dedans : ce qu'un espion sur le fil aurait garde.
    if (this.capture.length > 512) this.capture.shift()
    this.capture.push(bytes)
    if (bytes.length > 0) {
      const t = bytes[0]
      const l = this.parType.get(t) ?? []
      if (l.length < 64) { l.push(bytes); this.parType.set(t, l) }
    }
    if (this.coupes.has(from) || this.coupes.has(to)) { this.stats.perdues++; return }
    if (this.opts.perte > 0 && this.rng.chance(this.opts.perte)) { this.stats.perdues++; return }
    const [lo, hi] = this.opts.latence
    this.queue.push({ from, to, bytes, at: this.tick + lo + this.rng.int(Math.max(1, hi - lo + 1)) })
  }

  /** Un tick : on livre ce qui est du, dans un ordre tire au sort. */
  step(): number {
    const du: Frame[] = []
    const reste: Frame[] = []
    for (const f of this.queue) (f.at <= this.tick ? du : reste).push(f)
    this.queue = reste
    this.rng.shuffle(du)
    for (const f of du) {
      const n = this.nodes.get(f.to)
      if (!n || this.coupes.has(f.to) || this.coupes.has(f.from)) { this.stats.perdues++; continue }
      this.stats.livrees++
      n.fireMessage(f.from, f.bytes)
    }
    this.tick++
    return du.length
  }

  /** Vider le reseau : c'est l'etape « on laisse le trafic se taire » sans
   *  laquelle comparer deux pairs ne prouve rien. */
  drain(maxTicks = 400): void {
    let n = maxTicks
    while (this.queue.length > 0 && n-- > 0) this.step()
  }

  couper(id: string): void {
    if (this.coupes.has(id)) return
    this.coupes.add(id)
    const t = this.nodes.get(id)
    for (const o of this.nodes.values()) {
      if (o.localId === id) continue
      o.firePeerDown(id)
      t?.firePeerDown(o.localId)
    }
  }

  retablir(id: string): void {
    if (!this.coupes.delete(id)) return
    const t = this.nodes.get(id)
    for (const o of this.nodes.values()) {
      if (o.localId === id) continue
      o.firePeerUp(id)
      t?.firePeerUp(o.localId)
    }
  }

  estCoupe(id: string): boolean { return this.coupes.has(id) }
  pairs(id: string): string[] {
    if (this.coupes.has(id)) return []
    return [...this.nodes.keys()].filter((x) => x !== id && !this.coupes.has(x))
  }
  /** Ce qu'un espion garderait du fil, pour le rejouer plus tard. */
  captureAleatoire(rng: Prng): Uint8Array | undefined {
    return this.capture.length ? rng.pick(this.capture) : undefined
  }

  /** La premiere trame captee d'un type donne (l'octet 0 est le type). */
  premiereTrame(type: number): Uint8Array | undefined {
    return this.parType.get(type)?.[0]
  }
  enVol(): number { return this.queue.length }
}

export class SimTransport implements ITransport {
  private msg: MessageHandler[] = []
  private up: PeerHandler[] = []
  private down: PeerHandler[] = []
  /** Panne grise : il parle, il n'ecoute plus. Le plus mechant des pairs n'est
   *  pas celui qui ment, c'est celui qui a l'air vivant. */
  sourd = false

  constructor(readonly localId: string, private readonly net: SimNet) {}

  connect(): void { this.net.register(this) }

  onMessage(cb: MessageHandler): () => void {
    this.msg.push(cb)
    return () => { this.msg = this.msg.filter((h) => h !== cb) }
  }
  onPeerUp(cb: PeerHandler): () => void {
    this.up.push(cb)
    return () => { this.up = this.up.filter((h) => h !== cb) }
  }
  onPeerDown(cb: PeerHandler): () => void {
    this.down.push(cb)
    return () => { this.down = this.down.filter((h) => h !== cb) }
  }

  send(to: string, bytes: Uint8Array): void { this.net.send(this.localId, to, bytes) }
  peers(): string[] { return this.net.pairs(this.localId) }

  fireMessage(from: string, bytes: Uint8Array): void {
    if (this.sourd) return
    for (const h of this.msg) h(from, bytes)
  }
  firePeerUp(id: string): void { for (const h of this.up) h(id) }
  firePeerDown(id: string): void { for (const h of this.down) h(id) }
}
