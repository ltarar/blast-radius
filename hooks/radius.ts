import type { Consumer, FileBlast, TodoChange, TodoItem, Usage } from '../types'

export type PackageInfo = { dependencies: string[]; publicPath: string; enforcePrivacy: boolean }
export type Language = 'ruby' | 'js' | 'other'
export type Published = { gem?: string; npm?: string }

export const expandHome = (path: string, home: string): string =>
  (path === '~' || path.startsWith('~/') ? home + path.slice(1) : path).replace(/\/+$/, '')

export const repoOf = (path: string, root: string): string | undefined =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1).split('/')[0] || undefined : undefined

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Repos a shell command works in: `cd api`, `git -C web`, or a path under the repos root.
export const reposMentioned = (command: string, repoNames: string[], root: string): string[] => {
  const folder = escapeRegExp(root.split('/').pop() ?? '')
  return repoNames.filter(name =>
    new RegExp(`(\\bcd\\s+|-C\\s+|${folder}/)(~/${folder}/|\\./)?${escapeRegExp(name)}(/|\\s|$|&|;)`).test(command),
  )
}

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
  new RegExp(`^ {4}${gem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`, 'm').test(lock)

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

export const parsePackage = (yaml: string): PackageInfo => {
  const dependencies: string[] = []
  let publicPath = 'app/public/'
  let enforcePrivacy = false
  let inDeps = false
  for (const line of yaml.split('\n')) {
    const publicMatch = line.match(/^public_path:\s*["']?([^"'#\s]+)/)
    if (publicMatch?.[1]) publicPath = publicMatch[1].endsWith('/') ? publicMatch[1] : `${publicMatch[1]}/`
    if (/^enforce_privacy:\s*true/.test(line)) enforcePrivacy = true
    if (/^dependencies:\s*$/.test(line)) {
      inDeps = true
      continue
    }
    if (!inDeps) continue
    const item = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?/)
    if (item?.[1]) dependencies.push(item[1])
    else if (/^\S/.test(line)) inDeps = false
  }
  return { dependencies, publicPath, enforcePrivacy }
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

// Package dirs that could own a path, nearest first, ending at the root package ".".
export const packageCandidates = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1)
  const dirs: string[] = []
  for (let i = parts.length; i > 0; i--) dirs.push(parts.slice(0, i).join('/'))
  return [...dirs, '.']
}

export const ownerOf = (path: string, packages: Record<string, PackageInfo>): string => {
  const owner = packageCandidates(path).find(dir => dir in packages)
  if (owner !== '.' || !path.startsWith('spec/')) return owner ?? '.'
  return packageCandidates(path.slice('spec/'.length)).find(dir => dir in packages) ?? '.'
}

export const dependentsOf = (pkg: string, packages: Record<string, PackageInfo>): string[] =>
  Object.entries(packages)
    .filter(([name, info]) => name !== pkg && info.dependencies.includes(pkg))
    .map(([name]) => name)
    .sort()

export const isPrivate = (path: string, packages: Record<string, PackageInfo>): boolean => {
  const pkg = ownerOf(path, packages)
  const info = packages[pkg]
  if (!info?.enforcePrivacy) return false
  return !(pkg === '.' ? path : path.slice(pkg.length + 1)).startsWith(info.publicPath)
}

// The fully qualified name of the first class in a Ruby file, from its module/class nesting.
export const constantOf = (source: string): string | undefined => {
  const stack: { indent: number; name: string }[] = []
  let lastModule: string | undefined
  for (const line of source.split('\n')) {
    const match = line.match(/^(\s*)(module|class)\s+([A-Z][\w:]*)/)
    if (!match?.[2] || !match[3]) continue
    const indent = match[1]?.length ?? 0
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop()
    stack.push({ indent, name: match[3] })
    const qualified = stack.map(one => one.name).join('::')
    if (match[2] === 'class') return qualified
    lastModule = qualified
  }
  return lastModule
}

// The import path tail other files use for a JS/TS module: `components/Button`, or the folder for an index file.
export const moduleTailOf = (path: string): string => {
  const parts = path.replace(/\.(m?js|jsx|ts|tsx)$/, '').split('/')
  if (parts[parts.length - 1] === 'index') parts.pop()
  return parts.slice(-2).join('/')
}

export const importPattern = (tail: string): string => {
  const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(from|import|require\\()[[:space:]]*['"][^'"]*${escaped}(\\.(m?js|jsx|ts|tsx))?['"]`
}

// `git grep -n` output as usages, code trimmed to one short line.
export const parseGrepHits = (stdout: string): Usage[] =>
  stdout
    .split('\n')
    .map(line => line.match(/^([^:]+):(\d+):(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match[2]))
    .map(match => ({ path: match[1] ?? '', line: Number(match[2]), code: (match[3] ?? '').trim().slice(0, 100) }))

export const shouldList = (file: FileBlast): boolean =>
  file.uses.length > 0 || file.repoUses.length > 0 || file.visibleTo.length > 0

export type Advice = { level: 'red' | 'yellow' | 'green'; text: string }

export const adviceFor = (file: FileBlast): Advice => {
  const elsewhere = file.uses.length > 0 || file.repoUses.length > 0
  if (file.isDeleted && elsewhere) return { level: 'red', text: 'Deleted, but still used. Those lines will break.' }
  if (file.isDeleted) return { level: 'green', text: 'Deleted, and nothing else used it. Safe.' }
  if (file.repoUses.length > 0) {
    return { level: 'red', text: 'Used in other repos. Check them before you release.' }
  }
  if (file.uses.length > 0) return { level: 'yellow', text: 'A change can break these lines. Run their specs.' }
  const who = file.visibleTo.map(pkg => (pkg === '.' ? 'the root package' : pkg))
  const subject = who.length === 1 ? `${who[0]} can` : `${who.join(', ')} can`
  return { level: 'green', text: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} use it, but nothing does yet. Check it needs to be public.` }
}

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
  if (type === 'privacy') return `${name} (private, from ${owner})`
  if (type === 'dependency') return `${name} (undeclared, from ${owner})`
  return `${name} (${type}, from ${owner})`
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

