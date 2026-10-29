import type { Consumer, TodoChange, TodoItem, Usage } from '../types'

export type Language = 'ruby' | 'js' | 'other'
export type Published = { gem?: string; npm?: string }

export type Level = 'red' | 'yellow' | 'green'

const RISK: Record<Level, number> = { red: 0, yellow: 1, green: 2 }

export const byRisk = <T extends { level: Level }>(items: T[]): T[] => [...items].sort((a, b) => RISK[a.level] - RISK[b.level])

export const expandHome = (path: string, home: string): string =>
  (path === '~' || path.startsWith('~/') ? home + path.slice(1) : path).replace(/\/+$/, '')

export const repoOf = (path: string, root: string): string | undefined =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1).split('/')[0] || undefined : undefined

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const gemNameOf = (gemspec: string): string | undefined => gemspec.match(/\.name\s*=\s*["']([^"']+)["']/)?.[1]

export const npmNameOf = (packageJson: string): string | undefined => {
  try {
    const name = (JSON.parse(packageJson) as { name?: unknown }).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

export const lockHasGem = (lock: string, gem: string): boolean =>
  new RegExp(`^ {4}${escapeRegExp(gem)} \\(`, 'm').test(lock)

export const packageJsonHasDep = (packageJson: string, name: string): boolean => {
  try {
    const json = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>
    return ['dependencies', 'devDependencies', 'peerDependencies'].some(key => json[key]?.[name] !== undefined)
  } catch {
    return false
  }
}

export const consumersOf = (
  repo: string,
  published: Published,
  manifests: Record<string, { lock?: string; packageJson?: string }>,
): Consumer[] => {
  const found: Consumer[] = []
  for (const [other, files] of Object.entries(manifests)) {
    if (other === repo) continue
    if (published.gem && files.lock && lockHasGem(files.lock, published.gem)) found.push({ repo: other, via: 'gem' })
    else if (published.npm && files.packageJson && packageJsonHasDep(files.packageJson, published.npm)) found.push({ repo: other, via: 'npm' })
  }
  return found.sort((a, b) => a.repo.localeCompare(b.repo))
}

// `git diff --name-status --no-renames` output plus untracked paths, as unique repo-relative paths.
export const changedFiles = (nameStatus: string, untracked: string): string[] => {
  const fromDiff = nameStatus
    .split('\n')
    .map(line => line.split('\t')[1])
    .filter((path): path is string => Boolean(path))
  return [...new Set([...fromDiff, ...untracked.split('\n').filter(Boolean)])]
}

export const isTest = (path: string): boolean =>
  /(^|\/)(spec|test|tests|__tests__)\//.test(path) || /(_spec\.rb|_test\.rb|\.(test|spec)\.[jt]sx?)$/.test(path)

export const languageOf = (path: string): Language => {
  if (path.endsWith('.rb')) return 'ruby'
  if (/\.(m?js|jsx|ts|tsx)$/.test(path) && !path.endsWith('.d.ts')) return 'js'
  return 'other'
}

// The import path tail other files use for a JS/TS module: `components/Button`, or the folder for an index file.
export const moduleTailOf = (path: string): string => {
  const parts = path.replace(/\.(m?js|jsx|ts|tsx)$/, '').split('/')
  if (parts[parts.length - 1] === 'index') parts.pop()
  return parts.slice(-2).join('/')
}

export const importPattern = (tail: string): string => {
  return `(from|import|require\\()[[:space:]]*['"][^'"]*${escapeRegExp(tail)}(\\.(m?js|jsx|ts|tsx))?['"]`
}

// `git grep -n` output as usages, code trimmed of surrounding space.
export const parseGrepHits = (stdout: string): Usage[] =>
  stdout
    .split('\n')
    .map(line => line.match(/^([^:]+):(\d+):(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match[2]))
    .map(match => ({ path: match[1] ?? '', line: Number(match[2]), code: (match[3] ?? '').trim() }))

export const isTodoFile = (path: string): boolean => path === 'package_todo.yml' || path.endsWith('/package_todo.yml')

const unquote = (text: string) => text.trim().replace(/:$/, '').replace(/^["']|["']$/g, '')

// A package_todo.yml as one key per rule (package, constant, violation), each with the files that break it.
export const parseTodo = (yaml: string): Record<string, string[]> => {
  const todo: Record<string, string[]> = {}
  let target = ''
  let constant = ''
  let mode: 'violations' | 'files' | undefined
  let types: string[] = []
  let files: string[] = []
  const flush = () => {
    if (constant) for (const type of types) todo[[target, constant, type].join('\t')] = files
  }
  for (const line of yaml.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '' || line.startsWith('---')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0 || (indent === 2 && !line.trimStart().startsWith('-'))) {
      flush()
      if (indent === 0) {
        target = unquote(line)
        constant = ''
      } else constant = unquote(line)
      types = []
      files = []
      mode = undefined
    } else if (/^\s+violations:/.test(line)) mode = 'violations'
    else if (/^\s+files:/.test(line)) mode = 'files'
    else if (line.trimStart().startsWith('- ')) {
      const item = unquote(line.trimStart().slice(2))
      if (mode === 'violations') types.push(item)
      else if (mode === 'files') files.push(item)
    }
  }
  flush()
  return todo
}

export const ruleLabel = (key: string): string => {
  const [target = '', constant = '', type = ''] = key.split('\t')
  const owner = target === '.' ? 'the root package' : target
  const name = constant.replace(/^::/, '')
  if (type === 'privacy') return `${name}, which is private to ${owner}`
  if (type === 'dependency') return `${name} from ${owner}, which it doesn't depend on`
  return `${name} from ${owner} (${type})`
}

const shortPath = (path: string, from?: string) => {
  if (!from) return path
  const shared = from.split('/').findIndex((part, i) => path.split('/')[i] !== part)
  return path.split('/').slice(Math.max(0, shared)).join('/')
}

export const diffTodo = (before: Record<string, string[]>, after: Record<string, string[]>): TodoChange => {
  const change: TodoChange = { added: 0, fixed: 0, moved: 0, items: [] }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const rule = ruleLabel(key)
    const now = after[key] ?? []
    const gone = (before[key] ?? []).filter(file => !now.includes(file))
    const arrived = now.filter(file => !(before[key] ?? []).includes(file))
    const pairs = Math.min(gone.length, arrived.length)
    const items: TodoItem[] = [
      ...arrived.slice(0, pairs).map((file, i) => ({ kind: 'moved' as const, rule, from: shortPath(gone[i] ?? '', file), file: shortPath(file, gone[i]) })),
      ...arrived.slice(pairs).map(file => ({ kind: 'new' as const, rule, file })),
      ...gone.slice(pairs).map(file => ({ kind: 'fixed' as const, rule, file })),
    ]
    change.moved += pairs
    change.added += arrived.length - pairs
    change.fixed += gone.length - pairs
    change.items.push(...items)
  }
  return change
}

export const addTodo = (a: TodoChange | undefined, b: TodoChange): TodoChange =>
  a ? { added: a.added + b.added, fixed: a.fixed + b.fixed, moved: a.moved + b.moved, items: [...a.items, ...b.items] } : b

// A grep hit on a Ruby or JS comment line, which can't break.
export const isCommentLine = (code: string): boolean => /^(#|\/\/|\/\*|\*)/.test(code.trim())

// A git grep -E pattern for a constant's last name, alone or followed by `suffix` (say `\.call`).
export const referencePattern = (shortName: string, suffix = ''): string =>
  `(^|[^A-Za-z0-9_])${escapeRegExp(shortName)}${suffix}([^A-Za-z0-9_?!]|$)`

// The constant references in a line of code that end in `shortName`, as written: `Foo`, `A::Foo`, `::A::Foo`.
export const referencesIn = (code: string, shortName: string): string[] =>
  [...code.matchAll(new RegExp(`(?<![A-Za-z0-9_])(?:::)?(?:[A-Z][A-Za-z0-9_]*::)*${escapeRegExp(shortName)}(?![A-Za-z0-9_])`, 'g'))].map(m => m[0])
