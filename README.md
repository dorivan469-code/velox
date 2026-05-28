# ⚡ VELOX — Plataforma de Monitoramento Esportivo (Corrida, Ciclismo e Caminhada)

O **Velox** é uma aplicação web mobile-first de alta performance voltada para o monitoramento de atividades físicas, projetada com funcionalidades equivalentes e otimizadas em relação ao Strava. O sistema gerencia desde perfis biométricos até rastreamento geográfico resiliente em tempo real.

---

## 🚀 Engenharia e Arquitetura do Software

Este software foi desenvolvido de forma estratégica utilizando **Inteligência Artificial Generativa** como ferramenta de co-pilotagem avançada. Atuei como arquiteto da solução e engenheiro de prompt, sendo responsável pelo design do fluxo de dados, refinamento lógico e tratamento de falhas em ambiente de execução.

### 🔬 Diferenciais Técnicos Implementados:
* **Persistência Local e Resiliência Offline (IndexedDB):** Utilização de transações assíncronas no banco de dados nativo do navegador para armazenar rotas e treinos. Se o usuário perder o sinal de internet no meio de um treino, o aplicativo continua operando e salvando os dados localmente sem perda de informações.
* **Mapeamento Cromático Dinâmico (Leaflet.js):** Renderização de mapas com algoritmo que calcula o ritmo (pace) ou a frequência cardíaca do atleta em tempo real, alterando a cor do trajeto (gradiente entre azul, verde neon e vermelho) baseado no esporte selecionado.
* **Integração com Sensores Cardíacos (BLE Ready):** Estrutura global preparada para comunicação via Bluetooth Low Energy (BLE) para pareamento com cintas e relógios inteligentes de monitoramento cardíaco.
* **Compartilhamento Social NATIVO (html2canvas):** Engine que captura o DOM do mapa e dos dados para gerar um card visual customizado, permitindo que o usuário exporte e compartilhe suas conquistas diretamente no Instagram ou outras redes.
* **Gerenciamento de Energia (WakeLock API):** Bloqueio nativo do descanso de tela para garantir que o display do smartphone permaneça ativo durante todo o trajeto do atleta.

---

## 🧠 Solução de Problemas e Engenharia de Prompt

O desenvolvimento do Velox seguiu um fluxo moderno de depuração de bugs através de interações assistidas por IA. Durante o ciclo de desenvolvimento, logs complexos de geolocalização e sincronismo de rotas foram isolados, analisados e refatorados para garantir a estabilidade do estado global da aplicação (`ST`).

---

## 📦 Como Executar

1. Clone o repositório:
   ```bash
   git clone https://github.com
   ```
2. Abra o arquivo `index.html` em seu navegador (recomendado utilizar a extensão *Live Server* para simular o comportamento completo de PWA).
