# TopWatch

**Site:** [victorhugoantonio1.github.io/topwatch](https://victorhugoantonio1.github.io/topwatch/) · [Plugins](https://victorhugoantonio1.github.io/topwatch/plugins/)

Uma barrinha discreta no topo da tela que mostra os **alertas do Zabbix**. Passou o mouse, ela abre. Tem alerta grave, a luz muda de cor e a barra diz qual é o host, sem você precisar abrir aba nenhuma.

![TopWatch aberto, com um alerta de Desastre em destaque, alertas de dois servidores Zabbix e o Vigia de olho](docs/preview.png)

Feito pra quem não quer ficar com uma aba do Zabbix aberta o dia inteiro. Outras integrações, como sistemas de chamados, entram por [plugins](#plugins).

## O que ela faz

- **Luz do TopWatch**: verde quando está tudo calmo, amarela/laranja/vermelha conforme a severidade do pior alerta aberto. Em Alta ou Desastre, um feixe gira em volta da luz.
- **Pílula inteligente**: recolhida, mostra a contagem (`3 alertas`) ou, se tiver algo grave, direto o que é (`Desastre · srv-app02`).
- **Card de destaque**: ao abrir, o alerta mais grave vem em cima com **Reconhecer** (ack no Zabbix) e **Abrir**. O resto fica numa lista compacta.
- **Vários Zabbix ao mesmo tempo**: cadastre quantos servidores quiser, de versões diferentes. Os alertas aparecem juntos, cada um com a etiqueta do servidor de onde veio, e o **Reconhecer** vai pro servidor certo. Se um cair, os outros continuam aparecendo.
- **Notificação do Windows** para problemas novos de severidade Alta ou Desastre.
- **Vigia**: um robozinho que segue o mouse, olha pra linha sob o cursor, leva susto com alerta novo, fica vermelho no Desastre, acena quando você reconhece e desliga quando está tudo calmo. Clique nele pra cutucar (três vezes rápido e ele dá glitch). Dá pra desligar nas configurações.

  ![O Vigia reagindo: olha a lista, glitch ao ser cutucado, alarme com um Desastre, aceno ao reconhecer e desliga quando fica tudo calmo](docs/vigia.gif)

- **Plugins**: cada integração instalada ganha a própria aba na barra e a própria seção nas configurações.
- **Modo demo** com dados de exemplo, pra ver funcionando sem configurar nada.
- **Vigia na bandeja**: o ícone perto do relógio é o Vigia em miniatura. O olho tem a cor do pior alerta, pisca de vez em quando e pulsa em Alta ou Desastre.
- `Ctrl` + `Alt` + `F` fixa a barra aberta; o ícone na bandeja esconde/mostra.

## Instalar

Baixe o instalador `.exe` em [Releases](../../releases). Como o instalador não é assinado digitalmente, o SmartScreen vai mostrar "Editor desconhecido": clique em **Mais informações → Executar assim mesmo**. O instalador é gerado pelo GitHub Actions a partir deste código (veja `.github/workflows/release.yml`).

Ou rode do código:

```bash
git clone https://github.com/victorhugoantonio1/topwatch.git
cd topwatch
npm install
npm start          # ou: npm run demo
```

Pra gerar o instalador localmente: `npm run dist` (sai em `dist/`).

## Configurar

Clique com o botão direito no ícone da bandeja → **Configurações…**

**Zabbix** (5.4 em diante; testado no 6.0 e no 7.0)

1. Em cada Zabbix: *Usuários → Tokens de API → Criar token*.
2. Use um usuário dedicado. Leitura basta pra ver os alertas; o botão **Reconhecer** precisa de permissão de escrita nos hosts.
3. Em **+ Adicionar servidor Zabbix**, dê um nome (ex.: `Zabbix 6`), cole a URL do frontend (ex.: `https://zabbix.empresa.local`) e o token. Repita pra cada servidor.

A versão é detectada sozinha: até o 6.2 o token vai no corpo da requisição, do 6.4 em diante vai no cabeçalho `Authorization`. Se um proxy atrapalhar a detecção, force o modo no campo **Autenticação** daquele servidor. A severidade mínima vale pra todos.

Quem já usava um Zabbix só não precisa refazer nada: a configuração antiga vira o primeiro servidor da lista.

Servidor interno com certificado autoassinado? Marque "aceitar certificado autoassinado" naquele servidor. Use **Testar conexão** antes de salvar.

## Plugins

Plugins adicionam integrações com outros sistemas. Cada plugin ganha uma aba na barra e uma seção nas configurações.

**Instalar:** em Configurações → Plugins → **Instalar plugin…**, escolha a pasta do plugin (a que tem o `index.js`). Ele é copiado pra pasta de plugins do app e já aparece, sem reiniciar. **Abrir pasta de plugins** mostra onde eles ficam.

**Criar um plugin:** é uma pasta com um `index.js` que declara nome, aba e campos de configuração, e devolve os itens a mostrar. O formato completo está comentado no topo de [`src/plugins.js`](src/plugins.js). Pra desenvolver sem instalar, aponte a variável `TOPWATCH_PLUGINS` pra pasta onde estão os seus plugins.

## Segurança

- Tokens ficam criptografados com o `safeStorage` do Electron (DPAPI do Windows) e nunca voltam em texto puro pra tela.
- A interface roda isolada (`contextIsolation`, `sandbox`, sem Node), com CSP, e todo texto vindo das APIs entra como texto, nunca como HTML.
- Os botões só abrem links `http`/`https` que vieram dos próprios dados do Zabbix ou dos plugins.
- O app só conversa com os servidores que você configurar. Sem telemetria.
- Plugins rodam no processo principal, com acesso ao computador. Instale só plugins de quem você confia.

## Como funciona

- **Ilha**: uma janela transparente, sem borda e sempre no topo que **deixa o mouse passar** (`setIgnoreMouseEvents` com `forward`). Quando o cursor entra na pílula, ela passa a aceitar cliques e expande; ao sair, volta a ser "fantasma".
- **Coleta**: o processo principal consulta as APIs a cada N segundos (sem CORS, com suporte a certificado autoassinado) e manda o estado pra interface via IPC.
- **Zabbix**: `apiinfo.version` pra descobrir como autenticar, `problem.get` + `trigger.get` (pra pegar os hosts) em todos os servidores em paralelo, e `event.acknowledge` no botão Reconhecer.
- **Carga**: por padrão, uma rodada a cada 60 s (mínimo 30 s). Em cada rodada vai **um `problem.get` por servidor** (até 50 problemas, só campos básicos). O `trigger.get` só sai quando aparece um trigger que o app ainda não conhece, porque os hosts ficam em cache. É mais leve que deixar um dashboard do Zabbix aberto.
- **Plugins**: carregados da pasta `plugins` dos dados do app. Cada um é consultado em paralelo com o Zabbix; plugin com erro mostra o erro na aba dele e não derruba o resto.

```
main.js            processo principal: janelas, bandeja, coleta, IPC
preload.js         ponte mínima entre interface e processo principal
src/zabbix.js      cliente JSON-RPC do Zabbix (vários servidores, 5.4 a 7.x)
src/plugins.js     carregador de plugins (formato descrito no topo do arquivo)
src/config.js      configurações + tokens criptografados
src/demo.js        dados de exemplo
renderer/          interface da ilha, o Vigia (bot.js) e a tela de configurações
test/              testes do cliente Zabbix, das configurações e dos plugins
lab/zabbix/        Zabbix local no Docker + script que simula problemas pela API
scripts/           gerador dos ícones da bandeja e montagem do site
site/              site do TopWatch (GitHub Pages); a demonstração usa a barra de verdade, de renderer/
```

Testes: `npm test`.

Quer testar contra um Zabbix de verdade sem mexer em produção? O [laboratório](lab/zabbix/README.md) sobe um Zabbix 7.0 no Docker e simula problemas pela API.

## Limitações conhecidas

- Feito e pensado para **Windows**. No Linux a janela não consegue deixar o mouse passar, então o retângulo da ilha fica clicável mesmo recolhido.
- Jogos em tela cheia exclusiva ficam por cima da barra (o que é bom). Em tela cheia "sem bordas", esconda pela bandeja ou pelo atalho.

## Licença

Desde 13/10/2026, o TopWatch é distribuído sob a [GNU AGPL-3.0](LICENSE). Você pode usar, estudar, modificar e redistribuir. Se distribuir uma versão modificada, ou oferecê-la pela rede, o código dela também tem que ser aberto sob a mesma licença.

As versões publicadas até o commit `af03e0c` continuam sob a licença MIT, como foram publicadas.

Copyright (c) 2026 Victor Hugo Antonio. Para licença comercial (uso sem as obrigações da AGPL) ou suporte, fale comigo pelo [LinkedIn](https://www.linkedin.com/in/vituhzzz/).
