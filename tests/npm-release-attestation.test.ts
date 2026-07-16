import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { verifyRelease } = require('../scripts/verify-npm-release-attestation.cjs') as {
  verifyRelease: (options: Record<string, unknown>) => void;
};

const packageName = 'kassinao-mcp';
const version = '1.0.10';
const repository = 'https://github.com/resolvicomai/kassinao';
const workflowPath = '.github/workflows/publish-mcp.yml';
const tag = 'refs/tags/mcp-v1.0.10';
const commit = 'a'.repeat(40);
const digest = Buffer.alloc(64, 7);
const integrity = `sha512-${digest.toString('base64')}`;

function fixture() {
  const metadata = {
    version,
    dist: {
      integrity,
      tarball: `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${packageName}@${version}`,
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
      signatures: [{ keyid: 'registry-key', sig: 'signature' }],
    },
  };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/${packageName}@${version}`, digest: { sha512: digest.toString('hex') } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: { ref: tag, repository, path: workflowPath } },
        resolvedDependencies: [{ uri: `git+${repository}@${tag}`, digest: { gitCommit: commit } }],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
    },
  };
  const attestations = {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } },
      },
    ],
  };
  return { metadata, attestations, statement };
}

function verify(overrides: Record<string, unknown> = {}) {
  const { metadata, attestations } = fixture();
  verifyRelease({ metadata, attestations, packageName, version, repository, workflowPath, tag, commit, ...overrides });
}

describe('npm release provenance gate', () => {
  it('aceita pacote assinado vinculado ao workflow, tag e commit revisados', () => {
    expect(() => verify()).not.toThrow();
  });

  it.each([
    [
      'tarball diferente',
      (value: ReturnType<typeof fixture>) => (value.metadata.dist.tarball = 'https://example.test/x.tgz'),
    ],
    [
      'provenance ausente',
      (value: ReturnType<typeof fixture>) => (value.metadata.dist.attestations.provenance.predicateType = ''),
    ],
    ['assinatura ausente', (value: ReturnType<typeof fixture>) => (value.metadata.dist.signatures = [])],
    [
      'digest diferente',
      (value: ReturnType<typeof fixture>) => (value.statement.subject[0].digest.sha512 = '0'.repeat(128)),
    ],
    [
      'tag diferente',
      (value: ReturnType<typeof fixture>) =>
        (value.statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/mcp-v9.9.9'),
    ],
    [
      'workflow diferente',
      (value: ReturnType<typeof fixture>) =>
        (value.statement.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'),
    ],
    [
      'commit diferente',
      (value: ReturnType<typeof fixture>) =>
        (value.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40)),
    ],
  ])('recusa %s', (_label, mutate) => {
    const value = fixture();
    mutate(value);
    value.attestations.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(value.statement),
    ).toString('base64');
    expect(() =>
      verifyRelease({
        metadata: value.metadata,
        attestations: value.attestations,
        packageName,
        version,
        repository,
        workflowPath,
        tag,
        commit,
      }),
    ).toThrow(/rejected/);
  });
});
