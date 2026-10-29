// A light reading of Ruby source by indentation: enough to know which constants and methods a file
// defines, and what a constant reference on a given line resolves to. It assumes rubocop-style layout.

export type MethodDef = { owner: string; name: string; isClassMethod: boolean; params: string; isPrivate: boolean }

// `workers` holds the Sidekiq workers a file defines; an abstract base (one that raises NotImplementedError) is left out.
// `aliases` maps a constant assigned another constant (`Old = New`) to what it points at, as written.
// `kinds` says how each constant was defined.
// `parents` maps a class to the parent class it names, as written.
export type Outline = {
  constants: Set<string>
  kinds: Map<string, 'class' | 'module' | 'value'>
  methods: Map<string, MethodDef>
  workers: Set<string>
  aliases: Map<string, string>
  parents: Map<string, string>
}

type Scope = { indent: number; kind: 'namespace' | 'singleton' | 'def'; name: string; isPrivate: boolean }

const isBlankOrComment = (line: string) => line.trim() === '' || line.trim().startsWith('#')
const indentOf = (line: string) => line.length - line.trimStart().length

const NAMESPACE = /^\s*(class|module)\s+((?:::)?[A-Z][\w:]*)/
const SINGLETON = /^\s*class\s*<<\s*self\b/
const DEF = /^\s*(?:private\s+|protected\s+|public\s+)?def\s+(self\.)?([a-zA-Z_][\w]*[?!=]?)\s*(\(([^)]*)\)|([^=\n;#]*))?/
const ASSIGNED_CONSTANT = /^\s*([A-Z][A-Za-z0-9_]*)\s*=[^=~]/
const VISIBILITY = /^\s*(private|protected|public)\s*$/
// One-argument checks, so a line is never tested inside a callback that also takes other arguments.
const opensSingleton = (line: string) => SINGLETON.test(line)
const closesOnSameLine = (line: string) => /\bend\s*$/.test(line)
const isEndlessDef = (line: string) => /\)\s*=\s*\S/.test(line)
const isDef = (line: string) => DEF.test(line)
const marksWorker = (line: string) => SIDEKIQ.test(line)
const isPrivateDef = (line: string) => /^\s*(private|protected)\s+def/.test(line)
const looksLikeWorker = (names: string) => /Workers?::|Worker$/.test(names)
const isNameChar = (char: string) => /[A-Za-z0-9_?!]/.test(char)

const PARENT = /^\s*class\s+(?:::)?[A-Z][\w:]*\s*<\s*((?:::)?[A-Z][\w:]*)/
const SIDEKIQ = /^\s*(include\s+Sidekiq::(Job|Worker)\b|sidekiq_options\b)/

export const methodKey = (owner: string, name: string, isClassMethod: boolean) => `${owner}${isClassMethod ? '.' : '#'}${name}`

const namespaceOf = (stack: Scope[]) =>
  stack
    .filter(scope => scope.kind === 'namespace')
    .reduce((qualified, scope) => (scope.name.startsWith('::') ? scope.name.slice(2) : qualified ? `${qualified}::${scope.name}` : scope.name), '')

// Walks the source, calling `visit` with the open scopes before each line is read.
const walk = (source: string, visit: (line: string, lineNo: number, stack: Scope[]) => void) => {
  const stack: Scope[] = []
  source.split('\n').forEach((line, i) => {
    if (!isBlankOrComment(line)) {
      while (stack.length > 0 && indentOf(line) <= (stack[stack.length - 1]?.indent ?? 0)) stack.pop()
    }
    visit(line, i + 1, stack)
    if (isBlankOrComment(line)) return
    const namespace = line.match(NAMESPACE)
    if (opensSingleton(line)) stack.push({ indent: indentOf(line), kind: 'singleton', name: '', isPrivate: false })
    else if (namespace?.[2] && !closesOnSameLine(line)) {
      stack.push({ indent: indentOf(line), kind: 'namespace', name: namespace[2], isPrivate: false })
    } else if (isDef(line) && !closesOnSameLine(line) && !isEndlessDef(line)) {
      stack.push({ indent: indentOf(line), kind: 'def', name: '', isPrivate: false })
    }
  })
}

const DEF_OPEN = /^\s*(?:(?:private|protected|public)\s+)?def\s+(?:self\.)?[a-zA-Z_]\w*[?!=]?\s*\(/

// Where the bracket opened at `open` closes, skipping brackets inside strings; -1 if it doesn't close.
const closingBracket = (text: string, open: number) => {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let i = open; i < text.length; i++) {
    const char = text.charAt(i)
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char) && --depth === 0) return i
  }
  return -1
}

