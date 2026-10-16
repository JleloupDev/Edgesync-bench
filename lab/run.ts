// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
//   npm run lab -- lab/scenarios/revocation.txt          un scenario, un verdict
//   npm run lab -- lab/scenarios/twins.txt --suivre      le meme, en direct
//   npm run lab -- --fuzz=100                            cent scenarios tires
//   npm run lab -- --fuzz=100 --seed=1234                les memes, a l'identique
//
// Un echec sort avec sa graine ET son scenario : c'est ce qui le rend rejouable.
import { readFileSync, writeFileSync } from 'node:fs'
import { parse, jouer, type Rapport } from './scenario'
import { ecran, tableau, couleurs as A } from './view'
import { fuzz } from './fuzz'

const args = process.argv.slice(2)
const val = (nom: string): string | undefined =>
  args.find((a) => a.startsWith(`--${nom}=`))?.split('=')[1]
const flag = (nom: string): boolean => args.includes(`--${nom}`)

const fichier = args.find((a) => !a.startsWith('--'))
const seed = Number(val('seed') ?? Math.floor(Math.random() * 1e9))
const suivre = flag('suivre')
const vitesse = Number(val('vitesse') ?? 30)

async function unScenario(texte: string, graine: number, titre: string): Promise<Rapport> {
  const onTick = suivre
    ? async (e: Parameters<NonNullable<Parameters<typeof jouer>[1]['onTick']>>[0]) => {
      process.stdout.write(ecran(e))
      await new Promise((r) => setTimeout(r, vitesse))
    }
    : undefined
  const r = await jouer(parse(texte), { seed: graine, onTick })
  if (!suivre) {
    console.log(`\n${A.gras(titre)}  ${A.gris(`graine ${graine}`)}\n`)
    for (const ligne of r.journal) console.log(A.gris(`  ${ligne}`))
    console.log(`\n${tableau(r)}\n`)
  }
  for (const v of r.verdicts) {
    console.log(`  ${v.ok ? A.vert('✓') : A.rouge('✗')} ${v.nom.padEnd(22)} ${A.gris(v.detail)}`)
  }
  return r
}

if (fichier) {
  const r = await unScenario(readFileSync(fichier, 'utf8'), seed, fichier)
  console.log()
  process.exit(r.verdicts.every((v) => v.ok) ? 0 : 1)
} else if (val('fuzz')) {
  const n = Number(val('fuzz'))
  console.log(`\n  ${A.gras(`${n} scenarios tires`)}  ${A.gris(`graine de base ${seed}`)}\n`)
  let echecs = 0
  for (let i = 0; i < n; i++) {
    const graine = (seed + i * 7919) >>> 0
    const texte = fuzz(graine)
    const r = await jouer(parse(texte), { seed: graine })
    const rates = r.verdicts.filter((v) => !v.ok)
    const marque = rates.length === 0 ? A.vert('·') : A.rouge('✗')
    process.stdout.write(marque)
    if (rates.length) {
      echecs++
      console.log(`\n\n  ${A.rouge(`echec graine ${graine}`)} — rejouable :`)
      console.log(A.gris(`    npm run lab -- ${scenarioTemporaire(graine, texte)} --seed=${graine}\n`))
      for (const v of rates) console.log(`    ${A.rouge('✗')} ${v.nom} — ${v.detail}`)
      console.log(A.gris(`\n${texte.split('\n').map((l) => `    ${l}`).join('\n')}\n`))
    }
  }
  console.log(`\n\n  ${echecs === 0 ? A.vert(`${n}/${n} scenarios tiennent`) : A.rouge(`${echecs} echecs sur ${n}`)}\n`)
  process.exit(echecs === 0 ? 0 : 1)
} else {
  console.log(`
  npm run lab -- lab/scenarios/<x>.txt [--suivre] [--seed=N] [--vitesse=ms]
  npm run lab -- --fuzz=N [--seed=N]
`)
}

/** Ecrit le scenario tire a cote, pour qu'un echec se rejoue tel quel. */
function scenarioTemporaire(graine: number, texte: string): string {
  const chemin = `lab/scenarios/echec-${graine}.txt`
  try {
    writeFileSync(chemin, texte)
    return chemin
  } catch {
    return '(scenario ci-dessous)'
  }
}
