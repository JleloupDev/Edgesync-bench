// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les scenarios du laboratoire, passes en assertions. Un scenario ecrit est un
// test de non-regression ; un scenario tire est une chance de trouver ce que
// personne n'a ecrit. Les deux tournent ici.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { parse, jouer } from '../lab/scenario'
import { fuzz } from '../lab/fuzz'

const GRAINE = 7
const fichiers = readdirSync('lab/scenarios')
  .filter((f) => f.endsWith('.txt') && !f.startsWith('echec-'))
  .sort()

const rates = (verdicts: { nom: string; ok: boolean; detail: string }[]) =>
  verdicts.filter((v) => !v.ok).map((v) => `${v.nom} — ${v.detail}`)

describe('laboratoire — les scenarios ecrits', () => {
  for (const f of fichiers) {
    it(f.replace('.txt', ''), async () => {
      const r = await jouer(parse(readFileSync(`lab/scenarios/${f}`, 'utf8')), { seed: GRAINE })
      expect(r.verdicts.length).toBeGreaterThan(0)
      expect(rates(r.verdicts)).toEqual([])
    }, 120_000)
  }
})

describe('laboratoire — les scenarios tires', () => {
  it('douze tirages tiennent, et chacun se rejoue par sa graine', async () => {
    const echecs: string[] = []
    for (let i = 0; i < 12; i++) {
      const graine = (20_000 + i * 7919) >>> 0
      const r = await jouer(parse(fuzz(graine)), { seed: graine })
      for (const e of rates(r.verdicts)) echecs.push(`graine ${graine} · ${e}`)
    }
    expect(echecs).toEqual([])
  }, 600_000)
})