// A `def` line whose parameter list runs onto the lines below, joined into one line.
const fullDef = (lines: string[], at: number) => {
  let line = lines[at] ?? ''
  const open = line.match(DEF_OPEN)?.[0].length
  if (open === undefined) return line
  for (let i = at + 1; i < lines.length && closingBracket(line, open - 1) === -1; i++) line += ` ${(lines[i] ?? '').trim()}`
  return line
}

// The parameters written between a def's brackets, or after its name when it has none.
const paramsOf = (line: string, bare: string | undefined) => {
  const open = line.match(DEF_OPEN)?.[0].length
  if (open === undefined) return bare ?? ''
  const close = closingBracket(line, open - 1)
  return line.slice(open, close === -1 ? undefined : close)
}

// A `class` or `module` line: its constant, kind and parent class. False for any other line.
const readNamespace = (outline: Outline, line: string, here: string): boolean => {
  const namespace = line.match(NAMESPACE)
  if (!namespace?.[2] || opensSingleton(line)) return false
  const name = namespace[2].startsWith('::') ? namespace[2].slice(2) : here ? `${here}::${namespace[2]}` : namespace[2]
  outline.constants.add(name)
  outline.kinds.set(name, namespace[1] === 'module' ? 'module' : 'class')
  const parent = line.match(PARENT)?.[1]
  if (parent) outline.parents.set(name, parent)
  return true
}

