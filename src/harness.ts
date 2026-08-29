// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// The swarm harness: stand up N peers on one bus and measure what the protocol
// actually costs. Everything here uses the PUBLIC surface of edgesync-protocol —
// if a scenario needs internals, that is a signal the surface is wrong, not a
// reason to reach inside.
import { sha256 } from '@noble/hashes/sha2'
import {
  OwnIdentity, YjsCrdt, Bus, InProcessTransport, PeerStore, Session, Keyring,
  keyCommitment, AclChain, Access, ROOT_GROUP, signAclOp, keyPrincipal, groupPrincipal,
  resolveAccess, randomBytes, resourceId,
  type AclChange, type AclOp,
} from 'edgesync-protocol'

export const VAULT = 'bench-vault'
export const VAULT_ID = resourceId(VAULT)
export const OWNERS = sha256(new TextEncoder().encode('owners-group'))

export const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

export function aclOp(issuer: OwnIdentity, group: Uint8Array, changes: AclChange[]): AclOp {
  return signAclOp(VAULT_ID, { group, changes, issuer: issuer.signPub }, (m) => issuer.sign(m))
}

export interface Peer {
  id: string
  identity: OwnIdentity
  chain: AclChain
  keyring: Keyring
  crdt: YjsCrdt
  session: Session
  transport: InProcessTransport
  text(): string
  access(): Access | undefined
  dispose(): void
}

/**
 * Found a vault. The founder is manage inside the owners GROUP and the root
 * delegates to that group — never to an individual, or the founder would be
 * frozen in place for the life of the vault.
 */
export function foundVault(founder: OwnIdentity, extra: { signPub: Uint8Array; access: Access }[] = []) {
  const vaultKey = randomBytes(32)
  const chain = AclChain.genesis(
    VAULT_ID,
    { signPub: founder.signPub, sign: (m: Uint8Array) => founder.sign(m) },
    [
      aclOp(founder, OWNERS, [{ t: 'set', principal: keyPrincipal(founder.signPub), access: Access.Manage }]),
      aclOp(founder, ROOT_GROUP, [
        { t: 'set', principal: groupPrincipal(OWNERS), access: Access.Manage },
        { t: 'arbiter', principal: keyPrincipal(founder.signPub), on: true },
        ...extra.map((m) => ({ t: 'set' as const, principal: keyPrincipal(m.signPub), access: m.access })),
      ]),
    ],
    keyCommitment(vaultKey),
  )
  const keyring = Keyring.empty()
  keyring.adopt(chain.head(), vaultKey, keyCommitment(vaultKey))
  return { chain, keyring, vaultKey }
}

export function makePeer(
  id: string, bus: Bus, chain: AclChain, keyring: Keyring, identity = OwnIdentity.generate(),
): Peer {
  const crdt = new YjsCrdt()
  const transport = new InProcessTransport(id, bus)
  const session = new Session({
    identity, crdt, keyring, chain, transport, peers: new PeerStore(), resource: VAULT,
  })
  transport.connect()
  return {
    id, identity, chain, keyring, crdt, session, transport,
    text: () => crdt.text().toString(),
    access: () => resolveAccess(chain.state(), identity.signPub),
    dispose: () => session.dispose(),
  }
}

/** A peer that has nothing yet: no chain, no key. It must catch up on both. */
export function joiner(bus: Bus, id: string, identity = OwnIdentity.generate()): Peer {
  return makePeer(id, bus, new AclChain(VAULT_ID), Keyring.empty(), identity)
}

export interface Swarm {
  bus: Bus
  founder: Peer
  members: Peer[]
  all(): Peer[]
  dispose(): void
}

/**
 * A founder plus `n` joiners, none of them admitted yet. Admitting them is a
 * scenario in itself — that is what most of the measurements are about.
 */
export function makeSwarm(n: number): Swarm {
  const bus = new Bus()
  const founderId = OwnIdentity.generate()
  const { chain, keyring } = foundVault(founderId)
  const founder = makePeer('founder', bus, chain, keyring, founderId)
  const members = Array.from({ length: n }, (_, i) => joiner(bus, `peer-${i}`))
  return {
    bus, founder, members,
    all: () => [founder, ...members],
    dispose: () => { founder.dispose(); for (const m of members) m.dispose() },
  }
}

// ── Measurement ─────────────────────────────────────────────────────────────

export interface Measurement {
  label: string
  ms: number
  frames: number
  bytes: number
}

/**
 * Measure one span of protocol activity. The Bus records every byte that crosses
 * it, so "what did this cost on the wire" needs no instrumentation of its own.
 */
export async function measure(bus: Bus, label: string, fn: () => void | Promise<void>, quiet = 200): Promise<Measurement> {
  const frames0 = bus.wire.length
  let bytes0 = 0
  for (const f of bus.wire) bytes0 += f.length

  const t0 = performance.now()
  await fn()
  await settle(quiet)
  const ms = performance.now() - t0

  let bytes = 0
  for (let i = frames0; i < bus.wire.length; i++) bytes += bus.wire[i].length
  return { label, ms, frames: bus.wire.length - frames0, bytes }
}

export function report(rows: Measurement[]): void {
  const pad = (s: string, n: number) => s.padEnd(n)
  const num = (n: number, d = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: d })
  const w = Math.max(...rows.map((r) => r.label.length), 8)
  console.log(`\n${pad('scénario', w)}  ${'ms'.padStart(8)}  ${'frames'.padStart(8)}  ${'octets'.padStart(12)}`)
  console.log('─'.repeat(w + 34))
  for (const r of rows) {
    console.log(`${pad(r.label, w)}  ${num(r.ms).padStart(8)}  ${num(r.frames).padStart(8)}  ${num(r.bytes).padStart(12)}`)
  }
  console.log()
}
