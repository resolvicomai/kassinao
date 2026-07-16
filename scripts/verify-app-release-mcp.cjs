#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

function reject(message) {
  throw new Error(`app release MCP gate rejected: ${message}`);
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
  });
  if (result.error) reject(`git ${args[0]} could not start`);
  return result;
}

function gitOutput(args, options) {
  const result = git(args, options);
  if (result.status !== 0) reject(`git ${args[0]} failed`);
  const output = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(output)) reject(`git ${args[0]} returned an invalid commit`);
  return output;
}

function verifyAppReleaseMcp(options) {
  const { mcpRef, releaseCommit, cwd = process.cwd(), env = process.env } = options;
  if (!/^refs\/tags\/mcp-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(mcpRef)) {
    reject('MCP tag is not canonical');
  }
  if (!/^[0-9a-f]{40}$/.test(releaseCommit)) reject('app release commit is invalid');

  const tagObject = gitOutput(['rev-parse', mcpRef], { cwd, env });
  const tagType = git(['cat-file', '-t', tagObject], { cwd, env });
  if (tagType.status !== 0 || tagType.stdout.trim() !== 'tag') reject(`${mcpRef} is not an annotated tag`);

  const mcpCommit = gitOutput(['rev-parse', `${mcpRef}^{commit}`], { cwd, env });
  const ancestry = git(['merge-base', '--is-ancestor', mcpCommit, releaseCommit], { cwd, env });
  if (ancestry.status !== 0) reject(`${mcpRef} is not an ancestor of the app release`);

  const unchanged = git(['diff', '--quiet', mcpCommit, releaseCommit, '--', 'mcp'], { cwd, env });
  if (unchanged.status === 1) reject(`mcp/ changed after ${mcpRef}`);
  if (unchanged.status !== 0) reject('git diff failed');

  return mcpCommit;
}

function main(args) {
  if (args.length !== 2) {
    throw new Error('usage: verify-app-release-mcp.cjs MCP_REF APP_RELEASE_COMMIT');
  }
  process.stdout.write(`${verifyAppReleaseMcp({ mcpRef: args[0], releaseCommit: args[1] })}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { verifyAppReleaseMcp };
