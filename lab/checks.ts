// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les verdicts. Un scenario sans verdict est une animation ; ce sont ces
// fonctions qui en font un test.
//
// Deux precautions valent tout le reste : on ne compare QUE des pairs qui ont
// encore le droit de lire (un revoque diverge legitimement, c'est meme le but),
// et on ne compare qu'apres avoir laisse le reseau se taire.
import { Access, resolveAccess, toHex } from 'edgesync-protocol'
import { VAULT_ID } from '../src/harness'
import type { SimNet } from './net'
import type { LabPeer } from './peer'

export interface Verdict { nom: string; ok: boolean; detail: string }
export interface Monde { pairs: LabPeer[]; net: SimNet }

const empreinte = (s: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16).padStart(8, '0')
}

export const empreinteDe = (p: LabPeer): string => empreinte(p.texte())

/** Qui a le droit d'etre compare : membre lecteur, en ligne, et qui ecoute. */
function comparables(m: Monde): LabPeer[] {
  return m.pairs.filter((p) =>
    (p.access() ?? -1) >= Access.Read && !m.net.estCoupe(p.id) && p.profil !== 'sourd')
}

export function verifier(nom: string, args: string[], m: Monde): Verdict {
  switch (nom) {
    case 'converge': {
      const c = comparables(m)
      const groupes = new Map<string, string[]>()
      for (const p of c) {
        const e = empreinteDe(p)
        groupes.set(e, [...(groupes.get(e) ?? []), p.id])
      }
      const ok = groupes.size <= 1
      return {
        nom: 'converge', ok,
        detail: ok
          ? `${c.length} pairs lecteurs, une seule empreinte ${[...groupes.keys()][0] ?? '(vide)'}`
          : [...groupes.entries()].map(([e, ids]) => `${e} : ${ids.join(' ')}`).join(' | '),
      }
    }

    case 'chaine-unique': {
      const c = m.pairs.filter((p) => p.chain.height() > 0 && !m.net.estCoupe(p.id) && p.profil !== 'sourd')
      const tetes = new Map<string, string[]>()
      for (const p of c) {
        const t = `h=${p.chain.height()} ${toHex(p.chain.head()).slice(0, 8)}`
        tetes.set(t, [...(tetes.get(t) ?? []), p.id])
      }
      const ok = tetes.size <= 1
      return {
        nom: 'chaine-unique', ok,
        detail: ok ? `${c.length} pairs sur ${[...tetes.keys()][0] ?? '(rien)'}`
          : [...tetes.entries()].map(([t, ids]) => `${t} : ${ids.join(' ')}`).join(' | '),
      }
    }

    case 'aucun-ecrit-de': {
      const cible = args[0]
      const marque = `${cible}!`
      const coupables = m.pairs
        .filter((p) => p.id !== cible && p.jumeauDe !== cible)
        .filter((p) => p.texte().includes(marque))
        .map((p) => p.id)
      return {
        nom: `aucun-ecrit-de ${cible}`, ok: coupables.length === 0,
        detail: coupables.length ? `${marque} a atteint ${coupables.join(' ')}` : `rien de ${marque} nulle part`,
      }
    }

    case 'aucune-epoque-de': {
      const cible = m.pairs.find((p) => p.id === args[0])
      if (!cible) return { nom: `aucune-epoque-de ${args[0]}`, ok: false, detail: 'pair inconnu' }
      const sien = toHex(cible.identity.signPub)
      let n = 0
      for (const p of m.pairs) {
        for (const e of p.chain.all()) {
          if (e.sigs.some((s) => toHex(s.signer) === sien)) n++
        }
      }
      return {
        nom: `aucune-epoque-de ${args[0]}`, ok: n === 0,
        detail: n === 0 ? 'aucune epoque signee par lui n\'est entree' : `${n} epoques signees par lui ont ete adoptees`,
      }
    }

    case 'tous-membres': {
      const dehors = m.pairs.filter((p) => p.access() === undefined).map((p) => p.id)
      return {
        nom: 'tous-membres', ok: dehors.length === 0,
        detail: dehors.length ? `hors du vault : ${dehors.join(' ')}` : `${m.pairs.length} pairs admis`,
      }
    }

    case 'cle-commune': {
      const c = comparables(m)
      const cles = new Set<string>()
      for (const p of c) {
        const ke = p.chain.keyEpochAt(p.chain.head())
        const k = ke && p.keyring.docKey(ke, VAULT_ID)
        cles.add(k ? toHex(k).slice(0, 12) : 'aucune')
      }
      return {
        nom: 'cle-commune', ok: cles.size <= 1,
        detail: [...cles].join(' | ') || '(personne)',
      }
    }

    // Twins : deux epoques DIFFERENTES a la meme hauteur, signees par la MEME
    // cle. Le protocole ne l'empeche pas a k=1 — il la rend attribuable. Ce
    // verdict cherche la preuve, et sa presence est le resultat attendu.
    case 'equivocation': {
      const vues = new Map<string, Set<string>>() // signer/hauteur -> ids d'epoque
      for (const p of m.pairs) {
        for (const e of p.chain.all()) {
          for (const s of e.sigs) {
            const cle = `${toHex(s.signer).slice(0, 8)}@${e.height}`
            const set = vues.get(cle) ?? new Set<string>()
            set.add(toHex(s.sig).slice(0, 8))
            vues.set(cle, set)
          }
        }
      }
      const preuves = [...vues.entries()].filter(([, ids]) => ids.size > 1)
      return {
        nom: 'equivocation', ok: preuves.length > 0,
        detail: preuves.length
          ? preuves.map(([k, ids]) => `${k} → ${[...ids].join(' vs ')}`).join(' | ')
          : 'aucune equivocation observee',
      }
    }

    // La revocation tient-elle ? Pas « a-t-il ecrit », mais « est-il dehors ».
    case 'hors-du-vault': {
      const cible = m.pairs.find((p) => p.id === args[0])
      const acc = cible?.access()
      return {
        nom: `hors-du-vault ${args[0]}`, ok: acc === undefined,
        detail: acc === undefined ? 'aucun droit' : `il detient ${['pull', 'read', 'write', 'manage'][acc]}`,
      }
    }

    // Le niveau d'un pair, vu par l'arbitre : `niveau p3 manage`, ou `aucun`.
    case 'niveau': {
      const cible = m.pairs.find((p) => p.id === args[0])
      const attendu = args[1] ?? 'write'
      const NOMS = ['pull', 'read', 'write', 'manage']
      const acc = cible && resolveAccess(m.pairs[0].chain.state(), cible.identity.signPub)
      const vu = acc === undefined ? 'aucun' : NOMS[acc]
      return { nom: `niveau ${args[0]} ${attendu}`, ok: vu === attendu, detail: `l'arbitre voit ${vu}` }
    }

    // ADR-0019 — deux admins ont decide sur le meme membre sans se voir.
    case 'conflit-signale': {
      const n = m.pairs[0].conflits.length
      const min = Number(args[0] ?? 1)
      return { nom: 'conflit-signale', ok: n >= min, detail: `${n} conflit(s) signale(s) par l'arbitre` }
    }

    case 'aucun-conflit': {
      const n = m.pairs[0].conflits.length
      return { nom: 'aucun-conflit', ok: n === 0, detail: `${n} conflit(s) signale(s)` }
    }

    // Combien de fois la cle a tourne, sur la chaine de l'arbitre.
    case 'rotations-min': {
      const n = m.pairs[0].chain.all().filter((e) => e.height > 0 && e.keyCommit).length
      const min = Number(args[0] ?? 1)
      return { nom: `rotations-min ${min}`, ok: n >= min, detail: `${n} rotations de cle` }
    }

    // Un pair passe sous `read` ne doit pas detenir la cle courante.
    case 'sans-cle': {
      const cible = m.pairs.find((p) => p.id === args[0])
      const chaine = m.pairs[0].chain
      const ke = chaine.keyEpochAt(chaine.head())
      const detient = !!(cible && ke && cible.keyring.has(ke))
      return { nom: `sans-cle ${args[0]}`, ok: !detient, detail: detient ? 'il detient la cle courante' : 'cle courante absente' }
    }

    case 'divergence': {
      const tetes = new Set(m.pairs.filter((p) => p.chain.height() > 0)
        .map((p) => toHex(p.chain.head()).slice(0, 8)))
      return {
        nom: 'divergence', ok: tetes.size > 1,
        detail: `${tetes.size} tetes distinctes : ${[...tetes].join(' ')}`,
      }
    }

    default:
      return { nom, ok: false, detail: 'verdict inconnu' }
  }
}
