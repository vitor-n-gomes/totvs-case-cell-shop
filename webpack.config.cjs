const path = require('node:path');
const { TsconfigPathsPlugin } = require('tsconfig-paths-webpack-plugin');

module.exports = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    // Read paths where they are declared; no inherited baseUrl is required.
    plugins: [
      new TsconfigPathsPlugin({
        configFile: path.resolve(__dirname, 'tsconfig.json'),
      }),
      ...(config.resolve.plugins ?? []).filter(
        (plugin) => !(plugin instanceof TsconfigPathsPlugin),
      ),
    ],
  },
});
