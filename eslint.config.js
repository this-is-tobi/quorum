import antfu from '@antfu/eslint-config'

// The globals neither the core, a profile nor a reporter may use: the process, the runtime, the network
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
    // A profile is data: it imports core types and the other profiles, nothing else.
    files: ['src/profiles/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'ts/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\.\\./core/|\\./[a-z][a-z-]*\\.ts$)', message: 'A profile imports only core types and the other profiles.' },
            { regex: '^\\.\\./core/', allowTypeImports: true, message: 'A profile imports only core types and the other profiles.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // An adapter sees the core only through its ports, errors, types and token count.
    files: ['src/providers/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(ports|errors|types|tokens)\\.ts$)', message: 'A provider imports only its own modules and core/ports.ts, core/errors.ts, core/types.ts and core/tokens.ts.' },
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
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(ports|errors|types|tokens)\\.ts$|node:(child_process|fs|fs/promises|os|path)$)', message: 'The claude-code adapter imports only its own modules, core/ports.ts, core/errors.ts, core/types.ts, core/tokens.ts, node:child_process, node:fs, node:fs/promises, node:os and node:path.' },
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
    // The bench reads a suite and writes a run directory, and runs its reviews through the config layer
    // and the core; it never reaches the process, the network or another thread, nor the global object,
    // and never the CLI or the test helpers.
    files: ['src/bench/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./(core|config)/(?!.*\\.\\.)|zod$|yaml$|node:(fs|fs/promises|path|crypto)$)', message: 'A bench module imports only bench modules, the core, the config layer, zod, yaml, node:fs, node:fs/promises, node:path and node:crypto.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // The state layer is the one place that reads and writes a state directory: it builds on the core and the
    // config layer's file helpers, and imports nothing else but zod and the file, path and hash modules. It reads no
    // process, and never the network, another thread or the global object.
    files: ['src/state/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(?!.*\\.\\.)|\\.\\./config/load\\.ts$|zod$|node:(fs|fs/promises|path|crypto)$)', message: 'A state module imports only state modules, the core, config/load.ts, zod, node:fs, node:fs/promises, node:path and node:crypto.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // A reporter renders a result it is given: it imports only report modules, the core and zod, and reads no
    // global of the environment.
    files: ['src/report/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(?!.*\\.\\.)|zod$)', message: 'A reporter imports only report modules, the core and zod.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // The git runner is the one module that runs git: it starts a process, and reads neither files nor the
    // environment (the caller hands it one), the config layer nor the sources.
    files: ['src/git/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./core/(errors|types|clock)\\.ts$|node:(child_process|path)$)', message: 'The git runner imports only its own modules, core/errors.ts, core/types.ts, core/clock.ts, node:child_process and node:path.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // A source reads a repository through the git runner, and the files a review names; it never starts a
    // process itself, and reads neither the environment nor the network.
    files: ['src/sources/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./(core|git|config)/(?!.*\\.\\.)|node:(fs|fs/promises|path)$)', message: 'A source imports only source modules, the core, the git runner, the config layer, node:fs, node:fs/promises and node:path.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // The context reader reads a review's documents from a commit of the repository, through the git runner and the one
    // module that opens a repository (sources/repository.ts), with the types of the sources' reader and none of its values: it
    // never reads the working tree, the environment or the network, nor the global object. Only the CLI and the library import it.
    files: ['src/context/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'ts/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./(core|git|config)/(?!.*\\.\\.)|\\.\\./sources/(repository|read)\\.ts$|node:(fs|fs/promises|path)$)', message: 'A context module imports only context modules, the core, the git runner, the config layer, the sources\' repository opener, the types of the sources\' reader, node:fs, node:fs/promises and node:path.' },
            { regex: '^\\.\\./sources/read\\.ts$', allowTypeImports: true, message: 'A context module imports only the types of the sources\' reader.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // The MCP server is the one place that imports the MCP SDK, and only on request: it reads files and the
    // repository through the layers below it, and never the process, the network or another thread, nor the
    // global object. The first segment of the pattern admits a module of its own, the layers it builds on
    // (a link up and out of one is refused), the CLI's output helpers, package.json, the SDK's two entry
    // points, zod and the file, path, URL and stream modules.
    files: ['src/mcp/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./(core|report|sources|config|git)/(?!.*\\.\\.)|\\.\\./cli/io\\.ts$|\\.\\./\\.\\./package\\.json$|@modelcontextprotocol/server(?:/stdio)?$|zod$|node:(fs|fs/promises|path|url|stream)$)', message: 'An MCP module imports only its own modules, the core, the report layer, the sources, the config layer, the git runner, cli/io.ts, package.json, the MCP SDK, zod, node:fs, node:fs/promises, node:path, node:url and node:stream.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
  {
    // src/testing/ holds the test helpers, which only spec files import. The blocks above keep it out
    // of the core, the profiles, the providers and the config layer; this one covers the rest. The MCP SDK
    // stays out of the CLI and the library, which load src/mcp/ with import() alone: this rule does not read
    // an import(), so a quorum that does not run `quorum mcp` never loads the SDK.
    files: ['src/cli/**/*.ts', 'src/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(?:^|/)testing/', message: 'Only spec files import src/testing/.' },
            { regex: '^@modelcontextprotocol/', message: 'Only src/mcp/ imports the MCP SDK.' },
            { regex: '(?:^|/)mcp/', message: 'Only import() loads src/mcp/, so quorum and the library never load the MCP SDK.' },
            { regex: '^(?:node:)?http[s2]?$', message: 'Only src/testing/server.ts uses node:http.' },
          ],
        },
      ],
    },
  },
  {
    // The fake server of src/testing/server.ts alone uses node:http, and only spec files import it.
    files: ['src/testing/**/*.ts'],
    ignores: ['src/testing/server.ts', 'src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?:node:)?http[s2]?$', message: 'Only src/testing/server.ts uses node:http.' },
            { regex: '^\\.{1,2}/server\\.ts$', message: 'Only spec files import src/testing/server.ts.' },
          ],
        },
      ],
    },
  },
  {
    // The view draws a review from its events: a view module imports only view modules, the core and the report
    // layer, and reads no global of the environment. The CLI hands it the stream, the environment and the clock.
    files: ['src/cli/view/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./(?!.*\\.\\.)|\\.\\./\\.\\./(core|report)/(?!.*\\.\\.))', message: 'A view module imports only view modules, the core and the report layer.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...ENVIRONMENT_GLOBALS],
    },
  },
)
