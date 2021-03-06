import test from 'ava';
import {outputJson, readJson, readFile, pathExists} from 'fs-extra';
import execa from 'execa';
import {stub} from 'sinon';
import tempy from 'tempy';
import clearModule from 'clear-module';
import SemanticReleaseError from '@semantic-release/error';
import npmRegistry from './helpers/npm-registry';

// Save the current process.env
const envBackup = Object.assign({}, process.env);
// Save the current working diretory
const cwd = process.cwd();
// Disable logs during tests
stub(process.stdout, 'write');

test.before(async () => {
  // Start the local NPM registry
  await npmRegistry.start();
});

test.beforeEach(t => {
  // Delete env paramaters that could have been set on the machine running the tests
  delete process.env.NPM_TOKEN;
  delete process.env.NPM_USERNAME;
  delete process.env.NPM_PASSWORD;
  delete process.env.NPM_EMAIL;
  delete process.env.DEFAULT_NPM_REGISTRY;
  // Change current working directory to a temporary directory
  process.chdir(tempy.directory());
  // Clear npm cache to refresh the module state
  clearModule('..');
  t.context.m = require('..');
  // Stub the logger
  t.context.log = stub();
  t.context.logger = {log: t.context.log};
});

test.afterEach.always(() => {
  // Restore process.env
  process.env = envBackup;
  // Restore the current working directory
  process.chdir(cwd);
});

test.after.always(async () => {
  // Stop the local NPM registry
  await npmRegistry.stop();
});

test.serial('Skip npm auth verification if "npmPublish" is false', async t => {
  process.env.NPM_TOKEN = 'wrong_token';
  const pkg = {name: 'published', version: '1.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  await t.notThrows(t.context.m.verifyConditions({npmPublish: false}, {options: {}, logger: t.context.logger}));
});

test.serial('Skip npm token verification if "npmPublish" is false', async t => {
  delete process.env.NPM_TOKEN;
  const pkg = {name: 'published', version: '1.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  await t.notThrows(
    t.context.m.verifyConditions(
      {npmPublish: false},
      {options: {publish: ['@semantic-release/npm']}, logger: t.context.logger}
    )
  );
});

test.serial('Throws error if NPM token is invalid', async t => {
  process.env.NPM_TOKEN = 'wrong_token';
  process.env.DEFAULT_NPM_REGISTRY = npmRegistry.url;
  const pkg = {name: 'published', version: '1.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);

  const [error] = await t.throws(t.context.m.verifyConditions({}, {options: {}, logger: t.context.logger}));

  t.true(error instanceof SemanticReleaseError);
  t.is(error.code, 'EINVALIDNPMTOKEN');
  t.is(error.message, 'Invalid npm token.');

  const npmrc = (await readFile('.npmrc')).toString();
  t.regex(npmrc, /:_authToken/);
});

test.serial('Skip Token validation if the registry configured is not the default one', async t => {
  process.env.NPM_TOKEN = 'wrong_token';
  const pkg = {name: 'published', version: '1.0.0', publishConfig: {registry: 'http://custom-registry.com/'}};
  await outputJson('./package.json', pkg);
  await t.notThrows(t.context.m.verifyConditions({}, {options: {}, logger: t.context.logger}));

  const npmrc = (await readFile('.npmrc')).toString();
  t.regex(npmrc, /:_authToken/);
});

test.serial('Verify npm auth and package', async t => {
  Object.assign(process.env, npmRegistry.authEnv);

  const pkg = {name: 'valid-token', version: '0.0.0-dev', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  await t.notThrows(t.context.m.verifyConditions({}, {options: {}, logger: t.context.logger}));

  const npmrc = (await readFile('.npmrc')).toString();
  t.regex(npmrc, /_auth =/);
  t.regex(npmrc, /email =/);
});

test.serial('Verify npm auth and package from a sub-directory', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'valid-token', version: '0.0.0-dev', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./dist/package.json', pkg);
  await t.notThrows(t.context.m.verifyConditions({pkgRoot: 'dist'}, {options: {}, logger: t.context.logger}));

  const npmrc = (await readFile('.npmrc')).toString();
  t.regex(npmrc, /_auth =/);
  t.regex(npmrc, /email =/);
});

test.serial('Verify npm auth and package with "npm_config_registry" env var set by yarn', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  process.env.npm_config_registry = 'https://registry.yarnpkg.com'; // eslint-disable-line camelcase
  const pkg = {name: 'valid-token', version: '0.0.0-dev', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  await t.notThrows(t.context.m.verifyConditions({}, {options: {publish: []}, logger: t.context.logger}));

  const npmrc = (await readFile('.npmrc')).toString();
  t.regex(npmrc, /_auth =/);
  t.regex(npmrc, /email =/);
});

test.serial('Throw SemanticReleaseError Array if config option are not valid in verifyConditions', async t => {
  const pkg = {publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  const npmPublish = 42;
  const tarballDir = 42;
  const pkgRoot = 42;
  const errors = [
    ...(await t.throws(
      t.context.m.verifyConditions(
        {},
        {
          options: {
            publish: ['@semantic-release/github', {path: '@semantic-release/npm', npmPublish, tarballDir, pkgRoot}],
          },
          logger: t.context.logger,
        }
      )
    )),
  ];

  t.is(errors[0].name, 'SemanticReleaseError');
  t.is(errors[0].code, 'EINVALIDNPMPUBLISH');
  t.is(errors[1].name, 'SemanticReleaseError');
  t.is(errors[1].code, 'EINVALIDTARBALLDIR');
  t.is(errors[2].name, 'SemanticReleaseError');
  t.is(errors[2].code, 'EINVALIDPKGROOT');
  t.is(errors[3].name, 'SemanticReleaseError');
  t.is(errors[3].code, 'ENOPKGNAME');
});

test.serial('Publish the package', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'publish', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);

  const result = await t.context.m.publish({}, {logger: t.context.logger, nextRelease: {version: '1.0.0'}});

  t.deepEqual(result, {name: 'npm package (@latest dist-tag)', url: undefined});
  t.is((await readJson('./package.json')).version, '1.0.0');
  t.false(await pathExists(`./${pkg.name}-1.0.0.tgz`));
  t.is((await execa('npm', ['view', pkg.name, 'version'])).stdout, '1.0.0');
});

test.serial('Publish the package on a dist-tag', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  process.env.DEFAULT_NPM_REGISTRY = npmRegistry.url;
  const pkg = {name: 'publish-tag', version: '0.0.0', publishConfig: {registry: npmRegistry.url, tag: 'next'}};
  await outputJson('./package.json', pkg);

  const result = await t.context.m.publish({}, {logger: t.context.logger, nextRelease: {version: '1.0.0'}});

  t.deepEqual(result, {name: 'npm package (@next dist-tag)', url: 'https://www.npmjs.com/package/publish-tag'});
  t.is((await readJson('./package.json')).version, '1.0.0');
  t.false(await pathExists(`./${pkg.name}-1.0.0.tgz`));
  t.is((await execa('npm', ['view', pkg.name, 'version'])).stdout, '1.0.0');
});

