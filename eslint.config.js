import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow intentionally-unused args when prefixed with _ (Express handlers).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // server-side logging is expected
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // Browser-context test scripts that talk to a running server use fetch/Blob/FormData.
    files: ['test-*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    ignores: ['node_modules/**', 'storage/**', 'dist/**', 'coverage/**'],
  },
  prettier,
];