import { describe, expect, it } from 'vitest'
import { baseUrlIssues } from './options.ts'

describe('baseUrlIssues', () => {
  it('accepts an http or https URL with a host', () => {
    expect(baseUrlIssues('p.baseUrl', 'http://localhost:11434/v1')).toEqual([])
    expect(baseUrlIssues('p.baseUrl', 'https://api.example.com')).toEqual([])
  })

  it.each([['localhost:11434/v1'], ['https:///v1'], ['ftp://h/v1'], ['not a url']])('refuses %j, without repeating it', (baseUrl) => {
    expect(baseUrlIssues('p.baseUrl', baseUrl)).toEqual([{ path: 'p.baseUrl', message: 'must be an http:// or https:// URL with a host' }])
  })

  it('refuses a query or a fragment, which the endpoint path would follow', () => {
    for (const baseUrl of ['https://h/v1?api-version=1', 'https://h/v1?', 'https://h/v1#x']) {
      expect(baseUrlIssues('p.baseUrl', baseUrl), baseUrl).toEqual([{ path: 'p.baseUrl', message: 'must not hold a query or a fragment' }])
    }
    expect(baseUrlIssues('p.baseUrl', 'https://u:p@h/v1?k=q')).toHaveLength(2)
  })

  it('refuses a user name or a password in the URL, without repeating them', () => {
    for (const baseUrl of ['https://user:pw-secret@h/v1', 'https://user@h/v1', 'https://:pw-secret@h/v1']) {
      expect(baseUrlIssues('p.baseUrl', baseUrl), baseUrl).toEqual([{ path: 'p.baseUrl', message: 'must not hold a user name or password: send a key with apiKey' }])
    }
  })
})
