// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tous les bancs, a la suite. Les scenarios d'ATTAQUE ne sont pas ici : ce sont
// des assertions, pas des mesures, et ils vivent dans test/attacks.test.ts.
import { run as scale } from './scale'
import { run as flood } from './flood'

async function main(): Promise<void> {
  await scale()
  await flood()
}

main().catch((e) => { console.error(e); process.exit(1) })
