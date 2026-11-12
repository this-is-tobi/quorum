import antfu from '@antfu/eslint-config'

// The globals neither the core nor a profile may use: the process, the runtime, the network
// (`fetch`, `WebSocket`, `EventSource`), another thread (`Worker`), and the global object itself.
const ENVIRONMENT_GLOBALS = [
  'process',
  'fetch',
  'WebSocket',
  'EventSource',
  'Worker',
  'Bun',
  'globalThis',
  'global',
  'self',
]

export default antfu(
  {
    stylistic: {
      overrides: {
        'perfectionist/sort-imports': 'off',
        'antfu/if-newline': 'off',
        'jsonc/sort-keys': 'off',
        'no-console': 'off',
        'node/prefer-global/process': ['error', 'always'],
        'node/prefer-global/console': ['error', 'always'],
        'node/prefer-global/buffer': ['error', 'always'],
        'style/comma-dangle': ['error', 'always-multiline'],
        'style/quote-props': [
          'error',
          'as-needed',
          { keywords: false, unnecessary: true },
        ],
        'style/brace-style': [
          'error',
          '1tbs',
          { allowSingleLine: true },
        ],
        'style/max-statements-per-line': [
          'error',
          { max: 2 },
        ],
        'ts/ban-ts-comment': 'off',
        'unused-imports/no-unused-imports': 'error',
        'unused-imports/no-unused-vars': [
          'error',
          {
            vars: 'all',
            varsIgnorePattern: '^_',
            args: 'after-used',
            argsIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
          },
        ],
      },
    },
    typescript: true,
    yaml: {
      overrides: {
        'yaml/quotes': [
          'error',
          { prefer: 'double' },
        ],
        'yaml/indent': [
          'error',
          2,
          { indentBlockSequences: false },
        ],
      },
    },
    ignores: [
      '**/node_modules',
      '**/bun.lock',
      '**/.turbo',
      '**/tsconfig.json',
      '**/dist/',
      '**/bin/',
      '**/types/',
      '**/coverage/',
      '**/*.d.ts',
    ],
  },
  {
    // The core is pure: a core module imports only core modules, zod, node:crypto and package.json.
    files: ['src/core/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|zod$|node:crypto$|\\.\\./\\.\\./package\\.json$)', message: 'The core imports only core modules, zod, node:crypto and package.json.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // One level down (stages/), `../` is still the core; anything deeper must not climb out either.
    files: ['src/core/*/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\.\\.?/(?!.*\\.\\.)|zod$|node:crypto$|\\.\\./\\.\\./\\.\\./package\\.json$)', message: 'The core imports only core modules, zod, node:crypto and package.json.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // A profile is data: it imports core types and nothing else.
    files: ['src/profiles/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'ts/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\.\\./core/)', message: 'A profile imports only core types.' },
            { regex: '^\\.\\./core/', allowTypeImports: true, message: 'A profile imports only core types.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // An adapter sees the core only through its ports, errors and types.
    files: ['src/providers/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(ports|errors|types)\\.ts$)', message: 'A provider imports only its own modules and core/ports.ts, core/errors.ts and core/types.ts.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'process',
        'Bun',
        'globalThis',
        'global',
        'self',
      ],
    },
  },
  {
    // The adapter runs the claude CLI, so it alone may spawn a process, make and remove a temporary directory
    // (`node:fs` for the removal when quorum exits) and read the process's environment; it keeps every other
    // rule of the providers.
    files: ['src/providers/claude-code.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(ports|errors|types)\\.ts$|node:(child_process|fs|fs/promises|os|path)$)', message: 'The claude-code adapter imports only its own modules, core/ports.ts, core/errors.ts, core/types.ts, node:child_process, node:fs, node:fs/promises, node:os and node:path.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'Bun',
        'globalThis',
        'global',
        'self',
      ],
      // `process.getBuiltinModule` loads any built-in module, which would go around the import rule above.
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'getBuiltinModule', message: 'The claude-code adapter names the built-in modules it imports.' },
      ],
    },
  },
  {
    // The configuration reads files and the environment, and builds on the core, the profiles and the
    // providers; it never reaches the network or another thread, nor the global object, which would
    // reach them around this rule.
    files: ['src/config/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./(core|profiles|providers)/(?!.*\\.\\.)|zod$|yaml$|node:(fs|fs/promises|path|url)$)', message: 'A config module imports only config modules, the core, the profiles, the providers, zod, yaml, node:fs, node:fs/promises, node:path and node:url.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'fetch',
        'WebSocket',
        'EventSource',
        'Worker',
        'globalThis',
        'global',
        'self',
      ],
    },
  },
  {
    // src/testing/ holds the test helpers, which only spec files import. The blocks above keep it out
    // of the core, the profiles, the providers and the config layer; this one covers the rest.
    files: ['src/cli/**/*.ts', 'src/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(?:^|/)testing/', message: 'Only spec files import src/testing/.' },
          ],
        },
      ],
    },
  },
)
