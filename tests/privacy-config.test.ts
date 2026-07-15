import { describe, expect, it } from 'vitest';
import {
  normalizeOperatorContactUrl,
  normalizePublicMetadataUrl,
  normalizePublicStatement,
  resolveOperatorPrivacyConfig,
  type ConfiguredOrigins,
} from '../src/config';

const origins: ConfiguredOrigins = {
  appUrl: 'https://app.example.com',
  publicUrl: 'https://www.example.com',
  docsUrl: 'https://docs.example.com',
  mcpUrl: 'https://mcp.example.com',
};

const policyContract = {
  PRIVACY_EFFECTIVE_DATE: '2026-07-14',
  PRIVACY_POLICY_VERSION: '1.0',
  PRIVACY_AUDIENCE: 'Members and guests who join recorded voice calls in authorized servers.',
  PRIVACY_PURPOSES: 'Record requested calls and provide the resulting artifacts to authorized members.',
  PRIVACY_LAWFUL_BASIS: 'The operator applies the basis documented for its workplace and jurisdiction.',
  INFRASTRUCTURE_PROVIDER: 'Example Cloud',
  INFRASTRUCTURE_REGION: 'south-america',
  EDGE_PROVIDER: 'none',
  EDGE_REGION: 'none',
  OPERATIONAL_LOG_RETENTION: 'Private core logs rotate by size and host logs are deleted after thirty days.',
  BACKUP_STATUS: 'disabled',
  BACKUP_PROVIDER: 'none',
  BACKUP_REGION: 'none',
  BACKUP_RETENTION_DAYS: '0',
  DATA_REQUEST_PROCESS: 'The operator verifies the Discord account and meeting details before delivery.',
  DATA_REQUEST_RESPONSE_DAYS: '30',
  INCIDENT_CONTACT_URL: 'mailto:security@example.com',
  INCIDENT_PROCESS:
    'Reports are triaged, affected credentials are revoked and impacted people are notified when required.',
};

