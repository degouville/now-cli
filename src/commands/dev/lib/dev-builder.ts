import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createFunction } from '@zeit/fun';
import glob from '@now/build-utils/fs/glob';
import FileFsRef from '@now/build-utils/file-fs-ref';
import ignore, { Ignore } from '@zeit/dockerignore';

import wait from '../../../util/output/wait';
import DevServer from './dev-server';
import { NowError } from '../../../util/now-error';
import { installBuilder, getBuilder } from './builder-cache';
import {
  BuildConfig,
  BuilderOutput,
  BuilderOutputs,
  BuiltLambda
} from './types';

/**
 * Build project to statics & lambdas
 */
export async function buildUserProject(
  buildsConfig: BuildConfig[],
  devServer: DevServer
) {
  try {
    devServer.setStatusBusy('Installing builders');
    await installBuilders(buildsConfig);

    devServer.setStatusBusy('Building lambdas');
    const assets = await executeBuilds(buildsConfig, devServer);

    devServer.setStatusIdle();
    return assets;
  } catch (err) {
    devServer.setStatusIdle();
    throw err;
  }
}

async function installBuilders(buildsConfig: BuildConfig[]) {
  const builders = buildsConfig
    .map(build => build.use)
    .filter(pkg => pkg !== '@now/static')
    .concat('@now/build-utils');

  for (const builder of builders) {
    const stopSpinner = wait(`Installing ${builder}`);
    await installBuilder(builder);
    stopSpinner();
  }
}

async function executeBuilds(
  buildsConfig: BuildConfig[],
  devServer: DevServer
) {
  const { cwd } = devServer;
  const files = await collectProjectFiles('**', cwd);
  let results: BuilderOutputs = {};

  for (const build of buildsConfig) {
    try {
      devServer.logDebug(`Build ${JSON.stringify(build)}`);

      const builder = getBuilder(build.use);

      const entries = Object.values(await collectProjectFiles(build.src, cwd));

      for (const entry of entries) {
        const output = await builder.build({
          files,
          entrypoint: path.relative(cwd, entry.fsPath),
          workPath: cwd,
          config: build.config || {},
          isDev: true
        });
        Object.assign(results, output);
      }
    } catch (err) {
      throw err;
      /*
      throw new NowError({
        code: 'NOW_BUILDER_FAILURE',
        message: `Failed building ${chalk.bold(build.src)} with ${build.use}`,
        meta: err.stack
      });
       */
    }
  }

  await Promise.all(
    Object.values(results).map(async (asset: BuilderOutput) => {
      if (asset.type !== 'Lambda') return;
      asset.fn = await createFunction({
        Code: { ZipFile: asset.zipBuffer },
        Handler: asset.handler,
        Runtime: asset.runtime,
        Environment: {
          Variables: {
            // TODO: resolve secret env vars
            //...nowJson.env,
            ...asset.environment,
            NOW_REGION: 'dev1'
          }
        }
      });
    })
  );

  return results;
}

/**
 * Collect project files, with .gitignore and .nowignore honored.
 */
export async function collectProjectFiles(pattern: string, cwd: string) {
  const ignore = createIgnoreList(cwd);
  const files = await glob(pattern, cwd);
  const filteredFiles: { [key: string]: FileFsRef } = {};

  Object.entries(files).forEach(([name, file]) => {
    if (!ignore.ignores(name)) {
      filteredFiles[name] = file;
    }
  });

  return filteredFiles;
}

/**
 * Create ignore list according .gitignore & .nowignore in cwd
 */
export function createIgnoreList(cwd: string): Ignore {
  const ig = ignore();

  const gitignore = path.join(cwd, '.gitignore');
  const nowignore = path.join(cwd, '.nowignore');

  if (fs.existsSync(gitignore)) {
    ig.add(fs.readFileSync(gitignore, 'utf8'));
  }

  if (fs.existsSync(nowignore)) {
    ig.add(fs.readFileSync(nowignore, 'utf8'));
  }

  // special case for now-cli's usage
  ig.add('.nowignore');

  // temp workround for excluding ncc/ & user/ folder generated by builders
  // should be removed later.
  ig.add('ncc');
  ig.add('user');

  return ig;
}
