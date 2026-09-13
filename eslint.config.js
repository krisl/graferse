import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {
        ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // carried over from the tslint config this replaced
            indent: ['error', 4, { SwitchCase: 1 }],
            'no-console': 'off',
            'one-var': 'off',
            // an override must keep its signature even when it ignores an
            // argument, so allow a leading underscore to say so
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
        },
    },
    {
        // tests name every node in a graph to document its shape, even the
        // ones no assertion reads back
        files: ['**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': 'off',
        },
    },
)
