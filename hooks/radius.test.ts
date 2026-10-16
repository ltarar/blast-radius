import { describe, expect, test } from 'claude-code/testing'

import {
  adviceFor,
  byRisk,
  changedFiles,
  changedMembers,
  constantOf,
  consumersOf,
  diffTodo,
  expandHome,
  dependentsOf,
  gemNameOf,
  isCommentLine,
  isPrivate,
  isTest,
  languageOf,
  lockHasGem,
  moduleTailOf,
  memberPattern,
  ownerOf,
  parseDiffLines,
  parseGrepHits,
  parsePackage,
  parseTodo,
  repoOf,
  ruleLabel,
  shouldList,
} from './radius'

const packages = {
  '.': parsePackage('enforce_privacy: false\n'),
  shared: parsePackage('enforce_privacy: false\n'),
  'packages/discounts': parsePackage('enforce_privacy: true\npublic_path: public/\ndependencies:\n  - "shared"\n'),
}

describe('packwerk', () => {
  test('parses a package file', () => {
    expect(parsePackage('enforce_privacy: true\npublic_path: public/\ndependencies:\n  - "."\n  - packages/billing\n')).toEqual({
      dependencies: ['.', 'packages/billing'],
      publicPath: 'public/',
      enforcePrivacy: true,
    })
    expect(parsePackage('# public_path: x/\n').publicPath).toBe('app/public/')
  })

  test('maps specs under spec/ to the package they test', () => {
    expect(ownerOf('spec/packages/discounts/steps/x_spec.rb', packages)).toBe('packages/discounts')
    expect(ownerOf('spec/packwerk_enforcement_spec.rb', packages)).toBe('.')
  })

  test('finds dependents and private files', () => {
    expect(dependentsOf('shared', packages)).toEqual(['packages/discounts'])
    expect(isPrivate('packages/discounts/steps/a.rb', packages)).toBe(true)
    expect(isPrivate('packages/discounts/public/a.rb', packages)).toBe(false)
    expect(isPrivate('shared/a.rb', packages)).toBe(false)
  })
})

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
  test('reads the qualified Ruby class name from module nesting', () => {
    const source = 'module Checkout\n  module Steps\n    class ApplyVoucher\n    end\n  end\nend\n'
    expect(constantOf(source)).toBe('Checkout::Steps::ApplyVoucher')
    expect(constantOf('module A\nend\nmodule B\n  class C < A::D\n  end\nend\n')).toBe('B::C')
  })

  test('gives the import tail of a JS module', () => {
    expect(moduleTailOf('src/components/Button.tsx')).toBe('components/Button')
    expect(moduleTailOf('src/components/Button/index.ts')).toBe('components/Button')
  })

  test('parses git grep hits', () => {
    expect(parseGrepHits('lib/a.rb:12:    Foo::Bar.new(x)\n')).toEqual([{ path: 'lib/a.rb', line: 12, code: 'Foo::Bar.new(x)' }])
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

describe('advice', () => {
  const file = { path: 'a.rb', name: 'A', changed: [], isDeleted: false, visibleTo: [], uses: [], testUses: 0, repoUses: [] }
  const use = { path: 'lib/x.rb', line: 1, code: 'A.new' }

  test('lists only files that reach outside', () => {
    expect(shouldList(file)).toBe(false)
    expect(shouldList({ ...file, uses: [use] })).toBe(true)
    expect(shouldList({ ...file, visibleTo: ['.'] })).toBe(true)
  })

  test('puts the riskiest files first', () => {
    const items = [{ level: 'green' as const }, { level: 'red' as const }, { level: 'yellow' as const }, { level: 'red' as const }]
    expect(byRisk(items).map(item => item.level)).toEqual(['red', 'red', 'yellow', 'green'])
  })

  test('advises from usage and deletion', () => {
    expect(adviceFor({ ...file, visibleTo: ['.'] })).toEqual({
      level: 'green',
      text: 'a.rb is public to the root package, but nothing uses it yet. Check it needs to be public.',
    })
    expect(adviceFor({ ...file, changed: ['.call'], uses: [use, use] })).toEqual({
      level: 'yellow',
      text: 'You changed .call in a.rb. 2 places call it. Run their specs:',
    })
    expect(adviceFor({ ...file, repoUses: [{ repo: 'web', uses: [use], testUses: 0 }] }).level).toBe('red')
    expect(adviceFor({ ...file, isDeleted: true, uses: [use] }).text).toBe('You deleted a.rb, but 1 place still uses it. It will break:')
    expect(adviceFor({ ...file, isDeleted: true, uses: [use], movedTo: 'shared/a.rb' })).toEqual({
      level: 'green',
      text: 'You moved a.rb to shared/a.rb. Callers still work.',
    })
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

describe('changed members', () => {
  const before = [
    'module Discounts',
    '  module VoucherCode',
    '    LOOKUP = {',
    "      a: 'b',",
    '    }',
    '',
    '    class << self',
    '      # @rbs code: String',
    '      def get_discount_for(code)',
    '        discount(code)',
    '      end',
    '    end',
    '  end',
    'end',
  ].join('\n')
  const edit = (line: number, text: string) =>
    before
      .split('\n')
      .map((l, i) => (i === line - 1 ? text : l))
      .join('\n')

  test('reads changed line numbers from a diff', () => {
    expect(parseDiffLines('@@ -8 +8 @@ x\n-a\n+b\n@@ -20,2 +20,0 @@\n')).toEqual({ added: [8], removed: [8, 20, 21] })
  })

  test('ignores changes to comments only', () => {
    const after = edit(8, '      # @rbs code: String?')
    expect(changedMembers(before, after, { added: [8], removed: [8] })).toEqual([])
  })

  test('finds the class method around a changed line', () => {
    const after = edit(10, '        discount(code.to_s)')
    expect(changedMembers(before, after, { added: [10], removed: [10] })).toEqual([{ kind: 'class-method', name: 'get_discount_for' }])
  })

  test('finds the constant around a changed line', () => {
    const after = edit(4, "      a: 'c',")
    expect(changedMembers(before, after, { added: [4], removed: [4] })).toEqual([{ kind: 'constant', name: 'LOOKUP' }])
  })

  test('builds search patterns per member', () => {
    expect(memberPattern('A::B', { kind: 'class-method', name: 'run' })).toBe('A::B\\.run([^A-Za-z0-9_?!]|$)')
    expect(memberPattern('A::B', { kind: 'constant', name: 'LOOKUP' })).toBe('A::B::LOOKUP([^A-Za-z0-9_?!]|$)')
  })
})
