// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'AUTONOMIE des pairs. Chaque pair decide seul, a chaque tick, ce qu'il fait —
// le scenario ne pilote personne, il ne fait qu'injecter des evenements dans le
// monde. C'est ce qui separe un banc d'un script : le script rejoue une
// chronologie, le banc produit des chronologies qu'on n'a pas ecrites.
//
// Les byzantins ne sont pas des « bugs deguises » : chacun envoie des trames
// PARFAITEMENT formees et correctement signees. Un frame malforme ne prouve
// rien ; ce qu'il faut prouver, c'est qu'un message impeccable venant du mauvais
// principal ne passe pas.
import {
  Access, ROOT_GROUP, MsgType, encodeAclRequest, encodeEnvelope, encodeEpochPush,
  encrypt, epochId, frame, keyPrincipal, randomBytes, resourceId, signAclOp,
  signedRegion, signEpoch,
} from 'edgesync-protocol'
import type { Prng } from '../src/prng'
import { VAULT_ID } from '../src/harness'
import type { SimNet } from './net'
import type { LabPeer, Profil } from './peer'

export const BYZANTINS: Profil[] = ['sourd', 'inondeur', 'menteur', 'rejoueur']

export interface Ctx {
  net: SimNet
  rng: Prng
  tick: number
  pairs: LabPeer[]
}

/** Le marqueur d'ecriture porte l'auteur ET son etat de droit : `p3.7` a ete
 *  ecrit membre, `p3!7` a ete ecrit APRES revocation. Un verificateur n'a plus
 *  qu'a chercher un `!` dans le texte des autres. */
export function ecrire(p: LabPeer, rng: Prng): void {
  const t = p.crdt.text()
  const revoque = p.futMembre && p.access() === undefined
  const marque = `${p.id}${revoque ? '!' : '.'}${++p.ecrits} `
  if (t.length > 8000) t.delete(0, 4000)
  t.insert(rng.int(t.length + 1), marque)
}

export function agir(p: LabPeer, ctx: Ctx): void {
  if (p.access() !== undefined) p.futMembre = true
  const { rng } = ctx
  switch (p.profil) {
    case 'dormeur':
      return
    case 'bavard':
      if (rng.chance(0.85)) ecrire(p, rng)
      return
    case 'honnete':
    case 'sourd':
      if (rng.chance(0.3)) ecrire(p, rng)
      return
    case 'inondeur':
      // A9 : la demande ne coute rien a l'emetteur, et la verification coute a
      // tout le monde. L'arbitre doit n'en committer aucune.
      if (rng.chance(0.8)) {
        p.session.requestAclChange(ROOT_GROUP, [
          { t: 'set', principal: keyPrincipal(p.identity.signPub), access: Access.Manage },
        ])
      }
      return
    case 'menteur':
      if (rng.chance(0.5)) mentir(p, ctx)
      if (rng.chance(0.2)) ecrire(p, rng)
      return
    case 'rejoueur': {
      if (!rng.chance(0.6)) return
      const bytes = ctx.net.captureAleatoire(rng)
      const cible = autrePair(p, ctx)
      if (bytes && cible) p.transport.send(cible.id, bytes)
      return
    }
  }
}

function autrePair(p: LabPeer, ctx: Ctx): LabPeer | undefined {
  const autres = ctx.pairs.filter((x) => x.id !== p.id)
  return autres.length ? ctx.rng.pick(autres) : undefined
}

/** Trois mensonges, tous bien formes, tous signes par une vraie cle. */
function mentir(p: LabPeer, ctx: Ctx): void {
  const cible = autrePair(p, ctx)
  if (!cible) return
  const quoi = ctx.rng.int(3)

  if (quoi === 0 && p.chain.height() > 0) {
    // Une epoque qu'il n'a pas le droit de miner : il n'est pas arbitre.
    const draft = {
      prev: p.chain.head(), height: p.chain.height() + 1, round: 0,
      ops: [signAclOp(VAULT_ID, {
        group: ROOT_GROUP,
        changes: [{ t: 'set' as const, principal: keyPrincipal(p.identity.signPub), access: Access.Manage }],
        issuer: p.identity.signPub,
      }, (m) => p.identity.sign(m))],
      keyCommit: undefined,
    }
    const e = signEpoch(VAULT_ID, draft, p.identity.signPub, (m) => p.identity.sign(m))
    epochId(draft) // meme calcul que le destinataire fera
    p.transport.send(cible.id, frame(MsgType.EpochPush, encodeEpochPush(e)))
    return
  }

  if (quoi === 1) {
    // Une op parfaitement signee… pour un AUTRE vault. La separation de domaine
    // est la seule chose qui la refuse.
    const op = signAclOp(resourceId('un-autre-vault'), {
      group: ROOT_GROUP,
      changes: [{ t: 'set', principal: keyPrincipal(p.identity.signPub), access: Access.Manage }],
      issuer: p.identity.signPub,
    }, (m) => p.identity.sign(m))
    p.transport.send(cible.id, frame(MsgType.AclRequest, encodeAclRequest(op)))
    return
  }

  // Du contenu scelle sous une cle qu'il a inventee, a une position valide.
  const pos = p.chain.head()
  const { nonce, ciphertext } = encrypt(randomBytes(32), new TextEncoder().encode(`${p.id} ment`))
  const sig = p.identity.sign(signedRegion(VAULT_ID, pos, nonce, ciphertext))
  p.transport.send(cible.id, frame(MsgType.Op, encodeEnvelope({
    resourceId: VAULT_ID, epochId: pos, nonce, ciphertext, sig, signerPub: p.identity.signPub,
  })))
}
