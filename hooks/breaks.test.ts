import { describe, expect, test } from 'claude-code/testing'

import { findBreaks, todoOf } from './breaks'
import type { Repo } from './breaks'
import { isCommentLine } from './radius'

// A repo held in memory: `now` is the branch, `before` the base. Grep runs over `now` as git grep -E would.
const repoOf = (name: string, now: Record<string, string>, before: Record<string, string> = now): Repo => ({
  name,
  read: async path => now[path],
  readBefore: async path => before[path],
  grep: async (pattern, only = []) => {
    const matches = new RegExp(pattern.replaceAll('[[:space:]]', '\\s'))
    return Object.entries(now)
      .filter(([path]) => only.length === 0 || only.includes(path))
      .flatMap(([path, source]) =>
        source.split('\n').flatMap((line, i) => (matches.test(line) && !isCommentLine(line) ? [{ path, line: i + 1, code: line.trim() }] : [])),
      )
  },
  filesMentioning: async word => Object.keys(now).filter(path => new RegExp(`\\b${word}\\b`).test(now[path] ?? '')),
})

const quote = (params = 'items, currency:', body = 'new(items.sum(&:price))') =>
  `module Pricing\n  class Quote\n    def self.calculate(${params})\n      ${body}\n    end\n  end\nend\n`

const total = 'module Checkout\n  class Total\n    def self.call(basket)\n      Pricing::Quote.calculate(basket.items, currency: basket.currency)\n    end\n  end\nend\n'
const basket = "class BasketsController\n  def show\n    @quote = Pricing::Quote.calculate(items, currency: 'GBP')\n  end\nend\n"

const pricing = (now: Record<string, string>) =>
  repoOf('pricing', { 'lib/pricing/quote.rb': quote(), 'lib/checkout/total.rb': total, ...now }, { 'lib/pricing/quote.rb': quote(), 'lib/checkout/total.rb': total })
const shop = repoOf('shop', { 'app/controllers/baskets_controller.rb': basket })

describe('what stays quiet', () => {
  test('a change inside a method body', async () => {
    const repo = pricing({ 'lib/pricing/quote.rb': quote('items, currency:', 'new(items.sum(&:price).round(2))') })
    expect(await findBreaks(repo, ['lib/pricing/quote.rb'], [shop])).toEqual([])
  })

  test('a new optional argument every call still fits', async () => {
    const repo = pricing({ 'lib/pricing/quote.rb': quote('items, currency:, rounding: :pence') })
    expect(await findBreaks(repo, ['lib/pricing/quote.rb'], [shop])).toEqual([])
  })

  test('a new parent class', async () => {
    const before = 'module Leads\n  class Captured < OldBase\n    def process(message)\n      message\n    end\n  end\nend\n'
    const after = before.replace('OldBase', '::Workers::Base')
    const repo = repoOf('api', { 'app/leads/captured.rb': after }, { 'app/leads/captured.rb': before })
    expect(await findBreaks(repo, ['app/leads/captured.rb'], [])).toEqual([])
  })

  test('a class moved to another file under the same name', async () => {
    const repo = repoOf('pricing', { 'lib/pricing/models/quote.rb': quote(), 'lib/checkout/total.rb': total }, { 'lib/pricing/quote.rb': quote() })
    expect(await findBreaks(repo, ['lib/pricing/quote.rb', 'lib/pricing/models/quote.rb'], [])).toEqual([])
  })
})

describe('a method made private', () => {
  test('breaks callers, since the private method no longer answers them', async () => {
    const before = 'module Pricing\n  class Quote\n    def total(items)\n      items\n    end\n  end\nend\n'
    const after = before.replace('    def total', '    private\n\n    def total')
    const caller = 'class BasketsController\n  def show\n    Pricing::Quote.new.total(items)\n  end\nend\n'
    const repo = repoOf('shop', { 'lib/pricing/quote.rb': after, 'app/baskets_controller.rb': caller }, { 'lib/pricing/quote.rb': before })
    const [found] = await findBreaks(repo, ['lib/pricing/quote.rb'], [])
    expect(found?.text).toContain('Quote#total')
  })
})

describe('a class moved up a namespace', () => {
  const base = (namespace: string) => `module Leads\n${namespace ? `  module ${namespace}\n` : ''}    class BaseStep\n    end\n${namespace ? '  end\n' : ''}end\n`
  const nested = 'module Leads\n  module Steps\n    class Assign < BaseStep\n    end\n  end\nend\n'
  const qualified = 'class Assign < Leads::Steps::BaseStep\nend\n'
  const moved = (step: string) =>
    repoOf('api', { 'app/leads/base_step.rb': base(''), 'app/leads/steps/assign.rb': step }, { 'app/leads/steps/base_step.rb': base('Steps'), 'app/leads/steps/assign.rb': step })

  test('stays quiet when Ruby still finds it by looking further out', async () => {
    expect(await findBreaks(moved(nested), ['app/leads/steps/base_step.rb', 'app/leads/base_step.rb'], [])).toEqual([])
  })

  test('breaks when the reference names the old place in full', async () => {
    const [found] = await findBreaks(moved(qualified), ['app/leads/steps/base_step.rb', 'app/leads/base_step.rb'], [])
    expect(found?.text).toBe('You removed Steps::BaseStep, but 1 place still uses it. It will break:')
  })
})

