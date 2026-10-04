const artifacts = process.env.RUNNER_TEMP;
const convention = { preset: 'conventionalcommits', presetConfig: {} };

module.exports = {
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', convention],
    ['@semantic-release/release-notes-generator', convention],
    ['@semantic-release/npm', { tarballDir: artifacts }],
    ['@semantic-release/github', {
      assets: artifacts ? [`${artifacts}/*.tgz`] : [],
      successComment: false,
      failComment: false,
      releasedLabels: false,
    }],
  ],
};
