import type { Break, RepoUses, TodoChange, Usage } from '../types'
import { addTodo, diffTodo, importPattern, importsFromOutside, importsModule, isTest, isTodoFile, languageOf, modulePathOf, moduleTailOf, parseTodo, referencePattern, referencesIn, relativeImportPattern } from './radius'
import { breakingChanges, callArguments, fitsCall, mergeOutlines, methodKey, outlineOf, resolveReference, scopesAt } from './ruby'
import type { Outline, RubyChange } from './ruby'

// What the checks need from a repo: its files now and at the branch's base, and git grep.
export type Repo = {
  name: string
  read: (path: string) => Promise<string | undefined>
  readBefore: (path: string) => Promise<string | undefined>
  // `git grep -E`, with comment lines left out.
  grep: (pattern: string, files?: string[]) => Promise<Usage[]>
  // `git grep -l -w -F`: the files that mention a word.
  filesMentioning: (word: string) => Promise<string[]>
}

// Whether some file in the repo still defines `name` (a constant, or a public `Owner.method` / `Owner#method`).
async function isDefinedAnywhere(repo: Repo, name: string) {
  const method = name.match(/^(.*)([.#])([^.#:]+)$/)
  const shortName = (method?.[3] ?? name.split('::').pop() ?? name).replace(/[?!=]$/, '')
  const pattern = method
    ? `def[[:space:]]+(self\\.)?${shortName}([^A-Za-z0-9_]|$)`
    : `((class|module)[[:space:]]+([A-Za-z0-9_:]*::)?${shortName}([^A-Za-z0-9_]|$))|(^[[:space:]]*${shortName}[[:space:]]*=[^=~])`
  const files = [...new Set((await repo.grep(pattern)).map(hit => hit.path).filter(path => path.endsWith('.rb')))]
  for (const path of files) {
    const source = await repo.read(path)
    if (!source) continue
    const outline = outlineOf(source)
    const def = outline.methods.get(name)
    const callable = def !== undefined && (!def.isPrivate || def.name === 'initialize')
    if (method ? callable : outline.constants.has(name)) return true
  }
  return false
}

// Lines that refer to `target`, a constant, optionally followed by a method call such as `.call`.
// A reference counts only when Ruby would resolve it to `target`, not to a closer constant of the same name.
// When `target` is gone, Ruby looks further out, so a reference that finds another constant of that name still works.
async function referencesTo(repo: Repo, target: string, suffix = '', isGone = false) {
  const shortName = target.split('::').pop() ?? target
  const defined = new Map<string, Promise<boolean>>()
  const exists = (name: string) => {
    if (!defined.has(name)) defined.set(name, isDefinedAnywhere(repo, name))
    return defined.get(name) as Promise<boolean>
  }

  const found: Usage[] = []
  for (const hit of await repo.grep(referencePattern(shortName, suffix))) {
    if (!hit.path.endsWith('.rb')) continue
    const source = await repo.read(hit.path)
    if (!source) continue
    const scopes = scopesAt(source, hit.line)
    for (const reference of referencesIn(hit.code, shortName)) {
      const candidates = resolveReference(reference, scopes, () => false)
      const at = candidates.indexOf(target)
      if (at === -1) continue
      const shadowed = await Promise.all(candidates.slice(0, at).map(exists))
      const foundFurtherOut = isGone && (await Promise.all(candidates.slice(at + 1).map(exists))).some(Boolean)
      if (!shadowed.some(Boolean) && !foundFurtherOut) {
        found.push(hit)
        break
      }
    }
  }
  return found
}

// Calls of an instance method by name, in files that mention its class: a best guess, since Ruby can't say for sure.
async function instanceCalls(repo: Repo, owner: string, name: string) {
  const mentioning = await repo.filesMentioning(owner.split('::').pop() ?? owner)
  if (mentioning.length === 0) return []
  return repo.grep(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_?!]|$)`, mentioning)
}

async function callsOf(repo: Repo, change: RubyChange) {
  if (change.kind === 'worker-arguments' || change.kind === 'worker-alias-removed' || change.kind === 'worker-perform-removed') return []
  if (change.kind === 'worker-removed') return referencesTo(repo, change.worker, '', true)
  if (change.kind === 'constant-removed') return referencesTo(repo, change.constant, '', true)
  const { owner, name, isClassMethod } = change.method
  if (!isClassMethod && name === 'initialize') return referencesTo(repo, owner, '\\.new')
  if (isClassMethod) return referencesTo(repo, owner, `\\.${name.replace(/[?!]/g, '\\$&')}`)
  return instanceCalls(repo, owner, name)
}

// The calls a change breaks: for new arguments, only the calls that no longer fit them.
async function usesOf(repo: Repo, change: RubyChange) {
  const calls = await callsOf(repo, change)
  if (change.kind !== 'arguments-changed') return calls
  const called = change.method.name === 'initialize' ? 'new' : change.method.name
  const broken = await Promise.all(
    calls.map(async use => {
      const args = callArguments(use.code, called) ?? callArguments(await fullCall(repo, use, called), called)
      return args === undefined || fitsCall(change.method.params, args) === false
    }),
  )
  return calls.filter((_, i) => broken[i])
}

// A call that runs onto the lines below `use`, joined into one line once its arguments close.
async function fullCall(repo: Repo, use: Usage, called: string) {
  const lines = ((await repo.read(use.path)) ?? '').split('\n').slice(use.line - 1, use.line + 20)
  let text = ''
  for (const line of lines) {
    text = `${text} ${line.trim()}`.trim()
    if (callArguments(text, called) !== undefined) break
  }
  return text
}

// The last two parts of a name, enough to recognise it in a narrow pane: `Steps::AssignConsultant.new`.
export const shortLabel = (name: string): string => {
  const [constant = name, member = ''] = name.split(/(?=[.#][^.#:]+$)/)
  return `${constant.split('::').slice(-2).join('::')}${member}`
}

const places = (n: number) => (n === 1 ? '1 place' : `${n} places`)
const pick = (n: number, one: string, many: string) => (n === 1 ? one : many)

// The sentence the pane shows for a change, given how many places it breaks.
export const describe = (change: RubyChange, count: number): Pick<Break, 'level' | 'text' | 'fix'> => {
  if (change.kind === 'worker-removed') {
    return {
      level: 'red',
      text: `You removed the Sidekiq worker ${change.worker}. Jobs already queued under that name will fail.`,
      fix: change.renamedTo ? `Keep an alias for the old name: ${change.worker} = ::${change.renamedTo}` : 'Keep the class until its queue is empty.',
    }
  }
  if (change.kind === 'worker-alias-removed') {
    return {
      level: 'yellow',
      text: `You removed ${change.alias}, an alias that keeps older Sidekiq jobs working. Jobs still queued under that name will fail.`,
      fix: 'Remove it only once Sidekiq has no jobs under this name.',
    }
  }
  if (change.kind === 'worker-perform-removed') {
    return change.parent
      ? {
          level: 'yellow',
          text: `You removed ${change.worker}#perform. Jobs already queued will fail unless ${change.parent} has perform.`,
          fix: `Check that ${change.parent} defines perform.`,
        }
      : { level: 'red', text: `You removed ${change.worker}#perform. Jobs already queued will fail.`, fix: 'Keep perform until the queue is empty.' }
  }
  if (change.kind === 'worker-arguments') {
    return {
      level: 'red',
      text: `You changed ${change.worker}#perform from (${change.before}) to (${change.after}). Jobs already queued carry the old arguments.`,
      fix: 'Accept both forms until the queue is empty.',
    }
  }
  if (change.kind === 'constant-removed') {
    return { level: 'red', text: `You removed ${shortLabel(change.constant)}, but ${places(count)} still ${pick(count, 'uses', 'use')} it. ${pick(count, 'It', 'They')} will break:` }
  }
  const { owner, name, isClassMethod, params } = change.method
  const what = shortLabel(name === 'initialize' ? `${owner}.new` : methodKey(owner, name, isClassMethod))
  // An instance method call can't be tied to its class for sure, so those are only a maybe.
  const isSure = isClassMethod || name === 'initialize'
  if (change.kind === 'method-removed') {
    return isSure
      ? { level: 'red', text: `You removed ${what}, but ${places(count)} still ${pick(count, 'calls', 'call')} it. ${pick(count, 'It', 'They')} will break:` }
      : { level: 'yellow', text: `You removed ${what}. ${places(count)} ${pick(count, 'calls', 'call')} a method with that name. Check ${pick(count, "it doesn't", "they don't")} mean this one:` }
  }
  return isSure
    ? { level: 'red', text: `You changed ${what} to take (${params}). ${places(count)} no longer ${pick(count, 'fits', 'fit')}:` }
    : { level: 'yellow', text: `You changed ${what} to take (${params}). ${places(count)} calling that name may no longer fit:` }
}

