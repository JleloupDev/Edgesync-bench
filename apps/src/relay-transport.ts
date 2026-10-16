// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// ITransport au-dessus du relais. C'est un ADAPTATEUR : il vit dans le banc, pas
// dans le protocole. Session ne sait rien de tout ceci — elle envoie a un
// identifiant de pair et recoit d'un identifiant de pair.
//
// Il ajoute deux choses que le banc veut et que le protocole n'a pas a offrir :
// le comptage des octets, et la coupure a la demande (partition simulee).
import type { ITransport, MessageHandler, PeerHandler } from 'edgesync-protocol'

export interface RelayStats {
  sent: number
  recv: number
  bytesSent: number
  bytesRecv: number
}

type Ctl =
  | { type: 'welcome'; id: string; founder: boolean; peers: string[] }
  | { type: 'up'; id: string }
  | { type: 'down'; id: string }
  | { type: 'peers'; peers: string[] }
  | { type: 'founder-gone' }

const enc = new TextEncoder()
const dec = new TextDecoder()

export class RelayTransport implements ITransport {
  private msg: MessageHandler[] = []
  private up: PeerHandler[] = []
  private down: PeerHandler[] = []
  private readonly known = new Set<string>()
  private started = false
  private offline = false

  readonly stats: RelayStats = { sent: 0, recv: 0, bytesSent: 0, bytesRecv: 0 }
  /** Le fondateur est parti : le genesis n'est plus servi par personne. */
  onFounderGone?: () => void
  onChange?: () => void

  private constructor(
    readonly localId: string,
    readonly founder: boolean,
    private readonly ws: WebSocket,
    peers: string[],
  ) {
    for (const p of peers) this.known.add(p)
    ws.onmessage = (ev: MessageEvent) => this.onWire(ev.data)
    ws.onclose = () => {
      for (const id of [...this.known]) this.fireDown(id)
      this.onChange?.()
    }
  }

  /** Ouvre le lien et attend l'accueil du relais : c'est lui qui nomme le pair. */
  static open(url: string): Promise<RelayTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.onerror = () => reject(new Error(`relais injoignable : ${url}`))
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return
        const m = JSON.parse(ev.data) as Ctl
        if (m.type !== 'welcome') return
        resolve(new RelayTransport(m.id, m.founder, ws, m.peers))
      }
    })
  }

  /** A appeler APRES la construction des Sessions, comme InProcessTransport. */
  connect(): void {
    this.started = true
    for (const id of this.known) for (const h of this.up) h(id)
    this.onChange?.()
  }

  /** Partition : le reseau tient ce pair pour absent, dans les deux sens. */
  setOffline(v: boolean): void {
    if (v === this.offline) return
    this.offline = v
    this.ws.send(JSON.stringify({ type: v ? 'offline' : 'online' }))
    if (v) {
      for (const id of [...this.known]) this.fireDown(id)
      this.known.clear()
    }
    this.onChange?.()
  }

  isOffline(): boolean { return this.offline }

  private onWire(data: unknown): void {
    if (typeof data === 'string') {
      const m = JSON.parse(data) as Ctl
      if (m.type === 'up') this.fireUp(m.id)
      else if (m.type === 'down') this.fireDown(m.id)
      else if (m.type === 'peers') for (const id of m.peers) this.fireUp(id)
      else if (m.type === 'founder-gone') this.onFounderGone?.()
      this.onChange?.()
      return
    }
    const bytes = new Uint8Array(data as ArrayBuffer)
    if (bytes.length < 1) return
    const fromLen = bytes[0]
    const from = dec.decode(bytes.subarray(1, 1 + fromLen))
    const payload = bytes.subarray(1 + fromLen)
    this.stats.recv++
    this.stats.bytesRecv += payload.length
    for (const h of this.msg) h(from, payload)
  }

  private fireUp(id: string): void {
    if (id === this.localId) return
    this.known.add(id)
    if (this.started) for (const h of this.up) h(id)
  }

  private fireDown(id: string): void {
    if (!this.known.delete(id)) return
    if (this.started) for (const h of this.down) h(id)
  }

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

  send(to: string, bytes: Uint8Array): void {
    if (this.offline || this.ws.readyState !== 1) return // trame perdue
    const dest = enc.encode(to)
    const out = new Uint8Array(1 + dest.length + bytes.length)
    out[0] = dest.length
    out.set(dest, 1)
    out.set(bytes, 1 + dest.length)
    this.ws.send(out)
    this.stats.sent++
    this.stats.bytesSent += bytes.length
  }

  peers(): string[] {
    return this.offline ? [] : [...this.known]
  }

  close(): void {
    this.ws.close()
  }
}