// A constant assignment, and what it aliases when it names another constant. False for any other line.
const readConstant = (outline: Outline, line: string, here: string): boolean => {
  const constant = line.match(ASSIGNED_CONSTANT)
  if (!constant?.[1]) return false
  const name = here ? `${here}::${constant[1]}` : constant[1]
  outline.constants.add(name)
  outline.kinds.set(name, 'value')
  const target = line.match(/=\s*((?:::)?[A-Z][\w:]*)\s*(?:#.*)?$/)?.[1]
  if (target) outline.aliases.set(name, target)
  return true
}

// A `def`, with `defLine` holding its whole parameter list.
const readDef = (outline: Outline, defLine: string, line: string, here: string, body: Scope | undefined) => {
  const def = defLine.match(DEF)
  if (!def?.[2]) return
  const isClassMethod = Boolean(def[1]) || body?.kind === 'singleton'
  // A bare `private` only covers instance methods, so `def self.x` below it stays public.
  const isPrivate = isPrivateDef(line) || (!def[1] && Boolean(body?.isPrivate))
  const params = paramsOf(defLine, def[5]).replace(/,\s*$/, '').trim()
  outline.methods.set(methodKey(here, def[2], isClassMethod), { owner: here, name: def[2], isClassMethod, params, isPrivate })
}

export const outlineOf = (source: string): Outline => {
  const outline: Outline = { constants: new Set(), kinds: new Map(), methods: new Map(), workers: new Set(), aliases: new Map(), parents: new Map() }
  const lines = source.split('\n')
  const isAbstract = /\bNotImplementedError\b/.test(source)
  walk(source, (line, lineNo, stack) => {
    if (isBlankOrComment(line) || stack.some(scope => scope.kind === 'def')) return
    const here = namespaceOf(stack)
    const body = stack[stack.length - 1]

    const visibility = line.match(VISIBILITY)
    if (visibility?.[1] && body) {
      body.isPrivate = visibility[1] !== 'public'
      return
    }
    if (here && !isAbstract && marksWorker(line)) outline.workers.add(here)
    if (readNamespace(outline, line, here) || readConstant(outline, line, here)) return
    if (here) readDef(outline, fullDef(lines, lineNo - 1), line, here, body)
  })
  return outline
}

// The namespaces open at a line, innermost first, ending with the top level ('').
export const scopesAt = (source: string, lineNo: number): string[] => {
  let found: string[] = ['']
  walk(source, (_line, at, stack) => {
    if (at !== lineNo) return
    const names: string[] = []
    const namespaces = stack.filter(scope => scope.kind === 'namespace')
    for (let i = namespaces.length; i > 0; i--) names.push(namespaceOf(namespaces.slice(0, i)))
    found = [...names, '']
  })
  return found
}

// What a constant reference resolves to, given the namespaces open around it and which names exist.
// Ruby tries each open namespace from the inside out, then the top level.
export const resolveReference = (reference: string, scopes: string[], exists: (name: string) => boolean): string[] => {
  if (reference.startsWith('::')) return [reference.slice(2)]
  const candidates = scopes.map(scope => (scope ? `${scope}::${reference}` : reference))
  const firstExisting = candidates.findIndex(exists)
  return firstExisting === -1 ? candidates : candidates.slice(0, firstExisting + 1)
}

type Param = { name: string; kind: 'req' | 'opt' | 'rest' | 'keyreq' | 'key' | 'keyrest' | 'block' }

const splitTopLevel = (text: string) => {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let escaped = false
  let current = ''
  for (const char of text) {
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts.map(part => part.trim()).filter(Boolean)
}

export const parseParams = (text: string): Param[] =>
  splitTopLevel(text).map(part => {
    if (part.startsWith('&')) return { name: part.slice(1), kind: 'block' }
    if (part.startsWith('**')) return { name: part.slice(2), kind: 'keyrest' }
    if (part.startsWith('*')) return { name: part.slice(1), kind: 'rest' }
    const keyword = part.match(/^(\w+):\s*(.*)$/)
    if (keyword?.[1]) return { name: keyword[1], kind: keyword[2] ? 'key' : 'keyreq' }
    if (part.includes('=')) return { name: part.split('=')[0]?.trim() ?? part, kind: 'opt' }
    return { name: part, kind: 'req' }
  })

// Whether every call that worked with the old parameters still works with the new ones.
export const isCompatible = (before: string, after: string): boolean => {
  const old = parseParams(before)
  const now = parseParams(after)
  const count = (params: Param[], ...kinds: Param['kind'][]) => params.filter(p => kinds.includes(p.kind)).length
  const keys = (params: Param[], ...kinds: Param['kind'][]) => params.filter(p => kinds.includes(p.kind)).map(p => p.name)
  const hasRest = now.some(p => p.kind === 'rest')
  const hasKeyrest = now.some(p => p.kind === 'keyrest')

  if (count(now, 'req') > count(old, 'req')) return false
  if (!hasRest && count(old, 'req', 'opt') + (old.some(p => p.kind === 'rest') ? Infinity : 0) > count(now, 'req', 'opt')) return false
  if (keys(now, 'keyreq').some(name => !keys(old, 'keyreq').includes(name))) return false
  if (!hasKeyrest && keys(old, 'keyreq', 'key').some(name => !keys(now, 'keyreq', 'key').includes(name))) return false
  if (!hasKeyrest && old.some(p => p.kind === 'keyrest')) {
    // Without any keywords, Ruby passes the old callers' keywords on as one positional hash.
    const takesHash = count(now, 'keyreq', 'key') === 0 && (hasRest || count(now, 'req', 'opt') > count(old, 'req', 'opt'))
    if (!takesHash) return false
  }
  return true
}

export type RubyChange =
  | { kind: 'worker-removed'; worker: string; renamedTo?: string }
  | { kind: 'worker-arguments'; worker: string; before: string; after: string }
  | { kind: 'worker-perform-removed'; worker: string; parent?: string }
  | { kind: 'worker-alias-removed'; alias: string; target: string }
  | { kind: 'constant-removed'; constant: string }
  | { kind: 'method-removed'; method: MethodDef }
  | { kind: 'arguments-changed'; method: MethodDef; before: string }

// What a branch removed or changed in a way that can break callers, across all of its Ruby files.
export const breakingChanges = (before: Outline, after: Outline): RubyChange[] => {
  const changes: RubyChange[] = []
  const shortName = (name: string) => name.split('::').pop()
  for (const worker of before.workers) {
    if (!after.constants.has(worker)) {
      const renamedTo = [...after.workers].find(other => !before.workers.has(other) && shortName(other) === shortName(worker))
      changes.push({ kind: 'worker-removed', worker, renamedTo })
      continue
    }
    // An alias keeps the old name working, and its perform lives on the class it points at, possibly in a file the branch didn't touch.
    const target = after.aliases.get(worker)?.replace(/^::/, '')
    const old = before.methods.get(methodKey(worker, 'perform', false))
    const now = after.methods.get(methodKey(target ?? worker, 'perform', false))
    if (old && !now && !target) changes.push({ kind: 'worker-perform-removed', worker, parent: after.parents.get(worker) })
    else if (old && now && !isCompatible(old.params, now.params)) {
      changes.push({ kind: 'worker-arguments', worker, before: old.params, after: now.params })
    }
  }
  const workerNames = new Set([...before.workers, ...after.workers].map(shortName))
  for (const constant of removedRoots(before, after)) {
    if (before.workers.has(constant)) continue
    const target = before.aliases.get(constant)
    const isWorkerAlias = target !== undefined && (workerNames.has(shortName(target)) || looksLikeWorker(`${constant} ${target}`))
    changes.push(isWorkerAlias ? { kind: 'worker-alias-removed', alias: constant, target } : { kind: 'constant-removed', constant })
  }
  for (const [key, method] of before.methods) {
    if (method.isPrivate || !after.constants.has(method.owner)) continue
    if (method.name === 'perform' && before.workers.has(method.owner)) continue
    const now = after.methods.get(key)
    if (!now || now.isPrivate) changes.push({ kind: 'method-removed', method })
    else if (!isCompatible(method.params, now.params)) changes.push({ kind: 'arguments-changed', method: now, before: method.params })
  }
  return changes
}

// The removed constants worth naming: not a module that only wrapped removed classes,
// and not something inside a removed constant that is already named.
const removedRoots = (before: Outline, after: Outline): string[] => {
  const removed = [...before.constants].filter(constant => !after.constants.has(constant)).sort((a, b) => a.split('::').length - b.split('::').length)
  const named = new Set<string>()
  const parentOf = (name: string) => name.split('::').slice(0, -1).join('::')
  for (const constant of removed) {
    if (named.has(parentOf(constant))) continue
    const isWrapper =
      before.kinds.get(constant) === 'module' && removed.some(other => parentOf(other) === constant && before.kinds.get(other) !== 'value')
    if (!isWrapper) named.add(constant)
  }
  return [...named]
}

export const mergeOutlines = (outlines: Outline[]): Outline => ({
  constants: new Set(outlines.flatMap(outline => [...outline.constants])),
  kinds: new Map(outlines.flatMap(outline => [...outline.kinds])),
  methods: new Map(outlines.flatMap(outline => [...outline.methods])),
  workers: new Set(outlines.flatMap(outline => [...outline.workers])),
  aliases: new Map(outlines.flatMap(outline => [...outline.aliases])),
  parents: new Map(outlines.flatMap(outline => [...outline.parents])),
})

// The argument text of the first `.name` call in a line of code: '' for no arguments,
// or undefined when the call runs onto the next line.
export const callArguments = (code: string, name: string): string | undefined => {
  const call = `.${name}`
  let at = code.indexOf(call)
  while (at !== -1 && isNameChar(code.charAt(at + call.length))) at = code.indexOf(call, at + 1)
  if (at === -1) return undefined
  const rest = code.slice(at + name.length + 1)
  if (rest.startsWith('(')) {
    let depth = 0
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '(') depth++
      if (rest[i] === ')' && --depth === 0) return rest.slice(1, i)
    }
    return undefined
  }
  if (/^\s*($|[.)\]}&|;]|\s(do|\{|if|unless|\|\||&&)\b|\s*\.)/.test(rest)) return ''
  const bare = rest.match(/^\s+(.+?)(\s+(do|if|unless)\b.*)?$/)
  return bare?.[1]
}

