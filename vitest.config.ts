import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['src/shared/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true
  }
})
