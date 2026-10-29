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

export const lockHasGem = (lock: string, gem: string): boolean => lock.split('\n').some(line => line.startsWith(`    ${gem} (`))

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
  return `(from|import\\(?|require\\()[[:space:]]*['"][^'"]*${escapeRegExp(tail)}(\\.(m?js|jsx|ts|tsx))?['"]`
}

// The path a JS/TS module is imported by, without its extension or a trailing `index`.
export const modulePathOf = (path: string): string => path.replace(/\.(m?js|jsx|ts|tsx)$/, '').replace(/\/index$/, '')

// Imports of a relative path ending in `name`, such as `./Button`, which `importPattern` can't see.
export const relativeImportPattern = (name: string): string => {
  return `(from|import\\(?|require\\()[[:space:]]*['"]\\.\\.?/([^'"]*/)?${escapeRegExp(name)}(/index)?(\\.(m?js|jsx|ts|tsx))?['"]`
}

const specifiersIn = (code: string) => [...code.matchAll(/(?:from|import\(?|require\()\s*['"]([^'"]+)['"]/g)].map(([, specifier = '']) => specifier)
const isRelative = (specifier: string) => /^\.\.?\//.test(specifier)
const endsInTail = (specifier: string, tail: string) => modulePathOf(specifier) === tail || modulePathOf(specifier).endsWith(`/${tail}`)

// Whether a line in `fromFile` imports the module at `modulePath`: a relative path must resolve to it,
// any other path (an alias such as `@/components/Button`) must end in its `tail`.
export const importsModule = (fromFile: string, code: string, modulePath: string, tail: string): boolean =>
  specifiersIn(code).some(specifier => {
    if (!isRelative(specifier)) return endsInTail(specifier, tail)
    const parts = fromFile.split('/').slice(0, -1)
    for (const part of specifier.split('/')) {
      if (part === '..') parts.pop()
      else if (part !== '.' && part !== '') parts.push(part)
    }
    return modulePathOf(parts.join('/')) === modulePath
  })

// Whether a line in another repo imports the module: a relative path there stays inside that repo.
export const importsFromOutside = (code: string, tail: string): boolean =>
  specifiersIn(code).some(specifier => !isRelative(specifier) && endsInTail(specifier, tail))

// `git grep -n` output as usages, code trimmed of surrounding space.
export const parseGrepHits = (stdout: string): Usage[] =>
  stdout
    .split('\n')
    .map(line => line.match(/^([^:]+):(\d+):(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match[2]))
    .map(match => ({ path: match[1] ?? '', line: Number(match[2]), code: (match[3] ?? '').trim() }))

export const isTodoFile = (path: string): boolean => path === 'package_todo.yml' || path.endsWith('/package_todo.yml')

const unquote = (text: string) => text.trim().replace(/:$/, '').replace(/^["']|["']$/g, '')

type TodoEntry = { target: string; constant: string; types: string[]; files: string[] }

const isSkippableTodoLine = (line: string) => line.trim() === '' || line.trimStart().startsWith('#') || line.startsWith('---')

const addTodoEntry = (todo: Record<string, string[]>, entry: TodoEntry) => {
  if (entry.constant) for (const type of entry.types) todo[[entry.target, entry.constant, type].join('\t')] = entry.files
}

// A package_todo.yml as one key per rule (package, constant, violation), each with the files that break it.
export const parseTodo = (yaml: string): Record<string, string[]> => {
  const todo: Record<string, string[]> = {}
  let entry: TodoEntry = { target: '', constant: '', types: [], files: [] }
  let list: string[] | undefined
  for (const line of yaml.split('\n').filter(line => !isSkippableTodoLine(line))) {
    const indent = line.length - line.trimStart().length
    const text = line.trimStart()
    if (indent === 0 || (indent === 2 && !text.startsWith('-'))) {
      addTodoEntry(todo, entry)
      entry = { target: indent === 0 ? unquote(line) : entry.target, constant: indent === 0 ? '' : unquote(line), types: [], files: [] }
      list = undefined
    } else if (text.startsWith('violations:')) list = entry.types
    else if (text.startsWith('files:')) list = entry.files
    else if (text.startsWith('- ')) list?.push(unquote(text.slice(2)))
  }
  addTodoEntry(todo, entry)
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

// A listing whose file still exists can't have moved, so it pairs with a new one only when its file is gone.
export const diffTodo = (before: Record<string, string[]>, after: Record<string, string[]>, stillExists: (file: string) => boolean = () => false): TodoChange => {
  const change: TodoChange = { added: 0, fixed: 0, moved: 0, items: [] }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const rule = ruleLabel(key)
    const now = after[key] ?? []
    const gone = (before[key] ?? []).filter(file => !now.includes(file))
    const arrived = now.filter(file => !(before[key] ?? []).includes(file))
    const movedFrom = gone.filter(file => !stillExists(file)).slice(0, arrived.length)
    const pairs = movedFrom.length
    const items: TodoItem[] = [
      ...arrived.slice(0, pairs).map((file, i) => ({ kind: 'moved' as const, rule, from: shortPath(movedFrom[i] ?? '', file), file: shortPath(file, movedFrom[i]) })),
      ...arrived.slice(pairs).map(file => ({ kind: 'new' as const, rule, file })),
      ...gone.filter(file => !movedFrom.includes(file)).map(file => ({ kind: 'fixed' as const, rule, file })),
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
  [...code.matchAll(/(?<![A-Za-z0-9_])(?:::)?[A-Z][A-Za-z0-9_:]*/g)].flatMap(([path]) => {
    const absolute = path.startsWith('::')
    const parts = (absolute ? path.slice(2) : path).split('::')
    const end = parts.lastIndexOf(shortName)
    return end === -1 ? [] : [`${absolute ? '::' : ''}${parts.slice(0, end + 1).join('::')}`]
  })
