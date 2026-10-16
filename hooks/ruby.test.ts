import { describe, expect, test } from 'claude-code/testing'

import { breakingChanges, callArguments, fitsCall, isCompatible, mergeOutlines, outlineOf, resolveReference, scopesAt } from './ruby'

const quote = (calculate = 'items, currency: :gbp') =>
  [
    'module Pricing',
    '  class Quote',
    '    RATE = 0.2',
    '',
    '    class << self',
    `      def calculate(${calculate})`,
    '        new(items).total',
    '      end',
    '    end',
    '',
    '    def self.build = new([])',
    '',
    '    def total',
    '      0',
    '    end',
    '',
    '    private',
    '',
    '    def round(amount)',
    '      amount',
    '    end',
    '  end',
    'end',
  ].join('\n')

describe('outline', () => {
  test('reads constants and methods with their owners', () => {
    const outline = outlineOf(quote())
    expect([...outline.constants]).toEqual(['Pricing', 'Pricing::Quote', 'Pricing::Quote::RATE'])
    expect([...outline.methods.keys()]).toEqual([
      'Pricing::Quote.calculate',
      'Pricing::Quote.build',
      'Pricing::Quote#total',
      'Pricing::Quote#round',
    ])
    expect(outline.methods.get('Pricing::Quote#round')?.isPrivate).toBe(true)
    expect(outline.methods.get('Pricing::Quote.calculate')?.params).toBe('items, currency: :gbp')
  })

  test('reads compact and absolute names', () => {
    expect([...outlineOf('class Pricing::Quote\nend\nmodule Shop\n  class ::Basket\n  end\nend\n').constants]).toEqual([
      'Pricing::Quote',
      'Shop',
      'Basket',
    ])
  })

  test('knows which namespaces are open at a line', () => {
    expect(scopesAt(quote(), 7)).toEqual(['Pricing::Quote', 'Pricing', ''])
    expect(scopesAt(quote(), 1)).toEqual([''])
  })
})

describe('references', () => {
  test('resolves from the innermost namespace out', () => {
    expect(resolveReference('Quote', ['Shop::Checkout', 'Shop', ''], () => false)).toEqual([
      'Shop::Checkout::Quote',
      'Shop::Quote',
      'Quote',
    ])
    expect(resolveReference('Quote', ['Shop', ''], name => name === 'Shop::Quote')).toEqual(['Shop::Quote'])
    expect(resolveReference('::Pricing::Quote', ['Shop', ''], () => false)).toEqual(['Pricing::Quote'])
  })
})

describe('arguments', () => {
  test('allows changes every old call still fits', () => {
    expect(isCompatible('items', 'items, currency = :gbp')).toBe(true)
    expect(isCompatible('items', 'items, currency: :gbp')).toBe(true)
    expect(isCompatible('items, currency: :gbp', 'items, **options')).toBe(true)
    expect(isCompatible('a, b', '*args')).toBe(true)
  })

  test('rejects changes that break old calls', () => {
    expect(isCompatible('items', 'items, currency')).toBe(false)
    expect(isCompatible('items', 'items, currency:')).toBe(false)
    expect(isCompatible('items, currency = :gbp', 'items')).toBe(false)
    expect(isCompatible('items, currency: :gbp', 'items')).toBe(false)
    expect(isCompatible('*items', 'items')).toBe(false)
  })
})

describe('breaking changes', () => {
  test('finds nothing when only a method body changes', () => {
    const after = quote().replace('new(items).total', 'new(items).total.round(2)')
    expect(breakingChanges(outlineOf(quote()), outlineOf(after))).toEqual([])
  })

  test('finds a removed constant', () => {
    const after = quote().replace('    RATE = 0.2\n', '')
    expect(breakingChanges(outlineOf(quote()), outlineOf(after))).toEqual([{ kind: 'constant-removed', constant: 'Pricing::Quote::RATE' }])
  })

  test('finds a removed public method, but not a removed private one', () => {
    const noTotal = quote().replace('    def total\n      0\n    end\n', '')
    const noRound = quote().replace('    def round(amount)\n      amount\n    end\n', '')
    expect(breakingChanges(outlineOf(quote()), outlineOf(noTotal)).map(c => c.kind)).toEqual(['method-removed'])
    expect(breakingChanges(outlineOf(quote()), outlineOf(noRound))).toEqual([])
  })

  test('finds arguments that break old calls', () => {
    const changes = breakingChanges(outlineOf(quote()), outlineOf(quote('items, currency:')))
    expect(changes).toEqual([
      {
        kind: 'arguments-changed',
        method: { owner: 'Pricing::Quote', name: 'calculate', isClassMethod: true, params: 'items, currency:', isPrivate: false },
        before: 'items, currency: :gbp',
      },
    ])
  })

  test('names a removed class, not the module around it or the constants inside it', () => {
    expect(breakingChanges(outlineOf(quote()), outlineOf(''))).toEqual([{ kind: 'constant-removed', constant: 'Pricing::Quote' }])
  })

  test('treats a class moved to another file as kept', () => {
    const before = mergeOutlines([outlineOf(quote()), outlineOf('module Shop\nend\n')])
    const after = mergeOutlines([outlineOf('module Shop\nend\n'), outlineOf(quote())])
    expect(breakingChanges(before, after)).toEqual([])
  })
})

