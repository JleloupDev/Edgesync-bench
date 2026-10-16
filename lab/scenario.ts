// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le langage de scenario. Emprunte a any-sync, dont la suite ACL se pilote par
// des lignes de texte (`a.invite::inv`, `b.join::inv`, `a.approve::b,rw`) : une
// discussion de specification devient un test d'une ligne, et un cas byzantin
// redevient lisible.
//
// Le scenario n'ecrit a la place de personne : il ne fait qu'injecter des
// evenements — couper, revoquer, dedoubler — dans un monde ou chaque pair decide
// seul. C'est la difference entre une chronologie rejouee et une chronologie
// produite.
import {
  Access, MsgType, ROOT_GROUP, aclOpId, encodeAclRequest, frame, keyPrincipal, signAclOp,
  type AclChange, type AclOp,
} from 'edgesync-protocol'
import { VAULT_ID } from '../src/harness'
import { Prng } from '../src/prng'
import { SimNet } from './net'
import { fonder, jumeler, rejoindre, type LabPeer, type Profil } from './peer'
import { agir } from './profiles'
import { verifier, type Verdict } from './checks'

export interface Cmd { n: number; verbe: string; args: string[] }

export function parse(texte: string): Cmd[] {
  const cmds: Cmd[] = []
  texte.split('\n').forEach((brut, i) => {
    const ligne = brut.split('#')[0].trim()
    if (!ligne) return
    const [verbe, ...args] = ligne.split(/\s+/)
    cmds.push({ n: i + 1, verbe, args })
  })
  return cmds
}

const NIVEAUX: Record<string, Access> = {
  pull: Access.Pull, read: Access.Read, write: Access.Write, manage: Access.Manage,
}

/** Un niveau, ou `retirer` : le changement qu'un admin demande sur une cible. */
function changement(cible: LabPeer, niveau: string): AclChange {
  return niveau === 'retirer'
    ? { t: 'remove', principal: keyPrincipal(cible.identity.signPub) }
    : { t: 'set', principal: keyPrincipal(cible.identity.signPub), access: NIVEAUX[niveau] ?? Access.Write }
}

/**
 * Une demande signee a la main, comme le ferait la Session (ADR-0019) : ancree
 * sur la tete que voit l'emetteur, chainee a sa precedente. Le scenario peut
 * ainsi choisir QUAND et DANS QUEL ORDRE elle arrive — ce que le reseau decide
 * d'habitude seul.
 */
function signer(par: LabPeer, changes: AclChange[], prev?: Uint8Array | null): AclOp {
  return signAclOp(VAULT_ID, {
    group: ROOT_GROUP, changes, issuer: par.identity.signPub, base: par.chain.head(),
    prev: prev === null ? undefined : prev ?? par.chain.latestOf(par.identity.signPub),
  }, (m) => par.identity.sign(m))
}

export interface Etat {
  tick: number
  pairs: LabPeer[]
  net: SimNet
  journal: string[]
}

export interface Rapport extends Etat {
  seed: number
  verdicts: Verdict[]
}

export interface Options {
  seed: number
  /** Appele apres chaque tick — c'est ce que l'affichage live consomme. */
  onTick?: (e: Etat) => void | Promise<void>
}

