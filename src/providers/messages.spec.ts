import { describe, expect, it } from 'vitest'
import type { CompletionRequest } from '../core/ports.ts'
import { shapeMessages } from './messages.ts'

const request: CompletionRequest = {
  system: 'instructions',
  messages: [{ role: 'user', content: 'data' }, { role: 'assistant', content: 'reply' }],
  output: { name: 'panel_vote', schema: {} },
}

describe('shapeMessages', () => {
  it('keeps the system text apart natively, and the conversation as it is', () => {
    expect(shapeMessages(request, 'native')).toEqual({ system: 'instructions', messages: request.messages })
  })

  it('joins the system text and the first user message with a blank line inline, and leaves the rest', () => {
    expect(shapeMessages(request, 'inline')).toEqual({
      system: undefined,
      messages: [{ role: 'user', content: 'instructions\n\ndata' }, { role: 'assistant', content: 'reply' }],
    })
  })

  it('puts the system text in a user message of its own inline when the conversation does not start with one', () => {
    const assistantFirst = { ...request, messages: [{ role: 'assistant' as const, content: 'reply' }] }
    expect(shapeMessages(assistantFirst, 'inline').messages).toEqual([{ role: 'user', content: 'instructions' }, { role: 'assistant', content: 'reply' }])
    expect(shapeMessages({ ...request, messages: [] }, 'inline').messages).toEqual([{ role: 'user', content: 'instructions' }])
  })
})
