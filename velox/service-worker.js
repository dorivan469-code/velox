/**
 * ============================================================
 * TrailSync – Service Worker (service-worker.js)
 * Responsável por: cache offline, estratégia de rede e sync
 * ============================================================
 */

// ── Versão do cache (altere ao fazer deploy para forçar atualização) ──
const CACHE_VERSAO = 'trailsync-v1.0.0';
const CACHE_MAPAS  = 'trailsync-mapas-v1';

// ── Arquivos essenciais que SEMPRE devem estar no cache ──
const ARQUIVOS_ESSENCIAIS = [
  '/',
  '/static/interface.html',
  '/static/app.js',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/manifest.json',
  // Leaflet.js (mapa) – CDN espelhada localmente pelo SW
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  // Tailwind CSS via CDN
  'https://cdn.tailwindcss.com',
];

// ── Padrões de URL que são tiles de mapa (OpenStreetMap) ──
const REGEX_TILES_MAPA = /openstreetmap\.org\/\d+\/\d+\/\d+\.png/;

// =============================================================
// EVENTO: INSTALL – pré-cacheia os arquivos essenciais
// =============================================================
self.addEventListener('install', (evento) => {
  console.log('[SW] Instalando e pré-cacheando arquivos essenciais...');
  evento.waitUntil(
    caches.open(CACHE_VERSAO).then((cache) => {
      // Adiciona individualmente para não falhar tudo se um recurso CDN cair
      return Promise.allSettled(
        ARQUIVOS_ESSENCIAIS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[SW] Não foi possível cachear: ${url}`, err)
          )
        )
      );
    }).then(() => self.skipWaiting()) // Ativa imediatamente sem aguardar aba fechar
  );
});

// =============================================================
// EVENTO: ACTIVATE – limpa caches antigos de versões anteriores
// =============================================================
self.addEventListener('activate', (evento) => {
  console.log('[SW] Ativando nova versão do cache...');
  evento.waitUntil(
    caches.keys().then((nomesCaches) =>
      Promise.all(
        nomesCaches
          .filter((nome) => nome !== CACHE_VERSAO && nome !== CACHE_MAPAS)
          .map((nomeAntigo) => {
            console.log(`[SW] Removendo cache antigo: ${nomeAntigo}`);
            return caches.delete(nomeAntigo);
          })
      )
    ).then(() => self.clients.claim()) // Assume controle de todas as abas abertas
  );
});

// =============================================================
// EVENTO: FETCH – intercepta TODAS as requisições de rede
// Estratégia por tipo de recurso:
//   • Tiles de mapa   → Cache First (prioriza cache, rede como fallback)
//   • API /sincronizar → Network Only (nunca cacheamos dados POST)
//   • Demais recursos → Stale While Revalidate (retorna cache e atualiza em BG)
// =============================================================
self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);

  // ── Ignora requisições que não são HTTP/HTTPS ──
  if (!evento.request.url.startsWith('http')) return;

  // ── Estratégia 1: Tiles de mapa – Cache First ──
  if (REGEX_TILES_MAPA.test(evento.request.url)) {
    evento.respondWith(estrategiaCacheFirst(evento.request, CACHE_MAPAS));
    return;
  }

  // ── Estratégia 2: API POST – Network Only (não interceptamos) ──
  if (url.pathname.startsWith('/api/') && evento.request.method === 'POST') {
    // Deixa passar direto para a rede
    return;
  }

  // ── Estratégia 3: Demais recursos – Stale While Revalidate ──
  evento.respondWith(estrategiaStaleWhileRevalidate(evento.request));
});

// =============================================================
// FUNÇÃO: Cache First
// Retorna do cache instantaneamente; se não encontrar, busca na rede
// e armazena para a próxima vez. Ideal para tiles de mapa (imagens pesadas).
// =============================================================
async function estrategiaCacheFirst(request, nomecache = CACHE_VERSAO) {
  const cache = await caches.open(nomecache);
  const respostaCache = await cache.match(request);

  if (respostaCache) {
    return respostaCache; // ✅ Retorna do cache (sem internet)
  }

  try {
    const respostaRede = await fetch(request.clone());
    // Armazena apenas respostas válidas (status 200)
    if (respostaRede && respostaRede.status === 200) {
      cache.put(request, respostaRede.clone());
    }
    return respostaRede;
  } catch {
    // Se não tiver cache nem rede, retorna imagem transparente 1px para tiles
    return new Response('', { status: 408, statusText: 'Offline – tile não disponível' });
  }
}

// =============================================================
// FUNÇÃO: Stale While Revalidate
// Retorna do cache imediatamente E faz uma requisição em background
// para atualizar o cache. Garante app rápido E sempre atualizado.
// =============================================================
async function estrategiaStaleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSAO);
  const respostaCache = await cache.match(request);

  // Faz a requisição de rede em paralelo (não aguarda o resultado)
  const promessaRede = fetch(request.clone()).then((respostaRede) => {
    if (respostaRede && respostaRede.status === 200) {
      cache.put(request, respostaRede.clone());
    }
    return respostaRede;
  }).catch(() => null);

  // Retorna o cache imediatamente OU aguarda a rede se não há cache
  return respostaCache || promessaRede;
}

// =============================================================
// EVENTO: BACKGROUND SYNC – sincroniza dados offline quando a
// internet retornar (requer registro no frontend via SyncManager)
// =============================================================
self.addEventListener('sync', (evento) => {
  if (evento.tag === 'sync-treino') {
    console.log('[SW] Background Sync disparado: enviando dados offline...');
    evento.waitUntil(sincronizarDadosOffline());
  }
});

// =============================================================
// FUNÇÃO: Lê o IndexedDB e envia os dados pendentes ao servidor
// =============================================================
async function sincronizarDadosOffline() {
  // Notifica o cliente (aba do app) para executar a sincronização
  // A lógica real está no app.js; o SW apenas sinaliza via postMessage
  const clientes = await self.clients.matchAll({ type: 'window' });
  clientes.forEach((cliente) => {
    cliente.postMessage({ tipo: 'SYNC_SOLICITADO' });
  });
}

// =============================================================
// EVENTO: PUSH – para futuras notificações push (placeholder)
// =============================================================
self.addEventListener('push', (evento) => {
  const dados = evento.data?.json() ?? { titulo: 'TrailSync', corpo: 'Notificação de treino' };
  evento.waitUntil(
    self.registration.showNotification(dados.titulo, {
      body: dados.corpo,
      icon: '/static/icon-192.png',
      badge: '/static/icon-192.png',
      vibrate: [100, 50, 100],
    })
  );
});