// The hits come from git grep over local repos, not from a request, so the loop rule for request input doesn't apply.
const splitTests = (hits: Usage[]) => ({
  uses: hits.filter(hit => !isTest(hit.path)), // nosemgrep
  testUses: hits.filter(hit => isTest(hit.path)).length, // nosemgrep
})

const countOf = (found: { uses: Usage[]; testUses: number }, repoUses: RepoUses[]) =>
  found.uses.length + found.testUses + repoUses.reduce((n, r) => n + r.uses.length + r.testUses, 0)

// The Ruby outlines of the changed files, before and after the branch.
async function outlinesOf(repo: Repo, files: string[]) {
  const before: Outline[] = []
  const after: Outline[] = []
  for (const path of files.filter(file => languageOf(file) === 'ruby' && !isTest(file))) {
    const old = await repo.readBefore(path)
    const now = await repo.read(path)
    if (old) before.push(outlineOf(old))
    if (now) after.push(outlineOf(now))
  }
  return { before: mergeOutlines(before), after: mergeOutlines(after) }
}

// The name callers know a change by, which a file the branch didn't touch could still define.
const nameOf = (change: RubyChange): string => {
  switch (change.kind) {
    case 'worker-removed':
    case 'worker-arguments':
      return change.worker
    case 'worker-perform-removed':
      return methodKey(change.worker, 'perform', false)
    case 'worker-alias-removed':
      return change.alias
    case 'constant-removed':
      return change.constant
    default:
      return methodKey(change.method.owner, change.method.name, change.method.isClassMethod)
  }
}

