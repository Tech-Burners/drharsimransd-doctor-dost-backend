// ESLint 9 flat config. A direct translation of the old .eslintrc.json (same rules, same
// ignores from .eslintignore) so `npm run lint` runs again. No new dependencies; no
// prettier plugin (it was never installed).
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'public/**', 'logs/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.jest },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // from .eslintrc.json
      // the base rules misreport TypeScript (type signatures, enums, ambient types); the
      // TypeScript-aware versions replace them
      'no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      'no-unused-expressions': 'error',
      'prefer-const': 'error',
      'no-console': 'warn',
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
