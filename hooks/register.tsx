import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Consumer, FileBlast, RepoBlast, TodoChange, Usage } from '../types'
import {
  addTodo,
  adviceFor,
  byRisk,
  diffTodo,
  expandHome,
  isTodoFile,
  parseTodo,
  changedFiles,
  changedMembers,
  constantOf,
  consumersOf,
  dependentsOf,
  gemNameOf,
  importPattern,
  isPrivate,
  isCommentLine,
  isTest,
  languageOf,
  memberLabel,
  memberPattern,
  moduleTailOf,
  npmNameOf,
  ownerOf,
  parseDiffLines,
  parseGrepHits,
  parsePackage,
  repoOf,
  shouldList,
} from './radius'
import type { Member, PackageInfo, Published } from './radius'

const PANE = 'blast-radius'
const MAX_CHECKED = 30
// Inline panes can't be scrolled on the main screen, so callers are trimmed to keep most results within this.
const MAX_PANE_ROWS = 15
const MAX_CALLERS = 3
const repos = atom({ plugin: 'blast-radius', key: 'repos' } as const, [])
const focus = atom({ plugin: 'blast-radius', key: 'focus' } as const, [])
const showAll = atom({ plugin: 'blast-radius', key: 'showAll' } as const, false)
const fileCache = new Map<string, FileBlast>()

let rootSetting = ''
let root: Promise<string> | undefined
const reposRoot = ($: EngineInterface) =>
  (root ??= $.env.get('HOME').then(home => expandHome(rootSetting, home ?? '')))

async function git($: EngineInterface, repoRoot: string, args: string[]) {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { cwd: repoRoot })
  return exitCode === 0 ? stdout.trim() : undefined
}

async function readIfThere($: EngineInterface, path: string) {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
}

async function baseOf($: EngineInterface, repoRoot: string) {
  const remoteHead = await git($, repoRoot, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  for (const ref of [remoteHead, 'origin/master', 'origin/main']) {
    if (!ref) continue
    const base = await git($, repoRoot, ['merge-base', 'HEAD', ref])
    if (base) return base
  }
  return 'HEAD'
}

async function branchOf($: EngineInterface, repoRoot: string) {
  const branch = await git($, repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'HEAD') return branch ?? '?'
  return `detached at ${(await git($, repoRoot, ['rev-parse', '--short', 'HEAD'])) ?? '?'}`
}

async function loadPackages($: EngineInterface, repoRoot: string) {
  const found = await git($, repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '*package.yml', 'package.yml'])
  const packages: Record<string, PackageInfo> = {}
  for (const path of (found ?? '').split('\n').filter(p => p === 'package.yml' || p.endsWith('/package.yml'))) {
    const yaml = await readIfThere($, `${repoRoot}/${path}`)
    if (yaml !== undefined) packages[path === 'package.yml' ? '.' : path.slice(0, -'/package.yml'.length)] = parsePackage(yaml)
  }
  return packages
}

async function publishedBy($: EngineInterface, repoRoot: string): Promise<Published> {
  const gemspec = (await $.fs.list(repoRoot)).find(entry => entry.name.endsWith('.gemspec'))
  const packageJson = await readIfThere($, `${repoRoot}/package.json`)
  return {
    gem: gemspec ? gemNameOf(await $.fs.read(`${repoRoot}/${gemspec.name}`)) : undefined,
    npm: packageJson ? npmNameOf(packageJson) : undefined,
  }
}

async function searchUses($: EngineInterface, repoRoot: string, name: string, isRuby: boolean, members: Member[]) {
  if (!isRuby) return parseGrepHits((await git($, repoRoot, ['grep', '-n', '-E', '--untracked', '-e', importPattern(name)])) ?? '')

  const hits: Usage[] = []
  const shortName = name.split('::').pop() ?? name
  const mentioning = members.some(m => m.kind === 'method')
    ? ((await git($, repoRoot, ['grep', '-l', '-w', '-F', '--untracked', '-e', shortName])) ?? '').split('\n').filter(Boolean)
    : []
  for (const member of members) {
    if (member.kind === 'method' && mentioning.length === 0) continue
    const files = member.kind === 'method' ? ['--', ...mentioning] : []
    const found = await git($, repoRoot, ['grep', '-n', '-E', '--untracked', '-e', memberPattern(name, member), ...files])
    hits.push(...parseGrepHits(found ?? ''))
  }
  const seen = new Set<string>()
  return hits.filter(hit => !isCommentLine(hit.code) && !seen.has(`${hit.path}:${hit.line}`) && seen.add(`${hit.path}:${hit.line}`))
}