// Whether a call with these arguments fits the parameters; undefined when it can't tell (a splat).
export const fitsCall = (params: string, args: string): boolean | undefined => {
  const parts = splitTopLevel(args)
  if (parts.some(part => part.startsWith('*') || part.startsWith('&'))) return undefined
  const wanted = parseParams(params)
  const named = parts.map(part => part.match(/^(\w+):(?!:)/)?.[1]).filter((key): key is string => Boolean(key))
  // Without any keyword parameters, Ruby passes keywords on as one positional hash.
  const asHash = named.length > 0 && !wanted.some(p => p.kind === 'keyreq' || p.kind === 'key' || p.kind === 'keyrest')
  const keywords = asHash ? [] : named
  const positional = parts.filter(part => !/^(\w+):(?!:)/.test(part)).length + (asHash ? 1 : 0)
  const count = (...kinds: Param['kind'][]) => wanted.filter(p => kinds.includes(p.kind)).length
  const names = (...kinds: Param['kind'][]) => wanted.filter(p => kinds.includes(p.kind)).map(p => p.name)

  if (positional < count('req')) return false
  if (!wanted.some(p => p.kind === 'rest') && positional > count('req', 'opt')) return false
  if (names('keyreq').some(key => !keywords.includes(key))) return false
  if (!wanted.some(p => p.kind === 'keyrest') && keywords.some(key => !names('keyreq', 'key').includes(key))) return false
  return true
}