test.serial('Publish the package from a sub-directory', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'publish-sub-dir', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./dist/package.json', pkg);

  const result = await t.context.m.publish(
    {pkgRoot: 'dist'},
    {logger: t.context.logger, nextRelease: {version: '1.0.0'}}
  );

  t.deepEqual(result, {name: 'npm package (@latest dist-tag)', url: undefined});
  t.is((await readJson('./dist/package.json')).version, '1.0.0');
  t.false(await pathExists(`./${pkg.name}-1.0.0.tgz`));
  t.is((await execa('npm', ['view', pkg.name, 'version'])).stdout, '1.0.0');
});

test.serial('Create the package and skip publish', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  // Delete the authentication to make sure they are not required when skipping publish to registry
  delete process.env.NPM_TOKEN;
  delete process.env.NPM_USERNAME;
  delete process.env.NPM_PASSWORD;
  delete process.env.NPM_EMAIL;

  const pkg = {name: 'skip-publish', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);

  const result = await t.context.m.publish(
    {npmPublish: false, tarballDir: 'tarball'},
    {logger: t.context.logger, nextRelease: {version: '1.0.0'}}
  );

  t.falsy(result);
  t.is((await readJson('./package.json')).version, '1.0.0');
  t.true(await pathExists(`./tarball/${pkg.name}-1.0.0.tgz`));
  await t.throws(execa('npm', ['view', pkg.name, 'version']));
});