describe('calls', () => {
  test('reads the arguments of a call', () => {
    expect(callArguments('Steps::UpsertLead.new.call(ctx)', 'new')).toBe('')
    expect(callArguments('Quote.calculate(items, currency: :usd)', 'calculate')).toBe('items, currency: :usd')
    expect(callArguments('Quote.calculate items, currency: :usd', 'calculate')).toBe('items, currency: :usd')
    expect(callArguments('Quote.calculate(', 'calculate')).toBeUndefined()
  })

  test('checks a call against the new parameters', () => {
    expect(fitsCall('workflow: Workflow.new', '')).toBe(true)
    expect(fitsCall('items, currency:', 'items')).toBe(false)
    expect(fitsCall('items, currency:', 'items, currency: :usd')).toBe(true)
    expect(fitsCall('items', 'items, rate: 2')).toBe(false)
    expect(fitsCall('items', '*all')).toBeUndefined()
  })

  test('reads a parameter list that runs over several lines', () => {
    const source = 'class Rule\n  def initialize(\n    rules: Rules.instance,\n    clock: Time\n  )\n  end\nend\n'
    expect(outlineOf(source).methods.get('Rule#initialize')?.params).toBe('rules: Rules.instance, clock: Time')
  })
})

describe('Sidekiq workers', () => {
  const worker = (namespace: string, perform = 'lead_id') =>
    `module ${namespace}\n  class Reminder\n    include Sidekiq::Job\n\n    def perform(${perform})\n      lead_id\n    end\n  end\nend\n`
  const abstractWorker = 'module Workers\n  class Base\n    include Sidekiq::Job\n\n    def perform(message)\n      process(message)\n    end\n\n    def process(_message)\n      raise NotImplementedError\n    end\n  end\nend\n'

  test('knows which classes are workers', () => {
    expect([...outlineOf(worker('Workers')).workers]).toEqual(['Workers::Reminder'])
    expect([...outlineOf('module Leads\n  class Event < Base\n    sidekiq_options queue: :leads\n  end\nend\n').workers]).toEqual(['Leads::Event'])
    expect([...outlineOf(abstractWorker).workers]).toEqual([])
  })

  test('finds a worker moved to a new name', () => {
    const changes = breakingChanges(outlineOf(worker('Workers')), outlineOf(worker('Leads::Workers')))
    expect(changes.filter(change => change.kind === 'worker-removed')).toEqual([
      { kind: 'worker-removed', worker: 'Workers::Reminder', renamedTo: 'Leads::Workers::Reminder' },
    ])
  })

  test('finds perform arguments that queued jobs no longer fit', () => {
    expect(breakingChanges(outlineOf(worker('Workers')), outlineOf(worker('Workers', 'lead_id, user_id')))).toEqual([
      { kind: 'worker-arguments', worker: 'Workers::Reminder', before: 'lead_id', after: 'lead_id, user_id' },
    ])
    expect(breakingChanges(outlineOf(worker('Workers')), outlineOf(worker('Workers', 'lead_id, user_id = nil')))).toEqual([])
  })
})

describe('worker aliases', () => {
  const alias = '# Keeps jobs queued before the move working\nmodule Workers\n  Reminder = ::Leads::Workers::Reminder\nend\n'

  test('reads an alias and what it points at', () => {
    expect([...outlineOf(alias).aliases]).toEqual([['Workers::Reminder', '::Leads::Workers::Reminder']])
  })

  test('flags a removed worker alias', () => {
    expect(breakingChanges(outlineOf(alias), outlineOf('module Workers\nend\n'))).toEqual([
      { kind: 'worker-alias-removed', alias: 'Workers::Reminder', target: '::Leads::Workers::Reminder' },
    ])
  })
})
