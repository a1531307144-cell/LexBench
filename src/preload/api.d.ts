import type { LexBenchApi } from './index'

declare global {
  interface Window {
    lexbench: LexBenchApi
  }
}

export {}
