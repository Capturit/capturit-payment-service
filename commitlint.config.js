const typeDescriptions = {
  feat: 'A new feature',
  fix: 'A bug fix',
  docs: 'Documentation only changes',
  style: 'Changes that do not affect the meaning of the code (white-space, formatting, etc)',
  refactor: 'A code change that neither fixes a bug nor adds a feature',
  perf: 'A code change that improves performance',
  test: 'Adding missing tests or correcting existing tests',
  build: 'Changes that affect the build system or external dependencies',
  ci: 'Changes to CI configuration files and scripts',
  chore: "Other changes that don't modify src or test files",
  revert: 'Reverts a previous commit',
};

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [0],
    'type-enum-with-descriptions': [2, 'always'],
    'subject-case': [2, 'never', ['start-case', 'pascal-case']],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [2, 'always', 100],
  },
  helpUrl: 'https://www.conventionalcommits.org/',
  prompt: {
    messages: {
      type:
        'Select the type of change you are submitting:\n' +
        Object.entries(typeDescriptions)
        .map(([key, desc]) => `  ${key.padEnd(10)} - ${desc}`)
        .join('\n'),
    },
  },
  plugins: [
    {
      rules: {
        'type-enum-with-descriptions': (parsed) => {
          const validTypes = [
            'feat',
            'fix',
            'docs',
            'style',
            'refactor',
            'perf',
            'test',
            'build',
            'ci',
            'chore',
            'revert',
          ];

          if (!parsed.type || !validTypes.includes(parsed.type)) {
            const descriptions = Object.entries(typeDescriptions)
            .map(([key, desc]) => `  - ${key.padEnd(10)}: ${desc}`)
            .join('\n');

            return [
              false,
              `\nType must be one of the following:\n${descriptions}\n\nExample: feat: add new feature X`,
            ];
          }
          return [true];
        },
      },
    },
  ],
};