export async function jouer(cmds: Cmd[], opts: Options): Promise<Rapport> {
  const rng = new Prng(opts.seed)
  const net = new SimNet(rng)
  const pairs: LabPeer[] = []
  const journal: string[] = []
  const verdicts: Verdict[] = []
  const par = (id: string) => pairs.find((p) => p.id === id)
  const note = (s: string) => { journal.push(`t${String(net.tick).padStart(4)} · ${s}`) }
  const fondateur = () => pairs[0]
  const etat = (): Etat => ({ tick: net.tick, pairs, net, journal })
  const livrer = (de: LabPeer, op: AclOp) => de.transport.send(fondateur().id, frame(MsgType.AclRequest, encodeAclRequest(op)))
  const tourner = async (n: number) => {
    for (let i = 0; i < n; i++) {
      // L'ordre dans lequel les pairs agissent est tire, lui aussi : deux
      // ecritures « simultanees » n'ont pas d'ordre naturel.
      for (const p of rng.shuffle([...pairs])) agir(p, { net, rng, tick: net.tick, pairs })
      net.step()
      if (opts.onTick) await opts.onTick(etat())
    }
  }

  for (const c of cmds) {
    switch (c.verbe) {
      case 'pairs': {
        const n = Number(c.args[0] ?? 3)
        const profil = (c.args[1] ?? 'honnete') as Profil
        pairs.push(fonder(net, 'p0'))
        for (let i = 1; i < n; i++) pairs.push(rejoindre(net, `p${i}`, profil))
        note(`${n} pairs, p0 fonde le vault (profil des autres : ${profil})`)
        break
      }

      case 'profil': {
        const p = par(c.args[0])
        if (!p) break
        p.profil = c.args[1] as Profil
        p.transport.sourd = p.profil === 'sourd'
        note(`${p.id} devient ${p.profil}`)
        break
      }

      case 'admettre': {
        const niveau = NIVEAUX[c.args[c.args.length - 1]] ?? Access.Write
        const cibles = c.args[0] === '*'
          ? pairs.filter((p) => p !== fondateur() && p.access() === undefined)
          : c.args.filter((a) => NIVEAUX[a] === undefined).map(par).filter((p): p is LabPeer => !!p)
        if (!cibles.length) break
        // Un seul op pour tout le monde (D35).
        fondateur().session.requestAclChange(ROOT_GROUP, cibles.map((p) => ({
          t: 'set' as const, principal: keyPrincipal(p.identity.signPub), access: niveau,
        })))
        note(`admission de ${cibles.map((p) => p.id).join(' ')} en un lot`)
        break
      }

      case 'revoquer': {
        const cibles = c.args.map(par).filter((p): p is LabPeer => !!p)
        fondateur().session.requestAclChange(ROOT_GROUP, cibles.map((p) => ({
          t: 'remove' as const, principal: keyPrincipal(p.identity.signPub),
        })))
        for (const p of cibles) p.revoqueAuTick = net.tick
        note(`revocation de ${cibles.map((p) => p.id).join(' ')} (rotation de cle)`)
        break
      }

      case 'arbitre': {
        const p = par(c.args[0])
        if (!p) break
        const on = c.args[1] !== 'off'
        fondateur().session.requestAclChange(ROOT_GROUP, [
          { t: 'arbiter', principal: keyPrincipal(p.identity.signPub), on },
        ])
        note(`${p.id} ${on ? 'devient' : 'cesse d\'etre'} arbitre`)
        break
      }

      case 'couper':
        for (const id of c.args) net.couper(id)
        note(`coupure : ${c.args.join(' ')}`)
        break

      case 'retablir':
        for (const id of c.args) net.retablir(id)
        note(`retour : ${c.args.join(' ')}`)
        break

      case 'jumeau': {
        // Twins : on ne programme aucune malveillance, on DEDOUBLE un pair. Le
        // jumeau mine aussitot sa propre epoque a la meme hauteur que l'original.
        const src = par(c.args[0])
        if (!src) break
        const t = jumeler(net, src, `${src.id}~`)
        pairs.push(t)
        const victime = pairs.find((p) => p !== src && p !== t && p.access() === undefined) ?? pairs[pairs.length - 2]
        t.session.requestAclChange(ROOT_GROUP, [
          { t: 'set', principal: keyPrincipal(victime.identity.signPub), access: Access.Read },
        ])
        note(`${t.id} : jumeau de ${src.id} (memes cles, vue separee) — il mine sa propre epoque`)
        break
      }

      // Rejouer une demande ACL captee : elle est signee, elle est valide, elle
      // n'a ni date ni position. Rien n'empeche l'arbitre de la remettre au vote.
      case 'rejouer-acl': {
        const emetteur = par(c.args[0])
        const cible = par(c.args[1] ?? 'p0')
        const trame = net.premiereTrame(MsgType.AclRequest)
        if (!emetteur || !cible || !trame) { note('rejeu impossible : rien de capte'); break }
        emetteur.transport.send(cible.id, trame)
        note(`${emetteur.id} rejoue vers ${cible.id} une demande ACL captee`)
        break
      }

      // Un redemarrage, vu du gossip : la memoire des messages deja vus n'est pas
      // persistee. Tout ce qu'elle arretait par hasard repasse.
      case 'oublier': {
        const cibles = c.args.map(par).filter((p): p is LabPeer => !!p)
        for (const p of cibles) p.oublier()
        note(`${cibles.map((p) => p.id).join(' ')} oublie les messages deja vus (redemarrage)`)
        break
      }

      case 'latence':
        net.opts.latence = [Number(c.args[0] ?? 1), Number(c.args[1] ?? 3)]
        note(`latence ${net.opts.latence.join('-')} ticks`)
        break

      case 'perte':
        net.opts.perte = Number(c.args[0] ?? 0)
        note(`perte ${(net.opts.perte * 100).toFixed(0)} %`)
        break

      case 'tourne':
        await tourner(Number(c.args[0] ?? 10))
        break

      // Un admin qui decide, par sa propre Session : `decider p1 p3 manage`.
      case 'decider': {
        const [de, cible] = [par(c.args[0]), par(c.args[1])]
        if (!de || !cible) break
        de.session.requestAclChange(ROOT_GROUP, [changement(cible, c.args[2] ?? 'write')])
        note(`${de.id} demande ${c.args[2] ?? 'write'} pour ${cible.id}`)
        break
      }

      // Plusieurs decisions d'un meme admin sur une cible, signees dans l'ordre,
      // livrees A L'ENVERS a l'arbitre : `rafale p1 p3 read write manage`. Le
      // backlink doit remettre l'ordre voulu ; sans lui, la premiere signee
      // passerait en dernier et ecraserait les autres.
      case 'rafale': {
        const [de, cible] = [par(c.args[0]), par(c.args[1])]
        if (!de || !cible) break
        const ops: AclOp[] = []
        let prev = de.chain.latestOf(de.identity.signPub) ?? null
        for (const niveau of c.args.slice(2)) {
          const op = signer(de, [changement(cible, niveau)], prev)
          ops.push(op)
          prev = aclOpId(op)
        }
        for (const op of [...ops].reverse()) livrer(de, op)
        note(`${de.id} signe ${c.args.slice(2).join(' puis ')} pour ${cible.id}, livres a l'envers`)
        break
      }

      // Deux admins decident sur la meme cible, chacun sans avoir vu l'autre :
      // `concurrence p1 p2 p3 read manage`. Rien n'est faux, mais l'ordre de
      // l'arbitre tranche seul : il doit au moins le signaler.
      case 'concurrence': {
        const [a, b, cible] = [par(c.args[0]), par(c.args[1]), par(c.args[2])]
        if (!a || !b || !cible) break
        const opA = signer(a, [changement(cible, c.args[3] ?? 'read')])
        const opB = signer(b, [changement(cible, c.args[4] ?? 'manage')])
        livrer(a, opA)
        livrer(b, opB)
        note(`${a.id} et ${b.id} decident en meme temps sur ${cible.id}`)
        break
      }

      // Signer maintenant, livrer plus tard : `preparer p1 p3 manage` … `livrer p1`.
      case 'preparer': {
        const [de, cible] = [par(c.args[0]), par(c.args[1])]
        if (!de || !cible) break
        de.retenues.push(signer(de, [changement(cible, c.args[2] ?? 'write')]))
        note(`${de.id} signe ${c.args[2] ?? 'write'} pour ${cible.id} et le garde`)
        break
      }

      case 'livrer': {
        const de = par(c.args[0])
        if (!de) break
        for (const op of de.retenues.splice(0)) livrer(de, op)
        note(`${de.id} livre ses demandes retenues`)
        break
      }

      // Une equivocation d'emetteur : deux decisions differentes derriere la
      // meme precedente. `fourche p1 p3 read write` — la seconde ne doit jamais
      // s'appliquer.
      case 'fourche': {
        const [de, cible] = [par(c.args[0]), par(c.args[1])]
        if (!de || !cible) break
        const prev = de.chain.latestOf(de.identity.signPub) ?? null
        for (const niveau of c.args.slice(2)) livrer(de, signer(de, [changement(cible, niveau)], prev))
        note(`${de.id} signe ${c.args.slice(2).join(' et ')} pour ${cible.id} derriere la meme precedente`)
        break
      }

      // Des retraits de droits reguliers, donc des rotations en serie :
      // `rotations 30 4`. A chaque cycle, un membre lecteur tire au hasard passe
      // sous `read` (la cle tourne), puis revient en `write` ; entre les deux, le
      // reseau vit normalement. Le scenario mesure ce que ça coute de tenir.
      case 'rotations': {
        const n = Number(c.args[0] ?? 10)
        const ticks = Number(c.args[1] ?? 4)
        let faites = 0
        for (let i = 0; i < n; i++) {
          const candidats = pairs.filter((p) => p !== fondateur() && (p.access() ?? -1) >= Access.Read)
          if (!candidats.length) break
          const cible = candidats[Math.floor(rng.next() * candidats.length)]
          fondateur().session.requestAclChange(ROOT_GROUP, [changement(cible, 'pull')])
          await tourner(ticks)
          fondateur().session.requestAclChange(ROOT_GROUP, [changement(cible, 'write')])
          await tourner(ticks)
          faites++
        }
        note(`${faites} cycles retrogradation / retour, une rotation de cle chacun`)
        break
      }

      case 'apaiser': {
        // Personne n'ecrit plus, on laisse le fil se vider. Sans cette etape,
        // comparer deux pairs ne prouve rien.
        const n = Number(c.args[0] ?? 60)
        for (let i = 0; i < n; i++) {
          net.step()
          if (opts.onTick) await opts.onTick(etat())
        }
        break
      }

      case 'attendre': {
        net.drain()
        const v = verifier(c.args[0], c.args.slice(1), { pairs, net })
        verdicts.push(v)
        note(`${v.ok ? '✓' : '✗'} ${v.nom} — ${v.detail}`)
        break
      }

      // Une BORNE connue : ce verdict ne tient pas aujourd'hui, et le scenario
      // le dit. Le jour ou il tiendra, ce fichier echouera — c'est exactement ce
      // qu'on veut d'une limite documentee : qu'elle previenne quand elle tombe.
      case 'attendre-pas': {
        net.drain()
        const v = verifier(c.args[0], c.args.slice(1), { pairs, net })
        const inverse = {
          nom: `${v.nom} (borne connue, ne tient pas)`,
          ok: !v.ok,
          detail: v.ok ? `TIENT DESORMAIS — mettre le scenario a jour : ${v.detail}` : v.detail,
        }
        verdicts.push(inverse)
        note(`${inverse.ok ? '✓' : '✗'} ${inverse.nom} — ${inverse.detail}`)
        break
      }

      default:
        note(`ligne ${c.n} : verbe inconnu « ${c.verbe} »`)
    }
  }

  for (const p of pairs) p.dispose()
  return { ...etat(), seed: opts.seed, verdicts }
}
