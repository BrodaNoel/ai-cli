import globals from 'globals';
import pluginJs from '@eslint/js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['**/*.js'], languageOptions: { sourceType: 'module' } },
  {
    languageOptions: {
      globals: { ...globals.browser, process: true, __dirname: true },
    },
  },
  pluginJs.configs.recommended,
];
