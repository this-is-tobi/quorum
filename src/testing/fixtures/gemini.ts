/**
 * Replies of the Gemini API's `generateContent`, in the shapes its reference gives
 * (https://aistudio.google.com/api-reference/generate-content/generate-content, and the discovery
 * document https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta). Each names its
 * source; the text is replaced by a reply quorum can read.
 */

/** A candidate that finished (`Candidate`). */
export const candidate = {
  content: {
    parts: [
      { text: '{}' },
    ],
    role: 'model',
  },
  finishReason: 'STOP',
  index: 0,
}

/** A response with one candidate, as the reference shows one (`GenerateContentResponse`). */
export const generateContentResponse = {
  candidates: [candidate],
  usageMetadata: {
    promptTokenCount: 1840,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 336,
    totalTokenCount: 2180,
    promptTokensDetails: [
      { modality: 'TEXT', tokenCount: 1840 },
    ],
  },
  modelVersion: 'gemini-3.8-flash',
  responseId: 'mAitaLmkHPPlz7IPvtfUqQ4',
}

/** A prompt the safety filter blocked: `promptFeedback.blockReason` set, and no candidates (`PromptFeedback`). */
export const promptBlocked = {
  promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
  usageMetadata: { promptTokenCount: 1840, totalTokenCount: 1840 },
  modelVersion: 'gemini-3.8-flash',
  responseId: 'nBjubOnlIQPm0NAPxbXVsQ8',
}

/** A reply cut off by the token limit: `finishReason: 'MAX_TOKENS'`. */
export const truncated = {
  ...generateContentResponse,
  candidates: [
    {
      ...candidate,
      content: {
        parts: [
          { text: '{"kee' },
        ],
        role: 'model',
      },
      finishReason: 'MAX_TOKENS',
    },
  ],
}

/**
 * A reply with a thought summary first and a thought signature on the answer's part
 * (https://aistudio.google.com/docs/thinking?generate-content=true).
 */
export const withThoughts = {
  ...generateContentResponse,
  candidates: [
    {
      ...candidate,
      content: {
        parts: [
          { text: '**Checking the query**\n\nThe id reaches the query as a bound parameter.', thought: true },
          { text: '{"keep":false,', thoughtSignature: 'CiQB0e2Kb3dRh+BYdbZvmulSN2Pwwgw3N1mwr8Eu4QqLiUq6uc0' },
          { text: '"reasoning":"r"}' },
        ],
        role: 'model',
      },
    },
  ],
}

/** The error body of a non-2xx reply: gRPC status details (https://aistudio.google.com/docs/api-errors?generate-content=true). */
export const invalidKey = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'generativelanguage.googleapis.com' },
      },
    ],
  },
}
