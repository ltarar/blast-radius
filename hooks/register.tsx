import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Break, Consumer, RepoBlast } from '../types'
import { findBreaks, todoOf } from './breaks'
import type { Repo } from './breaks'
import { byRisk, changedFiles, consumersOf, expandHome, gemNameOf, isCommentLine, npmNameOf, parseGrepHits, repoOf } from './radius'
import type { Level, Published } from './radius'

const PANE = 'blast-radius'
// Inline panes can't be scrolled on the main screen, so callers are trimmed to keep most results within this.
const MAX_PANE_ROWS = 15
const MAX_CALLERS = 3
const repos = atom({ plugin: 'blast-radius', key: 'repos' } as const, [])
const focus = atom({ plugin: 'blast-radius', key: 'focus' } as const, [])
const showAll = atom({ plugin: 'blast-radius', key: 'showAll' } as const, false)
// The last check of each repo, kept while its diff stays the same, since the pane re-checks after every turn.
const lastCheck = new Map<string, { diff: string; blast: RepoBlast }>()
// Refreshes overlap (session start, focus changes, every turn), so only the newest may write its results.
let newestRefresh = 0

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

async function publishedBy($: EngineInterface, repoRoot: string): Promise<Published> {
  const gemspec = (await $.fs.list(repoRoot)).find(entry => entry.name.endsWith('.gemspec'))
  const packageJson = await readIfThere($, `${repoRoot}/package.json`)
  return {
    gem: gemspec ? gemNameOf(await $.fs.read(`${repoRoot}/${gemspec.name}`)) : undefined,
    npm: packageJson ? npmNameOf(packageJson) : undefined,
  }
}

// A repo on disk, as the checks see it; each file is read at most once per check.
function repoAt($: EngineInterface, name: string, repoRoot: string, base: string): Repo {
  const files = new Map<string, Promise<string | undefined>>()
  return {
    name,
    read: path => {
      if (!files.has(path)) files.set(path, readIfThere($, `${repoRoot}/${path}`))
      return files.get(path) as Promise<string | undefined>
    },
    readBefore: path => git($, repoRoot, ['show', `${base}:${path}`]),
    grep: async (pattern, only = []) => {
      const found = await git($, repoRoot, ['grep', '-n', '-E', '--untracked', '-e', pattern, ...(only.length > 0 ? ['--', ...only] : [])])
      return parseGrepHits(found ?? '').filter(hit => !isCommentLine(hit.code))
    },
    filesMentioning: async word => ((await git($, repoRoot, ['grep', '-l', '-w', '-F', '--untracked', '-e', word])) ?? '').split('\n').filter(Boolean),
  }
}

