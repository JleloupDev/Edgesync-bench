// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export { Prng } from '../../src/prng'

/** Une graine lisible depuis l'URL, sinon tiree au sort et affichee. */
export function seedFromUrl(fallbackTag: string): number {
  const p = new URLSearchParams(location.search).get('seed')
  if (p) return Number(p) >>> 0
  let h = 2166136261
  const s = fallbackTag + Date.now()
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
