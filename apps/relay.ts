// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le relais. Il est HORS du protocole (ADR-0002) : il ne connait ni vault, ni
// cle, ni ACL. Il attribue un identifiant de lien a chaque fenetre, dit a chacune
// qui est la, et recopie des octets qu'il ne peut pas lire.
//
// C'est le « super-pair » de la these : utile parce qu'un navigateur ne sait pas
// ecouter, inutile a la securite. Ce qu'il voit du trafic est exactement ce que
// verrait un fournisseur d'acces : des tailles et des horaires.
import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

export interface RelayHandle {
  close(): void
  readonly clients: number
}

interface Client {
  id: string
  ws: WebSocket
  /** Coupure simulee : le pair reste connecte au relais mais le reseau le tient
   *  pour absent. Les trames qui lui sont destinees sont PERDUES, pas mises en
   *  file — une partition ne bufferise pas. */
  online: boolean
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function startRelay(target: Server | number): RelayHandle {
  const wss = typeof target === 'number'
    ? new WebSocketServer({ port: target })
    : new WebSocketServer({ server: target })

  const clients = new Map<string, Client>()
  let seq = 0
  let founderId: string | undefined

  const control = (c: Client, msg: unknown) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg))
  }
  const others = (id: string) => [...clients.values()].filter((c) => c.id !== id && c.online)

  wss.on('connection', (ws) => {
    const id = `p${++seq}`
    // Le fondateur est le premier connecte (le vault n'existe nulle part
    // ailleurs). S'il s'en va, personne ne le remplace : le genesis part avec lui.
    const founder = clients.size === 0 && founderId === undefined
    if (founder) founderId = id

    const client: Client = { id, ws, online: true }
    ws.binaryType = 'nodebuffer'

    control(client, { type: 'welcome', id, founder, peers: others(id).map((c) => c.id) })
    clients.set(id, client)
    for (const o of others(id)) control(o, { type: 'up', id })

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        let msg: { type?: string }
        try { msg = JSON.parse(dec.decode(data)) } catch { return }
        if (msg.type === 'offline' && client.online) {
          client.online = false
          for (const o of others(id)) control(o, { type: 'down', id })
        } else if (msg.type === 'online' && !client.online) {
          client.online = true
          for (const o of others(id)) control(o, { type: 'up', id })
          control(client, { type: 'peers', peers: others(id).map((c) => c.id) })
        }
        return
      }
      if (!client.online) return // partition : la trame est perdue
      // client -> relais : [toLen][to][charge]
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      if (bytes.length < 1) return
      const toLen = bytes[0]
      const to = dec.decode(bytes.subarray(1, 1 + toLen))
      const payload = bytes.subarray(1 + toLen)
      const dest = clients.get(to)
      if (!dest || !dest.online || dest.ws.readyState !== WebSocket.OPEN) return
      // relais -> client : [fromLen][from][charge]. Le « from » est pose par le
      // relais, jamais par l'emetteur : un pair ne peut pas se faire passer pour
      // un autre au niveau du lien. (Ce qui ne prouve rien sur l'identite : c'est
      // le HELLO signe qui la porte.)
      const from = enc.encode(id)
      const out = new Uint8Array(1 + from.length + payload.length)
      out[0] = from.length
      out.set(from, 1)
      out.set(payload, 1 + from.length)
      dest.ws.send(out)
    })

    ws.on('close', () => {
      clients.delete(id)
      const gone = id === founderId
      for (const o of clients.values()) {
        control(o, { type: 'down', id })
        if (gone) control(o, { type: 'founder-gone' })
      }
    })
    ws.on('error', () => { /* le close suivra */ })
  })

  return {
    close: () => { for (const c of clients.values()) c.ws.close(); wss.close() },
    get clients() { return clients.size },
  }
}
