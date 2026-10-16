// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pair de demonstration : ce qu'une application doit ecrire pour se brancher
// sur EdgeSync. Volontairement sans DOM — les mini-apps l'habillent, et le test
// e2e du banc le fait tourner tel quel sous Node.
//
// La sequence est celle des tests d'integration d'EdgeSync (vault-fixture) :
// le fondateur porte le genesis, les autres arrivent SANS RIEN et rattrapent
// l'autorite puis la cle par le protocole. Rien n'est preprovisionne.
import { sha256 } from '@noble/hashes/sha2'
import {
  Access, AclChain, Keyring, OwnIdentity, PeerStore, Session, YjsCrdt,
  ROOT_GROUP, fromBase64, groupPrincipal, keyCommitment, keyPrincipal, randomBytes,
  resolveAccess, resourceId, signAclOp, toHex,
  type AclChange, type AclOp,
} from 'edgesync-protocol'
import { RelayTransport } from './relay-transport'

export const VAULT = 'edgesync-demo'
export const VAULT_ID = resourceId(VAULT)
/** La racine delegue a un GROUPE, jamais a un individu (D19). */
export const OWNERS = sha256(new TextEncoder().encode('owners-group'))

export const ACCESS_LABEL: Record<number, string> = {
  [Access.Pull]: 'pull', [Access.Read]: 'read', [Access.Write]: 'write', [Access.Manage]: 'manage',
}

function aclOp(issuer: OwnIdentity, group: Uint8Array, changes: AclChange[]): AclOp {
  return signAclOp(VAULT_ID, { group, changes, issuer: issuer.signPub }, (m) => issuer.sign(m))
}

/** Fonder : le fondateur est manage DANS le groupe des owners, la racine delegue
 *  a ce groupe, et il se declare arbitre (k=1). Le genesis s'engage sur
 *  sha256(K_vault) — jamais sur la cle. */
function foundVault(founder: OwnIdentity) {
  const vaultKey = randomBytes(32)
  const chain = AclChain.genesis(
    VAULT_ID,
    { signPub: founder.signPub, sign: (m: Uint8Array) => founder.sign(m) },
    [
      aclOp(founder, OWNERS, [{ t: 'set', principal: keyPrincipal(founder.signPub), access: Access.Manage }]),
      aclOp(founder, ROOT_GROUP, [
        { t: 'set', principal: groupPrincipal(OWNERS), access: Access.Manage },
        { t: 'arbiter', principal: keyPrincipal(founder.signPub), on: true },
      ]),
    ],
    keyCommitment(vaultKey),
  )
  const keyring = Keyring.empty()
  keyring.adopt(chain.head(), vaultKey, keyCommitment(vaultKey))
  return { chain, keyring }
}

export interface KnownPeerView {
  /** identifiant de LIEN (donne par le relais), pas une identite. */
  link: string
  signPub: Uint8Array
  short: string
  access: Access | undefined
}

export interface DemoPeer {
  identity: OwnIdentity
  transport: RelayTransport
  chain: AclChain
  keyring: Keyring
  /** La session du vault : autorite, chaine, cle. */
  vault: Session
  /** La session du canal applicatif (document ou base CRUD). */
  channel: Session
  crdt: YjsCrdt
  founder: boolean
  access(): Access | undefined
  knownPeers(): KnownPeerView[]
  /** Admet d'un seul coup tous les pairs vus et non encore membres (D35). */
  admitPending(access?: Access): number
  revoke(signPub: Uint8Array): void
  dispose(): void
}

export interface JoinOpts {
  /** ws://…  Par defaut : le relais qui sert la page. */
  url?: string
  /** Le canal applicatif, sous le vault. */
  channel: string
  onChange?: () => void
}

export async function joinDemo(opts: JoinOpts): Promise<DemoPeer> {
  const url = opts.url ?? defaultRelayUrl()
  const identity = OwnIdentity.generate()
  const transport = await RelayTransport.open(url)

  // Le premier connecte fonde ; les autres arrivent les mains vides.
  const { chain, keyring } = transport.founder
    ? foundVault(identity)
    : { chain: new AclChain(VAULT_ID), keyring: Keyring.empty() }

  const peers = new PeerStore()
  // Une seule connexion, plusieurs Sessions : c'est la forme reelle. La session
  // du vault porte l'autorite ; celle du canal ne voit que son resourceId.
  const vaultCrdt = new YjsCrdt()
  const vault = new Session({
    identity, crdt: vaultCrdt, keyring, chain, transport, peers, resource: VAULT,
  })
  const crdt = new YjsCrdt()
  const channel = new Session({
    identity, crdt, keyring, chain, transport, peers, resource: opts.channel,
  })

  transport.connect()

  const access = () => resolveAccess(chain.state(), identity.signPub)

  const knownPeers = (): KnownPeerView[] => {
    // NOTE DE BANC — PeerStore n'expose pas ses entrees ; serialize() est le seul
    // acces public. Une application qui affiche « qui est la » en a besoin : c'est
    // un manque de la surface d'EdgeSync (voir README, « ce que la demo a
    // trouve »), pas une raison d'aller lire dedans.
    const dump = JSON.parse(new TextDecoder().decode(peers.serialize())) as {
      peers: { id: string; signPub: string }[]
    }
    const state = chain.state()
    return dump.peers.map((p) => {
      const signPub = fromBase64(p.signPub)
      return {
        link: p.id,
        signPub,
        short: toHex(signPub).slice(0, 8),
        access: state && resolveAccess(state, signPub),
      }
    })
  }

  const admitPending = (level: Access = Access.Write): number => {
    const pending = knownPeers().filter((p) => p.access === undefined)
    if (pending.length === 0) return 0
    // Un seul op pour tout le monde : D35 mesure, dans bench/scale.ts, un facteur
    // 3 entre « une op chacun » et « un seul lot ».
    vault.requestAclChange(ROOT_GROUP, pending.map((p) => ({
      t: 'set' as const, principal: keyPrincipal(p.signPub), access: level,
    })))
    return pending.length
  }

  const revoke = (signPub: Uint8Array): void => {
    vault.requestAclChange(ROOT_GROUP, [{ t: 'remove', principal: keyPrincipal(signPub) }])
  }

  if (opts.onChange) transport.onChange = opts.onChange

  return {
    identity, transport, chain, keyring, vault, channel, crdt,
    founder: transport.founder,
    access, knownPeers, admitPending, revoke,
    dispose: () => { channel.dispose(); vault.dispose(); transport.close() },
  }
}

function defaultRelayUrl(): string {
  const loc = globalThis.location
  if (!loc) throw new Error('url du relais requise hors navigateur')
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}`
}