describe('configuração de privacidade da instância', () => {
  it('gera somente defaults locais e dinâmicos fora de produção', () => {
    const localOrigins = {
      appUrl: 'http://localhost:8080',
      publicUrl: 'http://localhost:8080',
      docsUrl: 'http://localhost:8080',
      mcpUrl: 'http://localhost:8080',
    };

    expect(resolveOperatorPrivacyConfig({}, localOrigins, 'test')).toEqual({
      operatorName: 'Operador local do Kassinão',
      operatorContactUrl: 'http://localhost:8080/privacy#contact',
      privacyPolicyUrl: 'http://localhost:8080/privacy',
      dataDeletionUrl: 'http://localhost:8080/privacy#data-rights',
      termsOfServiceUrl: '',
      privacyEffectiveDate: '',
      privacyPolicyVersion: 'local-draft',
      privacyAudience: '',
      privacyPurposes: '',
      privacyLawfulBasis: '',
      infrastructureProvider: 'local',
      infrastructureRegion: 'local',
      edgeProvider: 'none',
      edgeRegion: 'none',
      operationalLogRetention: '',
      backupEnabled: false,
      backupProvider: 'none',
      backupRegion: 'none',
      backupRetentionDays: 0,
      dataRequestProcess: '',
      dataRequestResponseDays: 30,
      incidentContactUrl: 'http://localhost:8080/privacy#contact',
      incidentProcess: '',
    });
  });

  it('exige identidade e o contrato operacional completo em produção', () => {
    expect(() => resolveOperatorPrivacyConfig({}, origins, 'production')).toThrow(
      'OPERATOR_NAME é obrigatória em produção',
    );
  });

  it('aceita a política canônica no app e um contato HTTPS público', () => {
    expect(
      resolveOperatorPrivacyConfig(
        {
          ...policyContract,
          OPERATOR_NAME: 'Example Operator',
          OPERATOR_CONTACT_URL: 'https://privacy.example.com/contact',
          PRIVACY_POLICY_URL: 'https://app.example.com/privacy',
          DATA_DELETION_URL: 'https://app.example.com/privacy#data-rights',
          TERMS_OF_SERVICE_URL: 'https://privacy.example.com/terms',
        },
        origins,
        'production',
      ),
    ).toMatchObject({
      operatorName: 'Example Operator',
      privacyPolicyUrl: 'https://app.example.com/privacy',
      dataDeletionUrl: 'https://app.example.com/privacy#data-rights',
    });
  });

  it('aceita metadata localhost na imagem de produção somente com a exceção local explícita', () => {
    const localOrigins = {
      appUrl: 'http://localhost:8080',
      publicUrl: 'http://localhost:8080',
      docsUrl: 'http://localhost:8080',
      mcpUrl: 'http://localhost:8080',
    };
    const localMetadata = {
      ...policyContract,
      OPERATOR_NAME: 'Local Kassinão operator',
      OPERATOR_CONTACT_URL: 'http://localhost:8080/privacy#contact',
      PRIVACY_POLICY_URL: 'http://localhost:8080/privacy',
      DATA_DELETION_URL: 'http://localhost:8080/privacy#data-rights',
      INFRASTRUCTURE_PROVIDER: 'Local machine',
      INFRASTRUCTURE_REGION: 'Local device',
      INCIDENT_CONTACT_URL: 'http://localhost:8080/privacy#contact',
    };

    expect(resolveOperatorPrivacyConfig(localMetadata, localOrigins, 'production', true)).toMatchObject({
      operatorContactUrl: 'http://localhost:8080/privacy#contact',
      privacyPolicyUrl: 'http://localhost:8080/privacy',
      dataDeletionUrl: 'http://localhost:8080/privacy#data-rights',
    });
    expect(() => resolveOperatorPrivacyConfig(localMetadata, localOrigins, 'production', false)).toThrow(/HTTPS/);
  });

  it('não amplia a exceção local para app público, IP privado ou hostname interno', () => {
    const localMetadata = {
      OPERATOR_NAME: 'Local operator',
      OPERATOR_CONTACT_URL: 'http://localhost:8080/privacy#contact',
      PRIVACY_POLICY_URL: 'http://localhost:8080/privacy',
      DATA_DELETION_URL: 'http://localhost:8080/privacy#data-rights',
    };
    expect(() => resolveOperatorPrivacyConfig(localMetadata, origins, 'production', true)).toThrow(/HTTPS|exatamente/);

    for (const appUrl of ['http://10.0.0.2:8080', 'http://operator.internal:8080']) {
      const privateOrigins = { ...origins, appUrl };
      const privateMetadata = {
        ...localMetadata,
        OPERATOR_CONTACT_URL: `${appUrl}/contact`,
        PRIVACY_POLICY_URL: `${appUrl}/privacy`,
        DATA_DELETION_URL: `${appUrl}/privacy#data-rights`,
      };
      expect(() => resolveOperatorPrivacyConfig(privateMetadata, privateOrigins, 'production', true)).toThrow(/HTTPS/);
    }
  });

  it('recusa política externa ou exclusão divergente para não criar duas verdades', () => {
    const base = {
      ...policyContract,
      OPERATOR_NAME: 'Example Operator',
      OPERATOR_CONTACT_URL: 'https://privacy.example.com/contact',
      PRIVACY_POLICY_URL: 'https://app.example.com/privacy',
      DATA_DELETION_URL: 'https://app.example.com/privacy#data-rights',
    };
    expect(() =>
      resolveOperatorPrivacyConfig(
        { ...base, PRIVACY_POLICY_URL: 'https://privacy.example.com/policy' },
        origins,
        'production',
      ),
    ).toThrow('PRIVACY_POLICY_URL precisa ser exatamente APP_URL + /privacy');
    expect(() =>
      resolveOperatorPrivacyConfig(
        { ...base, DATA_DELETION_URL: 'https://privacy.example.com/delete' },
        origins,
        'production',
      ),
    ).toThrow('DATA_DELETION_URL precisa ser exatamente APP_URL + /privacy#data-rights');
  });

  it('recusa credenciais, query, fragmento indevido e hosts não públicos', () => {
    for (const [name, value] of [
      ['PRIVACY_POLICY_URL', 'https://user:secret@example.com/privacy'],
      ['PRIVACY_POLICY_URL', 'https://example.com/privacy?instance=x'],
      ['OPERATOR_CONTACT_URL', 'https://example.com/contact#team'],
      ['PRIVACY_POLICY_URL', 'https://localhost/privacy'],
      ['PRIVACY_POLICY_URL', 'https://10.0.0.2/privacy'],
    ] as const) {
      expect(() => normalizePublicMetadataUrl(name, value, { production: true, requirePath: true })).toThrow();
    }
    expect(
      normalizePublicMetadataUrl('DATA_DELETION_URL', 'https://app.example.com/privacy#data-rights', {
        production: true,
        requirePath: true,
        allowHash: true,
      }),
    ).toBe('https://app.example.com/privacy#data-rights');
  });

  it('aceita um único mailto de contato sem headers e recusa destinatários ambíguos', () => {
    expect(normalizeOperatorContactUrl('mailto:privacy@example.com', true)).toBe('mailto:privacy@example.com');
    for (const value of [
      'mailto:privacy@example.com?subject=Data',
      'mailto:privacy@example.com,other@example.com',
      'mailto:not-an-address',
    ]) {
      expect(() => normalizeOperatorContactUrl(value, true)).toThrow('um único e-mail');
    }
  });

  it('recusa metadados públicos que exponham coordenadas privadas ou IDs', () => {
    for (const value of [
      'Hosted at http://10.0.0.2',
      'Internal node recorder.internal',
      'Internal node voice.corp',
      'Guild 123456789012345678',
      'Instance 7fdcb85f-6fd0-4692-bacd-e06572643a65',
      'Contact privacy@example.com',
    ]) {
      expect(() => normalizePublicStatement('PUBLIC_FIELD', value)).toThrow(/não pode expor/);
    }
  });

  it('valida data, pares de edge, backup e janela de resposta', () => {
    const base = {
      ...policyContract,
      OPERATOR_NAME: 'Example Operator',
      OPERATOR_CONTACT_URL: 'https://privacy.example.com/contact',
      PRIVACY_POLICY_URL: 'https://app.example.com/privacy',
      DATA_DELETION_URL: 'https://app.example.com/privacy#data-rights',
    };
    expect(() =>
      resolveOperatorPrivacyConfig({ ...base, PRIVACY_EFFECTIVE_DATE: '2026-02-30' }, origins, 'production'),
    ).toThrow('PRIVACY_EFFECTIVE_DATE');
    expect(() =>
      resolveOperatorPrivacyConfig({ ...base, PRIVACY_EFFECTIVE_DATE: '2999-01-01' }, origins, 'production'),
    ).toThrow('PRIVACY_EFFECTIVE_DATE');
    expect(() =>
      resolveOperatorPrivacyConfig({ ...base, PRIVACY_POLICY_VERSION: 'local-draft' }, origins, 'production'),
    ).toThrow('PRIVACY_POLICY_VERSION');
    expect(() =>
      resolveOperatorPrivacyConfig(
        { ...base, EDGE_PROVIDER: 'Cloudflare', EDGE_REGION: 'none' },
        origins,
        'production',
      ),
    ).toThrow('EDGE_PROVIDER e EDGE_REGION');
    expect(() => resolveOperatorPrivacyConfig({ ...base, BACKUP_STATUS: 'enabled' }, origins, 'production')).toThrow(
      'BACKUP_PROVIDER',
    );
    expect(() =>
      resolveOperatorPrivacyConfig({ ...base, DATA_REQUEST_RESPONSE_DAYS: '0' }, origins, 'production'),
    ).toThrow('DATA_REQUEST_RESPONSE_DAYS');
  });

  it('publica provider, região e retenção quando backup está habilitado', () => {
    const result = resolveOperatorPrivacyConfig(
      {
        ...policyContract,
        OPERATOR_NAME: 'Example Operator',
        OPERATOR_CONTACT_URL: 'https://privacy.example.com/contact',
        PRIVACY_POLICY_URL: 'https://app.example.com/privacy',
        DATA_DELETION_URL: 'https://app.example.com/privacy#data-rights',
        BACKUP_STATUS: 'enabled',
        BACKUP_PROVIDER: 'Example Object Storage',
        BACKUP_REGION: 'south-america',
        BACKUP_RETENTION_DAYS: '45',
      },
      origins,
      'production',
    );
    expect(result).toMatchObject({
      backupEnabled: true,
      backupProvider: 'Example Object Storage',
      backupRegion: 'south-america',
      backupRetentionDays: 45,
    });
  });
});
