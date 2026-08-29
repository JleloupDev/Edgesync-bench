// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Les scenarios font tourner des dizaines de pairs sur des minuteries
    // reelles : la valeur par defaut de 5 s est trop juste.
    testTimeout: 30_000,
  },
})
