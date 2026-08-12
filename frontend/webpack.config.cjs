const fs = require('node:fs');
const path = require('node:path');

class StaticIndexPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('StaticIndexPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'StaticIndexPlugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          const source = fs.readFileSync(path.resolve(__dirname, 'public/index.html'), 'utf8');
          compilation.emitAsset('index.html', new compiler.webpack.sources.RawSource(source));
        },
      );
    });
  }
}

module.exports = {
  mode: 'production',
  entry: path.resolve(__dirname, 'src/index.js'),
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'assets/app.js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        type: 'asset/source',
      },
    ],
  },
  plugins: [new StaticIndexPlugin()],
  devtool: false,
  performance: { hints: false },
};
