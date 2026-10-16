// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le generateur seme du banc. Rien ici ne tire sur Math.random : une divergence
// qu'on ne sait pas rejouer n'est pas un bug, c'est une rumeur.
export class Prng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9
  }

  /** mulberry32 — court, correct pour du test, reproductible partout. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(n: number): number { return Math.floor(this.next() * n) }
  chance(p: number): boolean { return this.next() < p }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)] }

  /** Fisher-Yates seme : l'ordre de livraison du reseau sort d'ici. */
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const t = xs[i]; xs[i] = xs[j]; xs[j] = t
    }
    return xs
  }
}
