import { describe, expect, it } from 'vitest'
import { shapeMessages } from '../providers/messages.ts'
import { textTokens } from '../providers/size.ts'
import type { CompletionRequest } from './ports.ts'
import { requestTokens } from './tokens.ts'

describe('requestTokens', () => {
  it('counts the system text, every message and the reply schema at the bound of each', () => {
    expect(requestTokens({
      system: 'abc',
      messages: [
        { role: 'user', content: 'de' },
        { role: 'assistant', content: 'f' },
      ],
      output: {
        name: 'x',
        schema: { a: 1 },
      },
    })).toBe(3 + 2 + 1 + 7)
    const schemaBytes = 2
    expect(requestTokens({
      system: '',
      messages: [
        {
          role: 'user',
          content: String.fromCharCode(0x0F81),
        },
      ],
      output: { name: 'x', schema: {} },
    })).toBe(6 + schemaBytes)
  })

  it('equals the size guard\'s count of a request shaped natively', () => {
    const request: CompletionRequest = {
      system: 'instructions',
      messages: [
        { role: 'user', content: 'data' },
      ],
      output: {
        name: 'panel_vote',
        schema: { type: 'object' },
      },
    }
    expect(requestTokens(request)).toBe(33)
    expect(requestTokens(request)).toBe(textTokens(shapeMessages(request, 'native'), request.output))
    expect(textTokens(shapeMessages(request, 'inline'), request.output)).toBe(requestTokens(request) + 2)
  })
})
