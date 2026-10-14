export type Usage = { path: string; line: number; code: string }

export type RepoUses = { repo: string; uses: Usage[]; testUses: number }

export type FileBlast = {
  path: string
  name?: string
  changed: string[]
  isDeleted: boolean
  visibleTo: string[]
  uses: Usage[]
  testUses: number
  repoUses: RepoUses[]
}

export type Consumer = { repo: string; via: 'gem' | 'npm' }

export type TodoItem = { kind: 'new' | 'fixed' | 'moved'; rule: string; file: string; from?: string }

export type TodoChange = { added: number; fixed: number; moved: number; items: TodoItem[] }

export type RepoBlast = {
  repo: string
  branch: string
  fileCount: number
  usesPackwerk: boolean
  listed: FileBlast[]
  quiet: number
  tests: number
  notChecked: number
  consumers: Consumer[]
  todo?: TodoChange
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { repos: RepoBlast[]; focus: string[]; showAll: boolean }
  }
}
