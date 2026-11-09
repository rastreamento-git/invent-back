# Inventário · API original

API original do sistema de inventário de equipamentos de rastreamento, desenvolvida com Node.js, Express e PostgreSQL. Este repositório corresponde à estrutura anterior, separada da interface `invent-front`.

A evolução atual da API do **Estoque Pro** está em [rastreamento-git/inventario-v2/invent-back](https://github.com/rastreamento-git/inventario-v2/tree/main/invent-back). A integração com o ZenControl é mantida no repositório atual.

## Desenvolvimento desta versão

```bash
npm ci --include=dev
npm start
```

O ponto de entrada é `server.js`. As configurações de conexão PostgreSQL e origem da interface devem corresponder à instalação dessa versão. Credenciais e dados reais devem permanecer fora do repositório.

## Repositórios relacionados

- [Interface original do inventário](https://github.com/rastreamento-git/invent-front)
- [Estoque Pro atual](https://github.com/rastreamento-git/inventario-v2)
- [ZenControl](https://github.com/rastreamento-git/zencontrol)

Desenvolvido por Victor Rodrigues.
