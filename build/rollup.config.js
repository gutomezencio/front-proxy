import babel from 'rollup-plugin-babel'
import autoExternal from 'rollup-plugin-auto-external'
import alias from 'rollup-plugin-alias'
import json from '@rollup/plugin-json'
import copy from 'rollup-plugin-copy'
// import { eslint } from 'rollup-plugin-eslint'
import { terser } from "rollup-plugin-terser"
import del from 'rollup-plugin-delete'
import config from './config'

const defaultConfig = {
  plugins: [
    json(),
    babel({
      exclude: 'node_modules/**'
    }),
    autoExternal(),
    alias({
      src: config.srcPath,
      dist: config.distPath
    }),
    terser()
  ],
}

export default [
  {
    plugins: [
      del({ targets: 'dist/*' }),
      copy({
        targets: [
          { src: 'src/bin-running.js', dest: 'dist' }
        ]
      }),
      ...defaultConfig.plugins
    ],
    input: 'src/proxy-server.js',
    output: {
      file: `dist/proxy-server.js`,
      format: 'cjs'
    }
  },
  {
    ...defaultConfig,
    input: 'src/start.js',
    output: {
      file: `dist/start.js`,
      format: 'cjs'
    }
  }
]
