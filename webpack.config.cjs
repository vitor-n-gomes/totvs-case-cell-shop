const path = require('node:path');
const { TsconfigPathsPlugin } = require('tsconfig-paths-webpack-plugin');

module.exports = (webpackConfig) => ({
  ...webpackConfig,
  resolve: {
    ...webpackConfig.resolve,
    // Read paths where they are declared; no inherited baseUrl is required.
    plugins: [
      new TsconfigPathsPlugin({
        configFile: path.resolve(__dirname, 'tsconfig.json'),
      }),
      ...(webpackConfig.resolve.plugins ?? []).filter(
        (plugin) => !(plugin instanceof TsconfigPathsPlugin),
      ),
    ],
  },
});
