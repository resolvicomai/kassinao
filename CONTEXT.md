# Memória das reuniões

O Kassinão preserva gravações do Discord e conecta o conteúdo autorizado das reuniões ao acompanhamento do trabalho.

## Language

**Gravação**: captura de áudio e presença em um canal do Discord, com início e fim registrados.

**Ata**: interpretação produzida por IA a partir da transcrição. Não comprova por si só que uma tarefa foi assumida ou executada.

**Fonte da fala**: trecho literal localizado na transcrição, com os limites de tempo originais. Confirma a localização do texto, não a interpretação sobre ele nem a identidade humana de quem falou.

**Combinado**: item extraído de uma ata, com estado explícito de mencionado, confirmado, concluído ou cancelado. Registrar a conta que alterou o estado permite distinguir extração da IA de confirmação humana.
_Avoid_: tarefa pendente sem estado, entrega inferida

**Fonte do trabalho**: issue, pull request ou documento vinculado explicitamente ao combinado. Seu acesso é verificado separadamente do acesso à reunião.

**Informativo**: aviso solicitado pela pessoa que acompanha um combinado, gerado quando há mudança relevante. Confirmação de envio não implica leitura humana.

**Evento agendado**: evento do Discord com horário e canal, usado para preparar uma reunião futura. Presença no canal não comprova a existência de um evento futuro.

**Implantação**: disponibilização de uma alteração em um ambiente. Merge e estado Done não a comprovam; os adapters atuais não consultam implantação.
_Avoid_: merge como deploy