async function usesInOthers(others: Repo[], change: RubyChange) {
  const repoUses: RepoUses[] = []
  for (const other of others) {
    const hits = splitTests(await usesOf(other, change))
    if (hits.uses.length + hits.testUses > 0) repoUses.push({ repo: other.name, ...hits })
  }
  return repoUses
}

async function rubyBreaks(repo: Repo, files: string[], others: Repo[]) {
  const { before, after } = await outlinesOf(repo, files)
  const breaks: Break[] = []
  for (const change of breakingChanges(before, after)) {
    const keepsName = change.kind !== 'arguments-changed' && change.kind !== 'worker-arguments'
    // Moved to a file the branch didn't touch, still under the same name: callers still work.
    if (keepsName && (await isDefinedAnywhere(repo, nameOf(change)))) continue

    const here = splitTests(await usesOf(repo, change))
    const repoUses = await usesInOthers(others, change)
    const count = countOf(here, repoUses)
    // Queued Sidekiq jobs break even when no code calls the worker.
    if (change.kind.startsWith('worker-') || count > 0) breaks.push({ ...describe(change, count), ...here, repoUses })
  }
  return breaks
}

async function jsBreaks(repo: Repo, files: string[], others: Repo[]) {
  const breaks: Break[] = []
  for (const path of files.filter(file => languageOf(file) === 'js' && !isTest(file))) {
    if ((await repo.read(path)) !== undefined) continue
    const tail = moduleTailOf(path)
    const modulePath = modulePathOf(path)
    const twins = files.filter(file => file !== path && languageOf(file) === 'js' && modulePathOf(file) === modulePath)
    const replaced = (await Promise.all(twins.map(file => repo.read(file)))).some(source => source !== undefined)
    if (replaced) continue

    const hits = [...(await repo.grep(importPattern(tail))), ...(await repo.grep(relativeImportPattern(modulePath.split('/').pop() ?? '')))]
    const here = splitTests(
      hits.filter((hit, i) => importsModule(hit.path, hit.code, modulePath, tail) && hits.findIndex(other => other.path === hit.path && other.line === hit.line) === i),
    )
    const repoUses: RepoUses[] = []
    for (const other of others) {
      const hits = splitTests((await other.grep(importPattern(tail))).filter(hit => importsFromOutside(hit.code, tail)))
      if (hits.uses.length + hits.testUses > 0) repoUses.push({ repo: other.name, ...hits })
    }
    const count = countOf(here, repoUses)
    if (count > 0) {
      breaks.push({ level: 'red', text: `You deleted ${path}, but ${places(count)} still ${pick(count, 'imports', 'import')} it. ${pick(count, 'It', 'They')} will break:`, ...here, repoUses })
    }
  }
  return breaks
}

// What the branch's changed files break, in this repo and in `others`, the repos that use it.
export const findBreaks = async (repo: Repo, files: string[], others: Repo[]): Promise<Break[]> => [
  ...(await rubyBreaks(repo, files, others)),
  ...(await jsBreaks(repo, files, others)),
]

export async function todoOf(repo: Repo, files: string[]): Promise<TodoChange | undefined> {
  let todo: TodoChange | undefined
  for (const path of files.filter(isTodoFile)) {
    const before = parseTodo((await repo.readBefore(path)) ?? '')
    const after = parseTodo((await repo.read(path)) ?? '')
    const gone = [...new Set(Object.entries(before).flatMap(([key, files]) => files.filter(file => !(after[key] ?? []).includes(file))))]
    const present = await Promise.all(gone.map(async file => (await repo.read(file)) !== undefined))
    const existing = new Set(gone.filter((_, i) => present[i]))
    todo = addTodo(todo, diffTodo(before, after, file => existing.has(file)))
  }
  return todo
}
