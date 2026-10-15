// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** Sources of nondeterminism that must never be used by the simulation engine. */
const nondeterminismBans = {
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Use a keyed Rng stream (rngFor) instead.' },
    { object: 'Date', property: 'now', message: 'Simulation time is the tick counter.' },
    {
      object: 'performance',
      property: 'now',
      message: 'Wall-clock time is not a simulation input.',
    },
    {
      object: 'Math',
      property: 'exp',
      message: 'Transcendental functions are not bit-identical across JS engines.',
    },
    {
      object: 'Math',
      property: 'log',
      message: 'Transcendental functions are not bit-identical across JS engines.',
    },
    {
      object: 'Math',
      property: 'pow',
      message: 'Use explicit multiplication; Math.pow is not guaranteed exact.',
    },
    {
      object: 'Math',
      property: 'sin',
      message: 'Transcendental functions are not bit-identical across JS engines.',
    },
    {
      object: 'Math',
      property: 'cos',
      message: 'Transcendental functions are not bit-identical across JS engines.',
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date']",
      message: 'Simulation time is the tick counter.',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'setTimeout', message: 'The engine is synchronous; scheduling belongs to the runner.' },
    {
      name: 'setInterval',
      message: 'The engine is synchronous; scheduling belongs to the runner.',
    },
    { name: 'fetch', message: 'The engine performs no I/O.' },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/sim-core/src/**/*.ts'],
    rules: nondeterminismBans,
  },
  {
    files: ['packages/sim-core/bench/**/*.ts', 'apps/server/src/index.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
