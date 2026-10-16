// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le tirage de scenarios. C'est applyRandomTests de Yjs, avec ce que Yjs n'a pas
// a simuler : des droits qui changent au milieu du trafic, et des pairs qui
// mentent.
//
// Le resultat est un SCENARIO TEXTE, pas une suite d'appels : un echec se relit,
// se corrige a la main, et devient un fichier de non-regression sans reecriture.
import { Prng } from '../src/prng'
import { BYZANTINS } from './profiles'

export function fuzz(seed: number): string {
  const r = new Prng(seed)
  const n = 4 + r.int(5)                 // 4 a 8 pairs
  const l: string[] = [`# tire de la graine ${seed}`, `pairs ${n}`]

  // Zero a deux byzantins, jamais le fondateur : un arbitre corrompu est un
  // scenario a part (voir twins.txt), pas du bruit de fond.
  const nbByz = r.int(3)
  const byzantins: string[] = []
  for (let i = 0; i < nbByz; i++) {
    const id = `p${1 + r.int(n - 1)}`
    if (byzantins.includes(id)) continue
    byzantins.push(id)
    l.push(`profil ${id} ${r.pick(BYZANTINS)}`)
  }

  l.push(`latence 1 ${2 + r.int(4)}`)
  // Pas de `perte` ici : le plan du contenu ne rattrape pas une trame perdue
  // (voir lab/scenarios/perte.txt). Tirer de la perte ferait echouer tous les
  // scenarios pour une seule raison, deja connue — et noierait les autres.
  l.push('admettre *', `tourne ${10 + r.int(20)}`)

  const coupes = new Set<string>()
  const revoques: string[] = []
  // Readmettre un revoque republie TOUT ce qu'il a ecrit pendant son exclusion
  // (voir readmission.txt) : ce n'est pas un defaut, mais cela rendrait
  // `aucun-ecrit-de` faux pour une raison qui n'a rien a voir avec la revocation.
  const jamaisRevoques = () => Array.from({ length: n - 1 }, (_, i) => `p${i + 1}`)
    .filter((id) => !revoques.includes(id))
  const evenements = 3 + r.int(5)
  for (let i = 0; i < evenements; i++) {
    const quoi = r.int(10)
    const cible = `p${1 + r.int(n - 1)}`
    if (quoi < 3 && !coupes.has(cible)) { coupes.add(cible); l.push(`couper ${cible}`) }
    else if (quoi < 5 && coupes.size) {
      const c = r.pick([...coupes]); coupes.delete(c); l.push(`retablir ${c}`)
    } else if (quoi < 7 && !revoques.includes(cible) && !coupes.has(cible)) {
      revoques.push(cible); l.push(`revoquer ${cible}`)
    } else if (quoi < 8) l.push(`admettre ${jamaisRevoques().join(' ')}`)
    l.push(`tourne ${8 + r.int(25)}`)
  }

  // La fin est toujours la meme : tout le monde revient, le fil se vide, ET
  // SEULEMENT ALORS on compare.
  if (coupes.size) l.push(`retablir ${[...coupes].join(' ')}`)
  l.push('tourne 20', 'apaiser 150')
  l.push('attendre converge', 'attendre chaine-unique', 'attendre cle-commune')
  // Un rejoueur present peut READMETTRE un revoque en rejouant sa demande
  // d'admission (lab/scenarios/rejeu-acl.txt). Tant que ce trou est ouvert,
  // attendre `aucun-ecrit-de` sous un rejoueur reviendrait a re-signaler la meme
  // trouvaille a chaque tirage, en noyant les autres.
  const rejoueurPresent = l.some((x) => x.endsWith(' rejoueur'))
  if (!rejoueurPresent) for (const p of revoques) l.push(`attendre aucun-ecrit-de ${p}`)
  for (const p of byzantins) l.push(`attendre aucune-epoque-de ${p}`)
  return l.join('\n') + '\n'
}
