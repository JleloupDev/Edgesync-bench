// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'interface : un tableau dans un terminal. Pas de navigateur, pas de fenetres
// a aligner — une ligne par pair, et on voit tout d'un coup.
import { Access, toHex } from 'edgesync-protocol'
import { empreinteDe } from './checks'
import type { Etat } from './scenario'

const A = {
  vert: (s: string) => `\x1b[32m${s}\x1b[0m`,
  rouge: (s: string) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gris: (s: string) => `\x1b[90m${s}\x1b[0m`,
  gras: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

const NIVEAU = ['pull', 'read', 'write', 'manage']

export function tableau(e: Etat): string {
  const l: string[] = []
  l.push(A.gras(`  tick ${e.tick}   ${e.net.stats.livrees} trames livrees · ${e.net.stats.perdues} perdues · ${(e.net.stats.octets / 1024).toFixed(0)} Kio · ${e.net.enVol()} en vol`))
  l.push(A.gris('  pair    profil     droit    chaine        contenu   empreinte  ecrits'))
  for (const p of e.pairs) {
    const acc = p.access()
    const coupe = e.net.estCoupe(p.id)
    const droit = acc === undefined ? A.rouge('—     ') : (NIVEAU[acc] ?? '?').padEnd(6)
    const tete = p.chain.height() > 0 ? `h=${String(p.chain.height()).padEnd(3)} ${toHex(p.chain.head()).slice(0, 6)}` : A.gris('vide       ')
    const nom = coupe ? A.jaune(`${p.id}✂`.padEnd(7)) : p.id.padEnd(7)
    const prof = p.jumeauDe ? A.rouge('jumeau'.padEnd(10)) : (p.profil === 'honnete' ? A.gris(p.profil.padEnd(10)) : A.jaune(p.profil.padEnd(10)))
    const contenu = `${p.texte().length}`.padStart(6)
    const emp = (acc !== undefined && acc >= Access.Read) ? empreinteDe(p) : A.gris('········')
    l.push(`  ${nom} ${prof} ${droit}   ${tete}  ${contenu}   ${emp}  ${String(p.ecrits).padStart(4)}`)
  }
  return l.join('\n')
}

export function journalCourt(e: Etat, n = 8): string {
  return e.journal.slice(-n).map((s) => A.gris(`  ${s}`)).join('\n')
}

export function ecran(e: Etat): string {
  return `\x1b[H\x1b[2J${tableau(e)}\n\n${journalCourt(e)}\n`
}

export { A as couleurs }