async function checkFile(
  $: EngineInterface,
  repoRoot: string,
  base: string,
  path: string,
  packages: Record<string, PackageInfo> | undefined,
  consumers: Consumer[],
): Promise<FileBlast | undefined> {
  const exists = await $.fs.exists(`${repoRoot}/${path}`)
  const stamp = exists ? (await $.fs.stat(`${repoRoot}/${path}`)).mtimeMs : 'gone'
  const key = `${repoRoot}:${path}:${stamp}:${base}`
  const cached = fileCache.get(key)
  if (cached) return cached

  const isRuby = languageOf(path) === 'ruby'
  const before = await git($, repoRoot, ['show', `${base}:${path}`])
  const after = exists ? await $.fs.read(`${repoRoot}/${path}`) : undefined
  const source = after ?? before
  const name = isRuby ? (source ? constantOf(source) : undefined) : moduleTailOf(path)
  if (!name) return undefined

  const whole: Member[] = [{ kind: 'whole', name: '' }]
  const members =
    isRuby && before !== undefined && after !== undefined
      ? changedMembers(before, after, parseDiffLines((await git($, repoRoot, ['diff', '-U0', base, '--', path])) ?? ''))
      : whole

  const pkg = packages ? ownerOf(path, packages) : undefined
  if (members.length === 0) {
    const file: FileBlast = { path, name, changed: [], isDeleted: false, visibleTo: [], uses: [], testUses: 0, repoUses: [] }
    fileCache.set(key, file)
    return file
  }

  const outside = (await searchUses($, repoRoot, name, isRuby, members)).filter(
    hit => hit.path !== path && (!packages || ownerOf(hit.path, packages) !== pkg),
  )
  const repoUses = []
  for (const consumer of consumers) {
    const hits = await searchUses($, `${await reposRoot($)}/${consumer.repo}`, name, isRuby, members)
    if (hits.length > 0) {
      repoUses.push({
        repo: consumer.repo,
        uses: hits.filter(hit => !isTest(hit.path)),
        testUses: hits.filter(hit => isTest(hit.path)).length,
      })
    }
  }

  const file: FileBlast = {
    path,
    name,
    changed: members.filter(m => m.kind !== 'whole').map(memberLabel),
    isDeleted: !exists,
    visibleTo: packages && pkg ? dependentsOf(pkg, packages) : [],
    uses: outside.filter((hit: Usage) => !isTest(hit.path)),
    testUses: outside.filter((hit: Usage) => isTest(hit.path)).length,
    repoUses,
  }
  fileCache.set(key, file)
  return file
}

async function blastOfRepo($: EngineInterface, repo: string, consumers: Consumer[]): Promise<RepoBlast | undefined> {
  const repoRoot = `${await reposRoot($)}/${repo}`
  const base = await baseOf($, repoRoot)
  const diff = await git($, repoRoot, ['diff', '--name-status', '--no-renames', base])
  const untracked = await git($, repoRoot, ['ls-files', '--others', '--exclude-standard'])
  const files = changedFiles(diff ?? '', untracked ?? '')
  if (files.length === 0) return undefined

  const packages = await loadPackages($, repoRoot)
  const usesPackwerk = '.' in packages
  const blast: RepoBlast = {
    repo,
    branch: await branchOf($, repoRoot),
    fileCount: files.length,
    usesPackwerk,
    listed: [],
    quiet: 0,
    tests: 0,
    notChecked: 0,
    consumers,
  }

  // Class names defined by the branch's files now, so a deleted file whose class moved isn't reported as broken.
  const definitions: Record<string, string> = {}
  for (const path of files) {
    if (languageOf(path) !== 'ruby' || isTest(path)) continue
    const source = await readIfThere($, `${repoRoot}/${path}`)
    const name = source ? constantOf(source) : undefined
    if (name) definitions[name] = path
  }

  let checked = 0
  for (const path of files) {
    if (isTodoFile(path)) {
      const before = (await git($, repoRoot, ['show', `${base}:${path}`])) ?? ''
      const after = (await readIfThere($, `${repoRoot}/${path}`)) ?? ''
      blast.todo = addTodo(blast.todo, diffTodo(parseTodo(before), parseTodo(after)))
    } else if (isTest(path)) blast.tests++
    else if (languageOf(path) === 'other' || checked >= MAX_CHECKED) blast.notChecked++
    else if (usesPackwerk && isPrivate(path, packages)) blast.quiet++
    else {
      checked++
      const found = await checkFile($, repoRoot, base, path, usesPackwerk ? packages : undefined, consumers).catch(() => undefined)
      const movedTo = found?.isDeleted && found.name ? definitions[found.name] : undefined
      const file = found && movedTo ? { ...found, movedTo } : found
      if (!file) blast.notChecked++
      else if (shouldList(file)) blast.listed.push(file)
      else blast.quiet++
    }
  }
  return blast
}