async function blastOfRepo($: EngineInterface, repo: string, consumers: Consumer[], run: number): Promise<RepoBlast | undefined> {
  const rootDir = await reposRoot($)
  const repoRoot = `${rootDir}/${repo}`
  const base = await baseOf($, repoRoot)
  const diff = await git($, repoRoot, ['diff', '--name-status', '--no-renames', base])
  const untracked = await git($, repoRoot, ['ls-files', '--others', '--exclude-standard'])
  const files = changedFiles(diff ?? '', untracked ?? '')
  if (files.length === 0) return undefined
  const untrackedFiles = (untracked ?? '').split('\n').filter(Boolean)
  const untrackedContents = untrackedFiles.length > 0 ? await git($, repoRoot, ['hash-object', '--', ...untrackedFiles]) : ''
  const fullDiff = `${await git($, repoRoot, ['diff', base])}\n${untracked}\n${untrackedContents}\n${consumers.map(c => c.repo).join(',')}`
  const last = lastCheck.get(repo)
  if (last?.diff === fullDiff) return last.blast

  const here = repoAt($, repo, repoRoot, base)
  const others = consumers.map(consumer => repoAt($, consumer.repo, `${rootDir}/${consumer.repo}`, 'HEAD'))
  const blast: RepoBlast = {
    repo,
    branch: await branchOf($, repoRoot),
    fileCount: files.length,
    breaks: await findBreaks(here, files, others),
    todo: await todoOf(here, files),
  }
  if (run === newestRefresh) lastCheck.set(repo, { diff: fullDiff, blast })
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
  const run = ++newestRefresh
  const all = await gitRepos($)
  const focused = await focusedRepos($)
  const scope = (await read($, showAll)) ? all : all.filter(name => focused.has(name))
  if (scope.length === 0) {
    if (run !== newestRefresh) return
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
    const blast = await blastOfRepo($, name, consumers, run).catch(() => undefined)
    if (blast) found.push(blast)
  }
  if (run !== newestRefresh) return
  await update($, repos, () => found)
  $.ui.status(found.length > 0 ? summary(found) : undefined)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const DOTS = { red: '🔴', yellow: '🟡' } as const

const problemCount = (one: RepoBlast) => one.breaks.length + (one.todo && one.todo.added > 0 ? 1 : 0)

type Line = { text: string; color?: Level; bold?: boolean; dim?: boolean }

const BLANK: Line = { text: ' ' }

function paneLines(list: RepoBlast[]): Line[] {
  if (list.length === 0) return [{ text: 'No changes in focus. Run /blast-radius <repo> to add a repo, or /blast-radius all.', dim: true }]
  return list.flatMap((one, i) => [
    ...(i > 0 ? [BLANK] : []),
    { text: `💥 ${one.repo} · ${one.branch} · ${plural(one.fileCount, 'file')} changed`, bold: true },
    // Packwerk breaks sort with the rest, so every 🔴 comes before any 🟡.
    ...byRisk([...one.breaks.map(b => ({ level: b.level, lines: breakLines(b) })), ...todoBlock(one)]).flatMap(block => block.lines),
    ...(problemCount(one) === 0 ? [BLANK, { text: '🟢 Nothing in this branch breaks other code.', color: 'green' as const }] : []),
  ])
}

function breakLines(b: Break): Line[] {
  return [
    BLANK,
    { text: `${DOTS[b.level]} ${b.text}`, color: b.level },
    ...(b.fix ? [{ text: `   💡 ${b.fix}`, color: b.level }] : []),
    ...b.uses.slice(0, MAX_CALLERS).map(use => ({ text: `   ${use.path}:${use.line}`, dim: true })),
    ...(b.uses.length > MAX_CALLERS ? [{ text: `   and ${b.uses.length - MAX_CALLERS} more`, dim: true }] : []),
    ...(b.testUses > 0 ? [{ text: `   ${b.uses.length > 0 ? 'and ' : ''}${plural(b.testUses, 'line')} in specs`, dim: true }] : []),
    ...b.repoUses.map(r => ({
      text: `   ${r.repo}: ${plural(r.uses.length + r.testUses, 'place')}${r.uses[0] ? `, e.g. ${r.uses[0].path}:${r.uses[0].line}` : ''}`,
      dim: true,
    })),
  ]
}

function todoBlock(one: RepoBlast): { level: Level; lines: Line[] }[] {
  if (!one.todo) return []
  const added = one.todo.items.filter(item => item.kind === 'new')
  if (added.length > 0) {
    const lines = [
      BLANK,
      ...added.slice(0, MAX_CALLERS).map(item => ({ text: `🔴 ${item.file.split('/').pop()} now uses ${item.rule}.`, color: 'red' as const })),
      ...(added.length > MAX_CALLERS ? [{ text: `   and ${added.length - MAX_CALLERS} more Packwerk rule breaks`, dim: true }] : []),
    ]
    return [{ level: 'red', lines }]
  }
  return one.todo.fixed > 0 ? [{ level: 'green', lines: [BLANK, { text: `⚪ You fixed ${plural(one.todo.fixed, 'Packwerk rule break')}.`, dim: true }] }] : []
}

function summary(list: RepoBlast[]) {
  return list
    .map(one => `💥 ${one.repo}: ${problemCount(one) === 0 ? 'nothing breaks' : `${plural(problemCount(one), 'thing')} can break`}`)
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

    // Asking for the pane checks again from scratch, since the cache can't see edits in other repos.
    lastCheck.clear()
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
