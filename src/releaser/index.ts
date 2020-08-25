import 'source-map-support/register';
import log from '../utils/logger';
import shell from 'shelljs';
import { prepareWorkspace, SimpleGit, git, ReleaseBranch } from '../utils/git';
import { existsSync, ensureDir, writeFile } from 'fs-extra';
import { get as getVersioning } from 'renovate/dist/versioning';
import { setFailed } from '@actions/core';
import { isDryRun, getWorkspace, isCI } from '../util';
import chalk from 'chalk';

const verRe = /\/(?<name>(?<release>\d+\.\d+)\/python-(?<version>\d+\.\d+\.\d+)\.tar\.xz)$/;

async function prepare(ws: string): Promise<SimpleGit> {
  const repo = await prepareWorkspace(ws, true);

  if (isCI()) {
    await repo.addConfig('user.name', 'Renovate Bot');
    await repo.addConfig('user.email', 'bot@renovateapp.com');
  }

  return git(`${ws}/data`);
}
async function updateReadme(path: string): Promise<void> {
  const files = shell.find(`${path}/**/*.tar.xz`);
  log('Processing files:', files.length);
  const releases: Record<string, Record<string, string>> = Object.create(null);

  for (const file of files) {
    const m = verRe.exec(file);

    if (!m?.groups) {
      log.warn('Invalid file:', file);
      continue;
    }

    const { name, version, release } = m.groups;

    if (!releases[release]) {
      releases[release] = Object.create(null);
    }

    releases[release][version] = name;
  }

  const dockerVer = getVersioning('docker');
  const semver = getVersioning('semver');

  let md = `# python releases\n\n` + `Prebuild python builds for ubuntu\n\n`;
  for (const release of Object.keys(releases).sort(dockerVer.sortVersions)) {
    md += `\n\n## ubuntu ${release}\n\n`;

    const data = releases[release];

    for (const version of Object.keys(data).sort(semver.sortVersions)) {
      md += `* [${version}](${data[version]})\n`;
    }
  }

  await writeFile(`${path}/README.md`, md);
}

(async () => {
  try {
    log.info('Releaser started');
    const dryRun = isDryRun();
    const ws = getWorkspace();
    const data = `${ws}/data`;
    const cache = `${ws}/.cache`;

    if (dryRun) {
      log.warn(chalk.yellow('[DRY_RUN] detected'));
    }

    log('Prepare worktree');
    const git = await prepare(ws);

    const versions = new Set<string>();
    const tags = new Set((await git.tags()).all);

    log.info('Checking for new builds');
    if (existsSync(cache)) {
      const files = shell.find(`${cache}/**/*.tar.xz`);
      log('Processing files:', files.length);

      for (const file of files) {
        const m = verRe.exec(file);

        if (!m?.groups) {
          log.warn('Invalid file:', file);
          continue;
        }
        log('Processing file:', file);

        const name = m.groups.name;
        const version = m.groups.version;

        await ensureDir(`${data}/${m.groups.release}`);

        shell.cp('-r', file, `${data}/${name}`);

        if (tags.has(version)) {
          log('Skipping existing version:', version);
          continue;
        }

        versions.add(version);
      }
    }

    log.info('Update readme');
    await updateReadme(data);

    log.info('Update releases');
    await git.add('.');
    const status = await git.status();
    if (!status.isClean()) {
      log('Commiting files');
      git.commit('updated files');
      if (dryRun) {
        log.warn(
          chalk.yellow('[DRY_RUN]'),
          chalk.blue('Would push:'),
          ReleaseBranch
        );
      } else {
        git.push('origin', ReleaseBranch, { '--force': null });
      }
    }

    log.info('Update tags');
    for (const version of versions) {
      log('Add tag', version);
      git.addTag(version);
    }

    log('Push tags');
    if (dryRun) {
      log.warn(chalk.yellow('[DRY_RUN]'), chalk.blue('Would push tags'));
    } else {
      git.pushTags();
    }
  } catch (error) {
    log(error.stack);
    setFailed(error.message);
  }
})();