async function gitRepos($: EngineInterface) {
  const rootDir = await reposRoot($)
  const names: string[] = []
  if (!(await $.fs.exists(rootDir))) return names
  for (const entry of await $.fs.list(rootDir)) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${rootDir}/${entry.name}/.git`))) names.push(entry.name)
  }
  return names
}

async function addFocus($: EngineInterface, names: string[]) {
  if (names.length === 0) return
  const current = await read($, focus)
  if (names.every(name => current.includes(name))) return
  await update($, focus, list => [...new Set([...list, ...names])])
  void refresh($)
}

async function focusedRepos($: EngineInterface) {
  const sessionRepo = repoOf(await $.session.cwd(), await reposRoot($))
  return new Set([...(sessionRepo ? [sessionRepo] : []), ...(await read($, focus))])
}

async function refresh($: EngineInterface) {
  const all = await gitRepos($)
  const focused = await focusedRepos($)
  const scope = (await read($, showAll)) ? all : all.filter(name => focused.has(name))
  if (scope.length === 0) {
    await update($, repos, () => [])
    $.ui.status(undefined)
    return
  }

  const rootDir = await reposRoot($)
  const manifests: Record<string, { lock?: string; packageJson?: string }> = {}
  for (const name of all) {
    manifests[name] = {
      lock: await readIfThere($, `${rootDir}/${name}/Gemfile.lock`),
      packageJson: await readIfThere($, `${rootDir}/${name}/package.json`),
    }
  }

  const found: RepoBlast[] = []
  for (const name of scope) {
    const consumers = consumersOf(name, await publishedBy($, `${rootDir}/${name}`), manifests)
    const blast = await blastOfRepo($, name, consumers).catch(() => undefined)
    if (blast) found.push(blast)
  }
  await update($, repos, () => found)
  $.ui.status(found.length > 0 ? summary(found) : undefined)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const COLORS = { red: 'red', yellow: 'yellow', green: 'green' } as const

function consumerLine(one: RepoBlast) {
  const byVia = (via: Consumer['via']) => one.consumers.filter(c => c.via === via).map(c => c.repo)
  const verb = (repos: string[], one: string, many: string) => `${repos.join(', ')} ${repos.length === 1 ? one : many}`
  const parts = [
    byVia('gem').length > 0 && verb(byVia('gem'), 'uses it as a gem', 'use it as a gem'),
    byVia('npm').length > 0 && verb(byVia('npm'), 'uses it as an npm package', 'use it as an npm package'),
  ].filter(Boolean)
  return parts.length > 0 ? `${parts.join('. ')}.` : undefined
}

type Line = { text: string; color?: 'red' | 'yellow' | 'green'; bold?: boolean; dim?: boolean }

const BLANK: Line = { text: ' ' }

function paneLines(list: RepoBlast[]): Line[] {
  if (list.length === 0) return [{ text: 'No changes in focus. Run /blast-radius <repo> to add a repo, or /blast-radius all.', dim: true }]
  return list.flatMap((one, i) => [
    ...(i > 0 ? [BLANK] : []),
    { text: `💥 ${one.repo} · ${one.branch} · ${plural(one.fileCount, 'file')} changed`, bold: true },
    ...byRisk(one.listed).flatMap(fileLines),
    ...todoLines(one),
    ...(one.quiet > 0
      ? [BLANK, { text: `🟢 ${plural(one.quiet, 'other changed file')} ${one.quiet === 1 ? "isn't" : "aren't"} used anywhere else.`, color: 'green' as const }]
      : []),
    ...(consumerLine(one) ? [{ text: `🌐 ${consumerLine(one)}`, dim: true }] : []),
  ])
}

function fileLines(f: FileBlast): Line[] {
  const advice = adviceFor(f)
  const dot = { red: '🔴', yellow: '🟡', green: '🟢' }[advice.level]
  return [
    BLANK,
    { text: `${dot} ${advice.text}`, color: COLORS[advice.level] },
    ...f.uses.slice(0, MAX_CALLERS).map(use => ({ text: `   ${use.path}:${use.line}`, dim: true })),
    ...(f.uses.length > MAX_CALLERS ? [{ text: `   and ${f.uses.length - MAX_CALLERS} more`, dim: true }] : []),
    ...f.repoUses.map(r => ({
      text: `   ${r.repo}: ${plural(r.uses.length, 'place')}${r.uses[0] ? `, e.g. ${r.uses[0].path}:${r.uses[0].line}` : ''}`,
      dim: true,
    })),
  ]
}

function todoLines(one: RepoBlast): Line[] {
  if (!one.todo) return []
  const added = one.todo.items.filter(item => item.kind === 'new')
  if (added.length > 0) {
    return [
      BLANK,
      ...added.slice(0, MAX_CALLERS).map(item => ({ text: `🔴 ${item.file.split('/').pop()} now uses ${item.rule}.`, color: 'red' as const })),
      ...(added.length > MAX_CALLERS ? [{ text: `   and ${added.length - MAX_CALLERS} more Packwerk rule breaks`, dim: true }] : []),
    ]
  }
  return one.todo.fixed > 0 ? [BLANK, { text: `⚪ You fixed ${plural(one.todo.fixed, 'Packwerk rule break')}.`, dim: true }] : []
}

function summary(list: RepoBlast[]) {
  return list
    .map(one => `💥 ${one.repo}: ${one.listed.length > 0 ? `${plural(one.listed.length, 'file')} to look at` : 'nothing reaches outside'} (${plural(one.fileCount, 'file')} changed)`)
    .join(' · ')
}

export const register: Register = (on, options) => {
  rootSetting = String(options.reposRoot)
  root = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'blast-radius',
      description: 'Show what your branch changes can affect. Args: <repo...> to focus, all, or clear',
      argumentHint: '[repo...|all|clear]',
    })
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'blast-radius' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'all') await update($, showAll, () => true)
    else if (arg === 'clear') {
      await update($, focus, () => [])
      await update($, showAll, () => false)
    } else if (arg !== '') {
      const known = await gitRepos($)
      const names = arg.split(/\s+/)
      const unknown = names.filter(name => !known.includes(name))
      if (unknown.length > 0) return { text: `Not a git repo under ${await reposRoot($)}: ${unknown.join(', ')}` }
      await update($, focus, list => [...new Set([...list, ...names])])
      await update($, showAll, () => false)
    } else await update($, showAll, () => false)

    await refresh($)
    await $.ui.open({ id: PANE, title: 'Blast radius', rows: Math.min(MAX_PANE_ROWS, paneLines(await read($, repos)).length) })
    const shown = await read($, showAll)
    return { text: shown ? 'Blast radius: all repos.' : `Blast radius: ${[...(await focusedRepos($))].join(', ') || 'no repos in focus yet'}.` }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    const repo = repoOf(e.file_path, await reposRoot($))
    if (repo) await addFocus($, [repo])
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    const repo = repoOf(e.file_path, await reposRoot($))
    if (repo) await addFocus($, [repo])
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void refresh($)
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {paneLines(await read($, repos)).map(line => (
          <Text bold={line.bold} dimColor={line.dim} color={line.color}>
            {line.text}
          </Text>
        ))}
      </Box>
    )
  })
}