test.serial('Create the package and skip publish from a sub-directory', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'skip-publish-sub-dir', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./dist/package.json', pkg);

  const result = await t.context.m.publish(
    {npmPublish: false, tarballDir: './tarball', pkgRoot: './dist'},
    {logger: t.context.logger, nextRelease: {version: '1.0.0'}}
  );

  t.falsy(result);
  t.is((await readJson('./dist/package.json')).version, '1.0.0');
  t.true(await pathExists(`./tarball/${pkg.name}-1.0.0.tgz`));
  await t.throws(execa('npm', ['view', pkg.name, 'version']));
});

test.serial('Throw SemanticReleaseError Array if config option are not valid in publish', async t => {
  const pkg = {publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  const npmPublish = 42;
  const tarballDir = 42;
  const pkgRoot = 42;

  const errors = [
    ...(await t.throws(
      t.context.m.publish(
        {npmPublish, tarballDir, pkgRoot},
        {
          options: {publish: ['@semantic-release/github', '@semantic-release/npm']},
          nextRelease: {version: '1.0.0'},
          logger: t.context.logger,
        }
      )
    )),
  ];

  t.is(errors[0].name, 'SemanticReleaseError');
  t.is(errors[0].code, 'EINVALIDNPMPUBLISH');
  t.is(errors[1].name, 'SemanticReleaseError');
  t.is(errors[1].code, 'EINVALIDTARBALLDIR');
  t.is(errors[2].name, 'SemanticReleaseError');
  t.is(errors[2].code, 'EINVALIDPKGROOT');
  t.is(errors[3].name, 'SemanticReleaseError');
  t.is(errors[3].code, 'ENOPKGNAME');
});

test.serial('Prepare the package', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'prepare', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);

  await t.context.m.prepare({}, {logger: t.context.logger, nextRelease: {version: '1.0.0'}});

  t.is((await readJson('./package.json')).version, '1.0.0');
  t.false(await pathExists(`./${pkg.name}-1.0.0.tgz`));
});

test.serial('Prepare the package from a sub-directory', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'prepare-sub-dir', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./dist/package.json', pkg);

  await t.context.m.prepare({pkgRoot: 'dist'}, {logger: t.context.logger, nextRelease: {version: '1.0.0'}});

  t.is((await readJson('./dist/package.json')).version, '1.0.0');
  t.false(await pathExists(`./${pkg.name}-1.0.0.tgz`));
});

test.serial('Create the package in prepare step', async t => {
  const pkg = {name: 'prepare-pkg', version: '0.0.0', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);

  await t.context.m.prepare(
    {npmPublish: false, tarballDir: 'tarball'},
    {logger: t.context.logger, nextRelease: {version: '1.0.0'}}
  );

  t.is((await readJson('./package.json')).version, '1.0.0');
  t.true(await pathExists(`./tarball/${pkg.name}-1.0.0.tgz`));
});

test.serial('Throw SemanticReleaseError Array if config option are not valid in prepare', async t => {
  const pkg = {publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);
  const npmPublish = 42;
  const tarballDir = 42;
  const pkgRoot = 42;

  const errors = [
    ...(await t.throws(
      t.context.m.prepare(
        {npmPublish, tarballDir, pkgRoot},
        {
          options: {publish: ['@semantic-release/github', '@semantic-release/npm']},
          nextRelease: {version: '1.0.0'},
          logger: t.context.logger,
        }
      )
    )),
  ];

  t.is(errors[0].name, 'SemanticReleaseError');
  t.is(errors[0].code, 'EINVALIDNPMPUBLISH');
  t.is(errors[1].name, 'SemanticReleaseError');
  t.is(errors[1].code, 'EINVALIDTARBALLDIR');
  t.is(errors[2].name, 'SemanticReleaseError');
  t.is(errors[2].code, 'EINVALIDPKGROOT');
  t.is(errors[3].name, 'SemanticReleaseError');
  t.is(errors[3].code, 'ENOPKGNAME');
});

test.serial('Verify token and set up auth only on the fist call, then prepare on prepare call only', async t => {
  Object.assign(process.env, npmRegistry.authEnv);
  const pkg = {name: 'test-module', version: '0.0.0-dev', publishConfig: {registry: npmRegistry.url}};
  await outputJson('./package.json', pkg);

  await t.notThrows(t.context.m.verifyConditions({}, {options: {}, logger: t.context.logger}));
  await t.context.m.prepare({}, {logger: t.context.logger, nextRelease: {version: '1.0.0'}});

  const result = await t.context.m.publish({}, {logger: t.context.logger, nextRelease: {version: '1.0.0'}});
  t.deepEqual(result, {name: 'npm package (@latest dist-tag)', url: undefined});
});
