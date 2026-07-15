#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const SLSA_PREDICATE = 'https://slsa.dev/provenance/v1';
const GITHUB_WORKFLOW_BUILD = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const GITHUB_HOSTED_BUILDER = 'https://github.com/actions/runner/github-hosted';

function fail(message) {
  throw new Error(`npm release attestation rejected: ${message}`);
}

function exactString(value, expected, label) {
  if (value !== expected) fail(`${label} does not match the reviewed release`);
}

function decodeIntegrity(integrity) {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    fail('dist.integrity is not sha512 SRI');
  }
  const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64');
  if (digest.length !== 64) fail('dist.integrity has the wrong sha512 length');
  return digest.toString('hex');
}

function decodePayload(entry) {
  const encoded = entry?.bundle?.dsseEnvelope?.payload;
  if (typeof encoded !== 'string' || encoded.length === 0) fail('SLSA DSSE payload is missing');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    fail('SLSA DSSE payload is not valid JSON');
  }
  return payload;
}

function verifyRelease(options) {
  const { metadata, attestations, packageName, version, repository, workflowPath, tag, commit } = options;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(packageName)) fail('package name is not canonical and unscoped');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) fail('version is invalid');
  if (!/^[0-9a-f]{40}$/.test(commit)) fail('reviewed commit is invalid');

  const dist = metadata?.dist;
  exactString(metadata?.version, version, 'published version');
  if (!dist || typeof dist !== 'object') fail('dist metadata is missing');
  const integrityHex = decodeIntegrity(dist.integrity);
  exactString(dist.tarball, `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`, 'tarball URL');
  exactString(
    dist.attestations?.url,
    `https://registry.npmjs.org/-/npm/v1/attestations/${packageName}@${version}`,
    'attestation URL',
  );
  exactString(dist.attestations?.provenance?.predicateType, SLSA_PREDICATE, 'metadata provenance type');
  if (!Array.isArray(dist.signatures) || dist.signatures.length === 0) fail('registry signature is missing');
  if (
    dist.signatures.some(
      (entry) =>
        typeof entry?.keyid !== 'string' ||
        entry.keyid.length === 0 ||
        typeof entry?.sig !== 'string' ||
        entry.sig.length === 0,
    )
  ) {
    fail('registry signature metadata is incomplete');
  }

  const slsaEntries = attestations?.attestations?.filter((entry) => entry?.predicateType === SLSA_PREDICATE);
  if (!Array.isArray(slsaEntries) || slsaEntries.length !== 1) fail('expected exactly one SLSA provenance attestation');
  const payload = decodePayload(slsaEntries[0]);
  exactString(payload?._type, 'https://in-toto.io/Statement/v1', 'statement type');
  exactString(payload?.predicateType, SLSA_PREDICATE, 'statement predicate type');

  if (!Array.isArray(payload.subject) || payload.subject.length !== 1) fail('statement must have one package subject');
  exactString(payload.subject[0]?.name, `pkg:npm/${packageName}@${version}`, 'package subject');
  exactString(payload.subject[0]?.digest?.sha512, integrityHex, 'package subject digest');

  const predicate = payload.predicate;
  exactString(predicate?.buildDefinition?.buildType, GITHUB_WORKFLOW_BUILD, 'build type');
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow;
  exactString(workflow?.repository, repository, 'workflow repository');
  exactString(workflow?.path, workflowPath, 'workflow path');
  exactString(workflow?.ref, tag, 'workflow tag');
  exactString(predicate?.runDetails?.builder?.id, GITHUB_HOSTED_BUILDER, 'builder identity');

  const dependencies = predicate?.buildDefinition?.resolvedDependencies;
  const expectedUri = `git+${repository}@${tag}`;
  const matching = Array.isArray(dependencies)
    ? dependencies.filter((entry) => entry?.uri === expectedUri && entry?.digest?.gitCommit === commit)
    : [];
  if (matching.length !== 1) fail('resolved Git dependency does not bind the package to the reviewed commit');
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return value;
}

function main(args) {
  if (args.length !== 8) {
    throw new Error(
      'usage: verify-npm-release-attestation.cjs METADATA ATTESTATIONS PACKAGE VERSION REPOSITORY WORKFLOW TAG COMMIT',
    );
  }
  const [metadataFile, attestationsFile, packageName, version, repository, workflowPath, tag, commit] = args;
  verifyRelease({
    metadata: readJson(metadataFile, 'npm metadata'),
    attestations: readJson(attestationsFile, 'npm attestations'),
    packageName,
    version,
    repository,
    workflowPath,
    tag,
    commit,
  });
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { verifyRelease };
