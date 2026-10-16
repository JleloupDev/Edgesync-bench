// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un pair du laboratoire : une identite, une chaine, un keyring, une Session.
// Rien n'est partage entre deux pairs — sauf, pour un JUMEAU, ce qu'un jumeau
// partage par definition : les cles de celui qu'il double.
import {
  Access, AclChain, FloodBroadcast, Keyring, OwnIdentity, PeerStore, Session, YjsCrdt,
  resolveAccess, type AclOp, type Epoch, type IBroadcast,
} from 'edgesync-protocol'
import { VAULT, VAULT_ID, foundVault } from '../src/harness'
import type { SimNet, SimTransport } from './net'

export type Profil =
  | 'honnete'    // ecrit de temps en temps, repond a tout
  | 'bavard'     // ecrit sans arret
  | 'dormeur'    // se connecte, se synchronise, n'ecrit jamais
  | 'sourd'      // panne grise : il parle, il n'ecoute plus
  | 'inondeur'   // demande sans cesse des droits qu'il n'a pas (A9)
  | 'menteur'    // forge des trames bien formees : epoques, ops, cles
  | 'rejoueur'   // renvoie ce qu'il a capte sur le fil

export interface LabPeer {
  id: string
  identity: OwnIdentity
  chain: AclChain
  keyring: Keyring
  crdt: YjsCrdt
  session: Session
  transport: SimTransport
  profil: Profil
  /** Twins (arXiv:2004.10617) : ce pair porte l'identite d'un autre. */
  jumeauDe?: string
  ecrits: number
  /** Perd la memoire des messages deja vus, comme a un redemarrage : elle n'est
   *  pas persistee. Ce qu'elle bloquait par hasard redevient possible. */
  oublier(): void
  /** Arbitre : les decisions committees sur des membres qu'un autre avait
   *  modifies a l'insu de leur emetteur (ADR-0019). */
  conflits: AclOp[]
  /** Demandes signees mais retenues par le scenario, pour les livrer plus tard. */
  retenues: AclOp[]
  futMembre: boolean
  revoqueAuTick?: number
  access(): Access | undefined
  texte(): string
  dispose(): void
}

function creer(
  net: SimNet, id: string, identity: OwnIdentity, chain: AclChain, keyring: Keyring, profil: Profil,
): LabPeer {
  const crdt = new YjsCrdt()
  const transport = net.transport(id)
  // La strategie par defaut, mais remplacable a chaud : c'est ce qui permet a
  // `oublier` de simuler un redemarrage sans reconstruire la Session.
  let diffusion = new FloodBroadcast(transport)
  const broadcast: IBroadcast = {
    seen: (b) => diffusion.seen(b),
    spread: (b, from) => diffusion.spread(b, from),
  }
  const conflits: AclOp[] = []
  const session = new Session({
    identity, crdt, keyring, chain, transport, peers: new PeerStore(), resource: VAULT, broadcast,
    onAclConflict: (c) => { conflits.push(c.op) },
  })
  transport.sourd = profil === 'sourd'
  transport.connect()
  return {
    id, identity, chain, keyring, crdt, session, transport, profil,
    ecrits: 0, futMembre: false,
    access: () => resolveAccess(chain.state(), identity.signPub),
    texte: () => crdt.text().toString(),
    dispose: () => session.dispose(),
    oublier: () => { diffusion = new FloodBroadcast(transport) },
    conflits, retenues: [],
  }
}

/** Le fondateur : il porte le genesis, il est arbitre, il est seul a l'etre. */
export function fonder(net: SimNet, id: string, profil: Profil = 'honnete'): LabPeer {
  const identity = OwnIdentity.generate()
  const { chain, keyring } = foundVault(identity)
  return creer(net, id, identity, chain, keyring, profil)
}

/** Un arrivant : ni chaine, ni cle. Il rattrape tout par le protocole. */
export function rejoindre(net: SimNet, id: string, profil: Profil = 'honnete'): LabPeer {
  return creer(net, id, OwnIdentity.generate(), new AclChain(VAULT_ID), Keyring.empty(), profil)
}

/**
 * Un JUMEAU, au sens de Twins (Bano et al., arXiv:2004.10617) : la meme identite,
 * les memes cles, une VUE a lui. On n'ecrit aucune malveillance — on duplique un
 * pair honnete, et l'equivocation apparait toute seule : deux Sessions qui se
 * croient uniques signent chacune leur epoque a la meme hauteur.
 *
 * C'est la difference entre « tester un attaquant qu'on a imagine » et « tester
 * ce qu'un pair legitime dedouble produit ». Le second trouve ce qu'on n'a pas
 * imagine.
 */
export function jumeler(net: SimNet, source: LabPeer, id: string): LabPeer {
  const vue = new AclChain(VAULT_ID)
  for (const e of source.chain.all()) vue.adoptEpoch(e)
  // Le keyring est PARTAGE : un jumeau, ce sont deux appareils d'une meme
  // personne. Ce qui les separe, c'est ce qu'ils ont vu, pas ce qu'ils savent.
  const p = creer(net, id, source.identity, vue, source.keyring, 'honnete')
  p.jumeauDe = source.id
  return p
}

/** Les epoques que ce pair connait, pour les verificateurs. */
export function epoques(p: LabPeer): Epoch[] {
  return p.chain.all()
}