describe('what breaks', () => {
  test('a new required argument, with the calls that no longer fit, here and in other repos', async () => {
    const repo = pricing({ 'lib/pricing/quote.rb': quote('items, currency:, rounding:') })
    expect(await findBreaks(repo, ['lib/pricing/quote.rb'], [shop])).toEqual([
      {
        level: 'red',
        text: 'You changed Pricing::Quote.calculate to take (items, currency:, rounding:). 2 places no longer fit:',
        uses: [{ path: 'lib/checkout/total.rb', line: 4, code: 'Pricing::Quote.calculate(basket.items, currency: basket.currency)' }],
        testUses: 0,
        repoUses: [{ repo: 'shop', uses: [{ path: 'app/controllers/baskets_controller.rb', line: 3, code: "@quote = Pricing::Quote.calculate(items, currency: 'GBP')" }], testUses: 0 }],
      },
    ])
  })

  test('a removed class that is still used', async () => {
    const repo = repoOf('pricing', { 'lib/checkout/total.rb': total }, { 'lib/pricing/quote.rb': quote(), 'lib/checkout/total.rb': total })
    const [found] = await findBreaks(repo, ['lib/pricing/quote.rb'], [])
    expect(found?.text).toBe('You removed Pricing::Quote, but 1 place still uses it. It will break:')
  })

  test('a Sidekiq worker moved without an alias', async () => {
    const worker = (namespace: string) => `module ${namespace}\n  class Reminder\n    include Sidekiq::Job\n\n    def perform(lead_id)\n      lead_id\n    end\n  end\nend\n`
    const repo = repoOf('api', { 'app/leads/workers/reminder.rb': worker('Leads::Workers') }, { 'app/workers/reminder.rb': worker('Workers') })
    const [found] = await findBreaks(repo, ['app/workers/reminder.rb', 'app/leads/workers/reminder.rb'], [])
    expect(found).toEqual({
      level: 'red',
      text: 'You removed the Sidekiq worker Workers::Reminder. Jobs already queued under that name will fail.',
      fix: 'Keep an alias for the old name: Workers::Reminder = ::Leads::Workers::Reminder',
      uses: [],
      testUses: 0,
      repoUses: [],
    })
  })

  test('a removed Sidekiq worker is named in full, as Sidekiq stores it', async () => {
    const worker = 'module Leads\n  module Workers\n    class Reminder\n      include Sidekiq::Job\n\n      def perform(lead_id)\n        lead_id\n      end\n    end\n  end\nend\n'
    const repo = repoOf('api', {}, { 'app/leads/workers/reminder.rb': worker })
    const [found] = await findBreaks(repo, ['app/leads/workers/reminder.rb'], [])
    expect(found?.text).toBe('You removed the Sidekiq worker Leads::Workers::Reminder. Jobs already queued under that name will fail.')
  })

  test('a deleted JS file that is still imported', async () => {
    const repo = repoOf('web', { 'src/pages/Home.tsx': "import { Button } from '../components/Button'\n" })
    const [found] = await findBreaks(repo, ['src/components/Button.tsx'], [])
    expect(found?.text).toBe('You deleted src/components/Button.tsx, but 1 place still imports it. It will break:')
  })

  test('a deleted JS file imported by a relative path from its own folder', async () => {
    const repo = repoOf('web', { 'src/components/Home.tsx': "import Button from './Button'\n" })
    const [found] = await findBreaks(repo, ['src/components/Button.tsx'], [])
    expect(found?.text).toBe('You deleted src/components/Button.tsx, but 1 place still imports it. It will break:')
  })

  test('a relative import of a same-named file in another folder stays quiet', async () => {
    const repo = repoOf('web', { 'src/pages/Home.tsx': "import Button from './Button'\n", 'src/pages/Button.tsx': 'export default 1\n' })
    expect(await findBreaks(repo, ['src/components/Button.tsx'], [])).toEqual([])
  })

  test('two deleted JS files with the same import path, both still imported', async () => {
    const repo = repoOf('web', { 'src/pages/Home.tsx': "import { Button } from '../components/Button'\n" })
    const found = await findBreaks(repo, ['src/components/Button.tsx', 'src/components/Button/index.ts'], [])
    expect(found.length).toBeGreaterThan(0)
  })
})

describe('Packwerk', () => {
  test('finds a new rule break', async () => {
    const todo = '---\n"packages/discounts":\n  "::Discounts::VoucherCode":\n    violations:\n    - privacy\n    files:\n    - packages/checkout/total.rb\n'
    const repo = repoOf('pricing', { 'packages/checkout/package_todo.yml': todo }, {})
    expect((await todoOf(repo, ['packages/checkout/package_todo.yml']))?.added).toBe(1)
  })

  const listing = (file: string) => `---\n"packages/discounts":\n  "::Discounts::VoucherCode":\n    violations:\n    - privacy\n    files:\n    - ${file}\n`

  test('a fixed break and a new one in a file that still exists are not a move', async () => {
    const repo = repoOf(
      'pricing',
      { 'package_todo.yml': listing('packages/checkout/b.rb'), 'packages/checkout/a.rb': '', 'packages/checkout/b.rb': '' },
      { 'package_todo.yml': listing('packages/checkout/a.rb') },
    )
    expect(await todoOf(repo, ['package_todo.yml'])).toMatchObject({ added: 1, fixed: 1, moved: 0 })
  })

  test('a break whose old file is gone has moved', async () => {
    const repo = repoOf('pricing', { 'package_todo.yml': listing('packages/checkout/b.rb'), 'packages/checkout/b.rb': '' }, { 'package_todo.yml': listing('packages/checkout/a.rb') })
    expect(await todoOf(repo, ['package_todo.yml'])).toMatchObject({ added: 0, fixed: 0, moved: 1 })
  })
})
