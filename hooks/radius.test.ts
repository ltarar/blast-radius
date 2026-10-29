import { describe, expect, test } from 'claude-code/testing'

import {
  byRisk,
  changedFiles,
  consumersOf,
  diffTodo,
  expandHome,
  gemNameOf,
  isCommentLine,
  isTest,
  languageOf,
  lockHasGem,
  moduleTailOf,
  parseGrepHits,
  parseTodo,
  referencePattern,
  referencesIn,
  repoOf,
  ruleLabel,
} from './radius'

describe('files', () => {
  test('collects changed, deleted and untracked files once each', () => {
    expect(changedFiles('D\ta.rb\nM\tb.rb\n', 'c.rb\nb.rb\n')).toEqual(['a.rb', 'b.rb', 'c.rb'])
  })

  test('tells tests and languages apart', () => {
    expect(isTest('spec/models/a_spec.rb')).toBe(true)
    expect(isTest('src/components/Button.test.tsx')).toBe(true)
    expect(isTest('src/__tests__/a.js')).toBe(true)
    expect(isTest('app/models/a.rb')).toBe(false)
    expect(languageOf('a.rb')).toBe('ruby')
    expect(languageOf('a.tsx')).toBe('js')
    expect(languageOf('a.d.ts')).toBe('other')
    expect(languageOf('a.yml')).toBe('other')
  })
})

describe('names', () => {
  test('gives the import tail of a JS module', () => {
    expect(moduleTailOf('src/components/Button.tsx')).toBe('components/Button')
    expect(moduleTailOf('src/components/Button/index.ts')).toBe('components/Button')
  })

  test('parses git grep hits', () => {
    expect(parseGrepHits('lib/a.rb:12:    Foo::Bar.new(x)\n')).toEqual([{ path: 'lib/a.rb', line: 12, code: 'Foo::Bar.new(x)' }])
  })

  test('keeps the whole line, so a call late in a long line can still be checked', () => {
    const code = `${'x'.repeat(100)} = Pricing::Quote.calculate(items, currency: :gbp)`
    expect(parseGrepHits(`lib/a.rb:3:${code}\n`)[0]?.code).toBe(code)
  })
})

describe('repos', () => {
  test('finds the repo a file is in', () => {
    const root = '/Users/me/code'
    expect(repoOf('/Users/me/code/api/app/a.rb', root)).toBe('api')
    expect(repoOf('/tmp/api/app/a.rb', root)).toBeUndefined()
  })

  test('expands ~ in the repos folder setting', () => {
    expect(expandHome('~/Repositories', '/Users/me')).toBe('/Users/me/Repositories')
    expect(expandHome('/srv/repos/', '/Users/me')).toBe('/srv/repos')
  })

  test('finds consumers from lockfiles and package.json', () => {
    expect(gemNameOf("Gem::Specification.new do |spec|\n  spec.name          = 'shared_rules'\n")).toBe('shared_rules')
    expect(lockHasGem('GEM\n  specs:\n    shared_rules (3.1)\n', 'shared_rules')).toBe(true)
    expect(lockHasGem('      shared_rules (>= 1)\n', 'shared_rules')).toBe(false)
    const manifests = {
      shared_rules: { lock: '    shared_rules (3.1)\n' },
      web: { lock: '    shared_rules (3.1)\n' },
      frontend: { packageJson: '{"dependencies":{"ui-kit":"1.0"}}' },
    }
    expect(consumersOf('shared_rules', { gem: 'shared_rules' }, manifests)).toEqual([{ repo: 'web', via: 'gem' }])
    expect(consumersOf('ui-kit', { npm: 'ui-kit' }, manifests)).toEqual([{ repo: 'frontend', via: 'npm' }])
    expect(consumersOf('api', {}, manifests)).toEqual([])
  })
})

describe('comments', () => {
  test('treats Ruby and JS comment lines as comments', () => {
    expect(isCommentLine('# Pricing::Quote is cached')).toBe(true)
    expect(isCommentLine('// uses Quote')).toBe(true)
    expect(isCommentLine(' * @see Quote')).toBe(true)
    expect(isCommentLine('quote = Pricing::Quote.calculate(items) # cached')).toBe(false)
  })
})

describe('references', () => {
  test('finds constant references as written', () => {
    expect(referencesIn('quote = ::Pricing::Quote.calculate(Quote::RATE)', 'Quote')).toEqual(['::Pricing::Quote', 'Quote'])
    expect(referencesIn('QuoteBuilder.new', 'Quote')).toEqual([])
  })

  test('builds a grep pattern for a name and an optional call', () => {
    expect(referencePattern('Quote', '\\.calculate')).toBe('(^|[^A-Za-z0-9_])Quote\\.calculate([^A-Za-z0-9_?!]|$)')
  })
})

describe('package_todo.yml', () => {
  const yaml = (file: string, type = 'dependency') =>
    `---\n".":\n  "::Pricing::Quote":\n    violations:\n    - ${type}\n    files:\n    - ${file}\n`
  const rule = "Pricing::Quote from the root package, which it doesn't depend on"

  test('labels rule breaks in plain words', () => {
    expect(Object.keys(parseTodo(yaml('a.rb'))).map(ruleLabel)).toEqual([rule])
    expect(Object.keys(parseTodo(yaml('a.rb', 'privacy'))).map(ruleLabel)).toEqual(['Pricing::Quote, which is private to the root package'])
  })

  test('tells moved, new and fixed rule breaks apart', () => {
    const moved = diffTodo(parseTodo(yaml('p/voucher_builder.rb')), parseTodo(yaml('p/steps/build_voucher.rb')))
    expect(moved).toEqual({ added: 0, fixed: 0, moved: 1, items: [{ kind: 'moved', rule, from: 'voucher_builder.rb', file: 'steps/build_voucher.rb' }] })
    expect(diffTodo({}, parseTodo(yaml('a.rb'))).items).toEqual([{ kind: 'new', rule, file: 'a.rb' }])
    expect(diffTodo(parseTodo(yaml('a.rb')), {}).fixed).toBe(1)
  })
})

describe('order', () => {
  test('puts the riskiest first', () => {
    const items = [{ level: 'green' as const }, { level: 'red' as const }, { level: 'yellow' as const }, { level: 'red' as const }]
    expect(byRisk(items).map(item => item.level)).toEqual(['red', 'red', 'yellow', 'green'])
  })
})
