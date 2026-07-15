import { describe, expect, it } from 'vitest';
import { privacyPage } from '../src/web/privacy';

const runtime = {
  appUrl: 'https://app.example.com',
  operatorName: 'Example & Operator',
  operatorContactUrl: 'https://privacy.example.com/contact',
  privacyPolicyUrl: 'https://app.example.com/privacy',
  dataDeletionUrl: 'https://app.example.com/privacy#data-rights',
  termsOfServiceUrl: 'https://privacy.example.com/terms',
  privacyEffectiveDate: '2026-07-14',
  privacyPolicyVersion: '1.0',
  privacyAudience: 'Members and guests who join recorded voice calls in authorized servers.',
  privacyPurposes: 'Record requested calls and provide the resulting artifacts to authorized members.',
  privacyLawfulBasis: 'The operator applies the basis documented for its workplace and jurisdiction.',
  infrastructureProvider: 'Example Cloud',
  infrastructureRegion: 'south-america',
  edgeProvider: 'Cloudflare Tunnel',
  edgeRegion: 'global',
  operationalLogRetention: 'Private core logs rotate by size and host logs are deleted after thirty days.',
  rollbackRetentionHours: 72,
  backupEnabled: true,
  backupProvider: 'Example Object Storage',
  backupRegion: 'south-america',
  backupRetentionDays: 45,
  dataRequestProcess: 'The operator verifies the Discord account and meeting details before delivery.',
  dataRequestResponseDays: 30,
  incidentContactUrl: 'mailto:security@example.com',
  incidentProcess: 'Reports are triaged, affected credentials are revoked and impacted people are notified.',
  sourceUrl: 'https://github.com/example/kassinao',
  logPiiEnabled: false,
  retentionDays: 7,
  audioRetentionUnlimited: false,
  textRetentionDays: 90,
  textRetentionUnlimited: false,
  transcribeProvider: 'assemblyai' as const,
  transcribeFallbackProvider: 'groq' as const,
  transcribeSendMeetingContext: true,
  transcribePrompt: 'Internal product vocabulary',
  transcribeKeyterms: ['Project Aurora'],
  minutesEnabled: 'true' as const,
  minutesProvider: 'openrouter' as const,
  openrouterApiKey: 'must-not-leak-openrouter',
  groqApiKey: 'must-not-leak-groq',
  minutesWebhookUrl: 'https://internal-webhook.example.com/private-path',
  mcpEnabled: true,
  mcpAccessTtlMin: 15,
  mcpRefreshTtlDays: 30,
};

describe('política dinâmica da instância', () => {
  it('renderiza retenção, egress, ACL e direitos a partir da configuração ativa', () => {
    const html = privacyPage('pt', runtime);

    expect(html).toContain('Example &amp; Operator');
    expect(html).toContain('Áudio: 7 dias.');
    expect(html).toContain('Texto e metadados: 90 dias.');
    expect(html).toContain('áudio é enviado ao AssemblyAI');
    expect(html).toContain('Nomes de participantes, servidor e canal também podem ser enviados');
    expect(html).toContain('Fallback de transcrição:');
    expect(html).toContain('Vocabulário de transcrição:');
    expect(html).toContain('transcrições e contexto necessário são enviados ao OpenRouter');
    expect(html).toContain('MCP está habilitado');
    expect(html).toContain('texto e metadados autorizados saem da instância');
    expect(html).toContain('ID e link da gravação, servidor, canal, horários');
    expect(html).toContain('id="data-rights"');
    expect(html).toContain('href="https://privacy.example.com/contact" rel="noopener">Solicitar acesso ou exclusão');
    expect(html).toContain('membership atual em um servidor permitido');
    expect(html).toContain('aviso no chat do canal');
    expect(html).toContain('Vigência: 2026-07-14');
    expect(html).toContain('Versão: 1.0');
    expect(html).toContain('Público abrangido:');
    expect(html).toContain('Example Cloud');
    expect(html).toContain('Cloudflare Tunnel, região/escopo global');
    expect(html).toContain('pode processar IP do visitante, conexão TLS, rota e conteúdo HTTP');
    expect(html).toContain('Example Object Storage, região south-america, retenção declarada de 45 dias');
    expect(html).toContain('LOG_PII está desativado');
    expect(html).toContain('limita sua existência a 72 horas');
    expect(html).toContain('resposta em até 30 dias corridos');
    expect(html).toContain('Incidentes de segurança');
    expect(html).toContain('a rotina horária recalcula os prazos das reuniões concluídas');
    expect(html).toContain('Download ou transcrição em andamento podem adiar a remoção física');
    expect(html).toContain('Backups históricos podem permanecer');
    expect(html).toContain('Excluir do volume ativo não comprova remoção imediata');
    expect(html).toContain('Código-fonte desta instalação');
  });

  it('não publica credenciais nem o destino privado do webhook', () => {
    const html = privacyPage('en', runtime);

    expect(html).not.toContain(runtime.openrouterApiKey);
    expect(html).not.toContain(runtime.groqApiKey);
    expect(html).not.toContain(runtime.minutesWebhookUrl);
    expect(html).toContain('Its address is not published on this page.');
  });

  it('usa canonical bilíngue no app e descreve armazenamento em repouso sem promessa falsa', () => {
    const pt = privacyPage('pt', runtime);
    const en = privacyPage('en', runtime);

    expect(pt).toContain('<link rel="canonical" href="https://app.example.com/privacy">');
    expect(en).toContain('<link rel="canonical" href="https://app.example.com/en/privacy">');
    expect(en).toContain('Kassinão does not encrypt the active volume at the application layer');
    expect(en).toContain('responsible for configuring and proving encryption at rest');
    expect(en).not.toContain('data is encrypted at rest');
    expect(en).toContain('Policy 1.0, effective 2026-07-14');
    expect(en).toContain('the hourly job recalculates completed-meeting deadlines');
    expect(en).toContain('An active download or transcription may delay physical removal');
    expect(en).toContain('Dedicated incident contact');
  });

  it('marca configuração local incompleta como rascunho e não a apresenta como política de produção', () => {
    const html = privacyPage('pt', {
      ...runtime,
      privacyEffectiveDate: '',
      privacyPolicyVersion: 'local-draft',
      privacyAudience: '',
      privacyPurposes: '',
      privacyLawfulBasis: '',
      operationalLogRetention: '',
      dataRequestProcess: '',
      incidentProcess: '',
    });

    expect(html).toContain('Rascunho local.');
    expect(html).toContain('Não use esta configuração com dados reais');
    expect(html).toContain('Não configurada. O operador precisa defini-la antes do uso real.');
  });
});
