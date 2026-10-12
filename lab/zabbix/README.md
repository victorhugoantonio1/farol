# Laboratório: Zabbix local pro Farol

Um Zabbix 7.0 LTS rodando no Docker, com 6 hosts de mentira, e um script que dispara e resolve problemas **pela API**. Serve pra testar o Farol de ponta a ponta sem mexer em nenhum Zabbix de verdade.

## Pré-requisito

[Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e aberto (no Windows ele usa o WSL 2; o instalador configura).

## Passo a passo (na pasta do projeto)

```bash
npm run lab:up       # sobe Postgres + Zabbix server + frontend (a 1ª vez baixa as imagens e cria o banco)
npm run lab:setup    # espera o Zabbix subir, cria hosts/itens/triggers e um token de API
```

O `lab:setup` imprime a **URL** e o **token**. No Farol: Configurações → desmarque **Modo demo** → Zabbix **Ativo** → cole URL e token → **Testar conexão** → **Salvar**.

Frontend do Zabbix: <http://localhost:8080> (usuário `Admin`, senha `zabbix`).

## Simulando

```bash
node lab/zabbix/lab.js fire srv-app02      # derruba o srv-app02 (Desastre)
node lab/zabbix/lab.js fire all            # dispara tudo
node lab/zabbix/lab.js resolve srv-app02   # normaliza
node lab/zabbix/lab.js resolve all
npm run lab:status                         # o que está aberto agora
npm run lab:scenario                       # roteiro automático: piora aos poucos e depois melhora
```

O roteiro espera 40 s entre os passos. Pra acelerar no PowerShell: `$env:STEP_SECONDS=10; npm run lab:scenario`.

| Host | Problema | Severidade |
| --- | --- | --- |
| srv-app02 | Servidor sem resposta ao ICMP | Desastre |
| srv-db01 | Espaço em disco C: abaixo de 10% | Alta |
| fw-matriz | Link principal com perda de pacotes > 20% | Alta |
| srv-rds03 | Uso de CPU acima de 90% | Média |
| srv-print01 | Serviço "Spooler" parado | Atenção |
| web-portal | Certificado SSL expira em menos de 15 dias | Atenção |

O botão **Reconhecer** do Farol funciona de verdade aqui: o ack aparece no frontend do Zabbix.

## Como funciona

Cada host tem um item do tipo **Zabbix trapper** e uma trigger em cima dele (`last(/srv-app02/lab.icmp)=0`, por exemplo). O script manda valores com o método `history.push` da API (Zabbix 7.0+): valor ruim abre o problema, valor normal fecha. Nada de agente, `zabbix_sender` ou host real.

## Desligar

```bash
npm run lab:down                                         # para (mantém os dados)
docker compose -f lab/zabbix/docker-compose.yml down -v  # para e apaga tudo
```

O frontend só escuta em `127.0.0.1:8080`, então não fica exposto na sua rede. As senhas daqui são de laboratório; não reaproveite esse compose em produção.
