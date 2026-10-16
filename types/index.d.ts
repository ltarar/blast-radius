export type Usage = { path: string; line: number; code: string }

export type RepoUses = { repo: string; uses: Usage[]; testUses: number }

export type Consumer = { repo: string; via: 'gem' | 'npm' }

// One thing the branch breaks, said as a sentence, with the code it breaks.
export type Break = {
  level: 'red' | 'yellow'
  text: string
  fix?: string
  uses: Usage[]
  testUses: number
  repoUses: RepoUses[]
}

export type TodoItem = { kind: 'new' | 'fixed' | 'moved'; rule: string; file: string; from?: string }

export type TodoChange = { added: number; fixed: number; moved: number; items: TodoItem[] }

export type RepoBlast = {
  repo: string
  branch: string
  fileCount: number
  breaks: Break[]
  todo?: TodoChange
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { repos: RepoBlast[]; focus: string[]; showAll: boolean }
  }
}
