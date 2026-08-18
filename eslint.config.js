import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded from a CDN <script> tag for MP3 export.
        lamejs: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Optional Web Audio operations are routinely wrapped in a bare
      // try/catch; an empty catch is intentional there.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['tests/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