export const todoAdvice = (todo: TodoChange): Advice => {
  if (todo.added > 0) return { level: 'red', text: 'Fix them, or explain why in the PR.' }
  if (todo.fixed > 0) return { level: 'green', text: 'Nothing to do.' }
  return { level: 'green', text: 'Nothing to do.' }
}

export type ChangedLines = { added: number[]; removed: number[] }

// Line numbers a `git diff -U0` touches: `added` in the new file, `removed` in the old one.
export const parseDiffLines = (diff: string): ChangedLines => {
  const lines: ChangedLines = { added: [], removed: [] }
  for (const header of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [oldStart, oldCount, newStart, newCount] = [header[1], header[2] ?? '1', header[3], header[4] ?? '1'].map(Number)
    for (let i = 0; i < (oldCount ?? 0); i++) lines.removed.push((oldStart ?? 0) + i)
    for (let i = 0; i < (newCount ?? 0); i++) lines.added.push((newStart ?? 0) + i)
  }
  return lines
}

const isRubyComment = (line: string) => line.trim() === '' || line.trim().startsWith('#')

export type Member = { kind: 'class-method' | 'method' | 'constant' | 'whole'; name: string }

const indentOf = (line: string) => line.length - line.trimStart().length
const DEF = /^\s*def\s+(self\.)?([a-z_][\w]*[?!=]?)/
const CONSTANT = /^\s*([A-Z][A-Z0-9_]*)\s*=/
const CLASS_LEVEL = /^\s*(class|module)\s/

// What a changed Ruby line belongs to: the method or constant around it, or the class itself.
export const memberAt = (source: string[], lineNo: number): Member => {
  let at = lineNo - 1
  while (at < source.length && isRubyComment(source[at] ?? '')) at++
  const own = source[at] ?? ''
  const def = own.match(DEF)
  const constant = own.match(CONSTANT)
  let indent = indentOf(own)
  let found: Member | undefined =
    def?.[2] ? { kind: def[1] ? 'class-method' : 'method', name: def[2] } : constant?.[1] ? { kind: 'constant', name: constant[1] } : undefined

  for (let i = at - 1; i >= 0; i--) {
    const line = source[i] ?? ''
    if (isRubyComment(line) || indentOf(line) >= indent) continue
    indent = indentOf(line)
    if (found?.kind === 'method' && /^\s*class\s*<<\s*self/.test(line)) return { kind: 'class-method', name: found.name }
    if (found) {
      if (CLASS_LEVEL.test(line)) return found
      continue
    }
    const outerDef = line.match(DEF)
    const outerConstant = line.match(CONSTANT)
    if (outerDef?.[2]) found = { kind: outerDef[1] ? 'class-method' : 'method', name: outerDef[2] }
    else if (outerConstant?.[1]) found = { kind: 'constant', name: outerConstant[1] }
    else if (CLASS_LEVEL.test(line)) return { kind: 'whole', name: '' }
  }
  return found ?? { kind: 'whole', name: '' }
}

// The members a Ruby diff touches; empty when only comments or blank lines changed.
export const changedMembers = (before: string, after: string, lines: ChangedLines): Member[] => {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const touched = [
    ...lines.removed.filter(n => !isRubyComment(oldLines[n - 1] ?? '')).map(n => memberAt(oldLines, n)),
    ...lines.added.filter(n => !isRubyComment(newLines[n - 1] ?? '')).map(n => memberAt(newLines, n)),
  ]
  if (touched.some(member => member.kind === 'whole')) return [{ kind: 'whole', name: '' }]
  const unique = new Map(touched.map(member => [`${member.kind}:${member.name}`, member]))
  return [...unique.values()]
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const END = '([^A-Za-z0-9_?!]|$)'

// A git grep -E pattern for one member, or for any method call when it is an instance method.
export const memberPattern = (constant: string, member: Member): string => {
  if (member.kind === 'class-method') return `${escapeRegex(constant)}\\.${escapeRegex(member.name)}${END}`
  if (member.kind === 'constant') return `${escapeRegex(constant)}::${escapeRegex(member.name)}${END}`
  if (member.kind === 'method') return `\\.${escapeRegex(member.name)}${END}`
  return `${escapeRegex(constant)}${END}`
}

export const memberLabel = (member: Member): string =>
  member.kind === 'class-method' ? `.${member.name}` : member.kind === 'constant' ? `::${member.name}` : member.kind === 'method' ? `#${member.name}` : ''
