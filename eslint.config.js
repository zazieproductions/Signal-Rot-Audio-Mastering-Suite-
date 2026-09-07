import js from '@eslint/js';
import globals from 'globals';

/**
 * ESLint flat configuration.
 *
 * The rules that matter here are the ones that catch the classes of bug this codebase has
 * actually had: unused variables that indicate a half-finished refactor, `eqeqeq` (the
 * audited code used `!=null` idioms in forty places), and `no-implicit-globals`.
 *
 * `no-console` is a warning, not an error: an audio engine legitimately needs to report
 * decode failures and worker fallbacks to the console.
 */
export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'lab-results/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-implicit-coercion': ['warn', { boolean: false }],
      'no-throw-literal': 'error',
      'prefer-template': 'warn',
      'object-shorthand': 'warn',
      'no-else-return': 'warn',
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['tests/**/*.js', 'e2e/**/*.js', 'tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // `tools/` is Node-only developer tooling: CLIs, fixture generators and the
    // independent validators. It runs outside the browser, so it gets Node globals —
    // but it is still linted, because a broken validator is a validator that lies.
    // `qa/scripts` is the sonic-QA rig (see qa/README.md): real renders driven headlessly,
    // measured with independent meters. Node-only, and linted for the same reason.
    files: ['tools/**/*.js', 'qa/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['*.config.js', 'vite.config.js', 'vitest.config.js', 'playwright.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
  },
];
