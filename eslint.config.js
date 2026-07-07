import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Positions flow through plain number tuples on purpose (see math.ts);
      // non-null assertions are used where the frame tree guarantees a parent.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['*.js', '*.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
