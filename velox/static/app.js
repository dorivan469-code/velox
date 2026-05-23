/**
 * VELOX – app.js v3.0
 * Reescrito do zero para garantir funcionamento correto
 */
'use strict';

// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────
const ST = {
  ativo:        false,
  pausado:      false,
  tipo:         'corrida',
  idTreino:     null,
  inicioMs:     0,
  pausaMs:      0,
  pausaInicio:  0,
  distM:        0,
  pontosRota:   [],
  ultimoPonto:  null,
  timerInterval:null,
  watchId:      null,
  gpsOk:        false,
  dispositivoBLE:    null,
  caracteristicaBPM: null,
  bpmAtual:     0,
  bpmHistorico: [],
  online:       navigator.onLine,
  wakeLock:     null,
  cfg: {
    nome:        'Atleta',
    idade:       30,
    peso:        70,
    altaPrecisao: true,
    wakelock:     true,
    audioJarvis:  true,
  },
};

const fcMax = () => Math.round(208 - (0.7 * ST.cfg.idade));

// ─────────────────────────────────────────────
// IndexedDB
// ─────────────────────────────────────────────
let DB = null;

async function abrirDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('VeloxDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('fila')) {
        db.createObjectStore('fila', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('treinos')) {
        db.createObjectStore('treinos', { keyPath: 'idTreino' });
      }
    };
    req.onsuccess  = (e) => { DB = e.target.result; res(DB); };
    req.onerror    = (e) => rej(e.target.error);
  });
}

async function filaAdd(ponto) {
  if (!DB) return;
  const tx = DB.transaction('fila', 'readwrite');
  tx.objectStore('fila').add({ ...ponto, sincronizado: false });
}

async function filaTodos() {
  if (!DB) return [];
  return new Promise((res) => {
    const req = DB.transaction('fila', 'readonly').objectStore('fila').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => res([]);
  });
}

async function treinoSalvar(t) {
  if (!DB) return;
  const tx = DB.transaction('treinos', 'readwrite');
  tx.objectStore('treinos').put(t);
}

async function treinosTodos() {
  if (!DB) return [];
  return new Promise((res) => {
    const req = DB.transaction('treinos', 'readonly').objectStore('treinos').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => res([]);
  });
}

// ─────────────────────────────────────────────
// MAPA LEAFLET
// ─────────────────────────────────────────────
let mapa = null, marcador = null, polilinha = null;

function initMapa() {
  mapa = L.map('mapa', { zoomControl: false, attributionControl: true })
           .setView([-14.235, -51.925], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(mapa);

  navigator.geolocation?.getCurrentPosition(
    pos => {
      mapa.setView([pos.coords.latitude, pos.coords.longitude], 16);
      moverMarcador(pos.coords.latitude, pos.coords.longitude);
    },
    null,
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

function moverMarcador(lat, lng) {
  const cor  = ST.ativo && !ST.pausado ? '#39ff14' : '#4da6ff';
  const html = `<div style="width:18px;height:18px;border-radius:50%;background:${cor};border:3px solid #fff;box-shadow:0 0 14px ${cor};"></div>`;
  const icon = L.divIcon({ className: '', html, iconSize: [18,18], iconAnchor: [9,9] });
  if (marcador) { marcador.setLatLng([lat, lng]); marcador.setIcon(icon); }
  else           { marcador = L.marker([lat, lng], { icon }).addTo(mapa); }
}

function atualizarRota() {
  if (ST.pontosRota.length < 2) return;
  const coords = ST.pontosRota.map(p => [p.lat, p.lng]);
  if (polilinha) polilinha.setLatLngs(coords);
  else polilinha = L.polyline(coords, { color:'#39ff14', weight:4, opacity:0.9 }).addTo(mapa);
}

// ─────────────────────────────────────────────
// GPS
// ─────────────────────────────────────────────
function iniciarGPS() {
  if (!navigator.geolocation) { toast('⚠️ GPS não disponível'); return; }
  const opts = { enableHighAccuracy: ST.cfg.altaPrecisao, maximumAge: 0, timeout: 20000 };
  ST.watchId = navigator.geolocation.watchPosition(onPosicao, onErroGPS, opts);
  atualizarBadge('gps', '', 'buscando...');
}

function pararGPS() {
  if (ST.watchId !== null) { navigator.geolocation.clearWatch(ST.watchId); ST.watchId = null; }
  atualizarBadge('gps', '', 'GPS');
}

async function onPosicao(pos) {
  const { latitude: lat, longitude: lng, speed, accuracy } = pos.coords;
  const ts = pos.timestamp;

  if (!ST.gpsOk) {
    ST.gpsOk = true;
    atualizarBadge('gps', 'on', `${Math.round(accuracy)}m`);
  }

  moverMarcador(lat, lng);
  if (ST.ativo && !ST.pausado) mapa.panTo([lat, lng], { animate: true, duration: 0.5 });
  if (!ST.ativo || ST.pausado) return;

  // Filtra precisão ruim
  if (accuracy > 40) return;

  // Distância
  if (ST.ultimoPonto) {
    const d  = haversine(ST.ultimoPonto.lat, ST.ultimoPonto.lng, lat, lng);
    const dt = (ts - ST.ultimoPonto.ts) / 1000;
    if (dt > 0 && (d / dt) < 25) ST.distM += d;
  }

  const velKmh = speed != null ? speed * 3.6 : 0;
  const ponto  = { idTreino: ST.idTreino, lat, lng, timestamp: ts,
                   bpm: ST.bpmAtual, velocidade: velKmh, precisao: accuracy };

  ST.pontosRota.push(ponto);
  ST.ultimoPonto = { lat, lng, ts };

  atualizarRota();
  renderMetricas();

  // Persiste
  if (ST.online) {
    enviarPonto(ponto).catch(() => filaAdd(ponto));
  } else {
    await filaAdd(ponto);
    atualizarPendentes();
  }
}

function onErroGPS(err) {
  const msgs = { 1:'Permissão GPS negada. Ative nas configurações.', 2:'Sinal GPS indisponível.', 3:'GPS: tempo esgotado.' };
  toast(`📡 ${msgs[err.code] || 'Erro GPS'}`);
  atualizarBadge('gps', 'off', 'sem GPS');
}

// ─────────────────────────────────────────────
// BLUETOOTH BLE
// ─────────────────────────────────────────────
async function conectarBLE() {
  if (!navigator.bluetooth) { toast('❌ Bluetooth não disponível neste browser'); return; }
  try {
    toast('🔍 Buscando sensor cardíaco...');
    ST.dispositivoBLE = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }, { namePrefix: 'Polar' }, { namePrefix: 'Garmin' }],
      optionalServices: ['heart_rate'],
    });
    const srv = await ST.dispositivoBLE.gatt.connect();
    const svc = await srv.getPrimaryService('heart_rate');
    ST.caracteristicaBPM = await svc.getCharacteristic('heart_rate_measurement');
    await ST.caracteristicaBPM.startNotifications();
    ST.caracteristicaBPM.addEventListener('characteristicvaluechanged', onBPM);
    ST.dispositivoBLE.addEventListener('gattserverdisconnected', () => {
      toast('⚠️ Sensor desconectado');
      ST.bpmAtual = 0;
      atualizarBadge('ble', '', 'BLE');
    });
    atualizarBadge('ble', 'ble', ST.dispositivoBLE.name?.split(' ')[0] || 'BLE ✓');
    toast(`💓 Sensor: ${ST.dispositivoBLE.name}`);
  } catch (e) {
    if (e.name !== 'NotFoundError') toast('⚠️ Falha ao conectar sensor');
  }
}

function onBPM(evt) {
  const d    = evt.target.value;
  const flag = d.getUint8(0);
  ST.bpmAtual = (flag & 0x01) ? d.getUint16(1, true) : d.getUint8(1);
  if (ST.ativo && !ST.pausado) ST.bpmHistorico.push(ST.bpmAtual);
  const el = document.getElementById('v-bpm');
  if (el) el.textContent = ST.bpmAtual;
}

// ─────────────────────────────────────────────
// WAKE LOCK
// ─────────────────────────────────────────────
async function ativarWakeLock() {
  if (!ST.cfg.wakelock || !('wakeLock' in navigator)) return;
  try { ST.wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
async function liberarWakeLock() {
  if (ST.wakeLock) { await ST.wakeLock.release(); ST.wakeLock = null; }
}

// ─────────────────────────────────────────────
// CONTROLE DO TREINO
// ─────────────────────────────────────────────
async function alternarTreino() {
  if (!ST.ativo) {
    await iniciarTreino();
  } else {
    pausarTreino();
  }
}

async function iniciarTreino() {
  // Pede permissão GPS antes de qualquer coisa
  if (!navigator.geolocation) {
    toast('⚠️ GPS não disponível neste dispositivo');
    return;
  }

  toast('📡 Obtendo sinal GPS...');

  try {
    await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
      });
    });
  } catch (err) {
    const msgs = {
      1: '⚠️ Permissão de GPS negada! Vá em Configurações → Privacidade → Localização e permita o acesso.',
      2: '⚠️ Sem sinal GPS. Vá para área aberta e tente novamente.',
      3: '⚠️ GPS demorou muito. Tente novamente ao ar livre.',
    };
    toast(msgs[err.code] || '⚠️ Erro ao acessar GPS');
    return;
  }

  // GPS OK — inicia o treino
  ST.idTreino     = `vx_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  ST.ativo        = true;
  ST.pausado      = false;
  ST.inicioMs     = Date.now();
  ST.pausaMs      = 0;
  ST.pausaInicio  = 0;
  ST.distM        = 0;
  ST.pontosRota   = [];
  ST.ultimoPonto  = null;
  ST.bpmHistorico = [];

  iniciarGPS();
  await ativarWakeLock();

  // Limpa rota do mapa
  if (polilinha) { mapa.removeLayer(polilinha); polilinha = null; }

  // Atualiza botão
  const btnGo = document.getElementById('btn-go');
  if (btnGo) {
    btnGo.style.background   = '#ff4757';
    btnGo.style.boxShadow    = '0 0 20px rgba(255,71,87,0.5)';
    btnGo.style.animation    = 'pulso 2s infinite';
  }
  const icone = document.getElementById('btn-icone');
  const texto = document.getElementById('btn-texto');
  if (icone) icone.textContent = '⏸';
  if (texto) texto.textContent = 'PAUSAR';

  document.getElementById('timer')?.classList.add('gravando');
  document.getElementById('mapa')?.classList.add('gravando');

  // Inicia cronômetro
  ST.timerInterval = setInterval(tickTimer, 1000);

  toast('🚀 Treino iniciado! Bom treino!');
}

function pausarTreino() {
  ST.pausado     = true;
  ST.pausaInicio = Date.now();

  const btnGo = document.getElementById('btn-go');
  if (btnGo) {
    btnGo.style.background = '#f59e0b';
    btnGo.style.boxShadow  = '0 0 20px rgba(245,158,11,0.4)';
    btnGo.style.animation  = 'none';
  }

  const dur  = formatDuracao(Math.floor(tempoAtivo() / 1000));
  const dist = (ST.distM / 1000).toFixed(2);

  const pauseEl = document.getElementById('painel-pause');
  const pauseInfo = document.getElementById('pause-info');
  if (pauseInfo) pauseInfo.textContent = `${dist} km · ${dur}`;
  if (pauseEl) pauseEl.classList.add('vis');
}

function retomarTreino() {
  ST.pausaMs    += Date.now() - ST.pausaInicio;
  ST.pausado     = false;
  ST.pausaInicio = 0;

  const btnGo = document.getElementById('btn-go');
  if (btnGo) {
    btnGo.style.background = '#ff4757';
    btnGo.style.boxShadow  = '0 0 20px rgba(255,71,87,0.5)';
    btnGo.style.animation  = 'pulso 2s infinite';
  }
  const icone = document.getElementById('btn-icone');
  const texto = document.getElementById('btn-texto');
  if (icone) icone.textContent = '⏸';
  if (texto) texto.textContent = 'PAUSAR';

  document.getElementById('painel-pause')?.classList.remove('vis');
  toast('▶️ Treino retomado!');
}

async function finalizarTreino() {
  ST.ativo   = false;
  ST.pausado = false;
  clearInterval(ST.timerInterval);
  pararGPS();
  await liberarWakeLock();

  document.getElementById('painel-pause')?.classList.remove('vis');

  // Restaura botão
  const btnGo = document.getElementById('btn-go');
  if (btnGo) {
    btnGo.style.background = '#39ff14';
    btnGo.style.boxShadow  = '0 0 20px rgba(57,255,20,0.3)';
    btnGo.style.animation  = 'none';
  }
  const icone = document.getElementById('btn-icone');
  const texto = document.getElementById('btn-texto');
  if (icone) icone.textContent = '▶';
  if (texto) texto.textContent = 'INICIAR';

  document.getElementById('timer')?.classList.remove('gravando');
  document.getElementById('mapa')?.classList.remove('gravando');

  const duracao = Math.floor(tempoAtivo() / 1000);
  const resumo  = montarResumo(duracao);

  await treinoSalvar({ ...resumo, sincronizado: false });

  // Tenta sincronizar
  try {
    const r = await fetch('/api/sincronizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'treino_completo', ...resumo }),
    });
    if (r.ok) {
      const dados = await r.json();
      resumo.analise_jarvis = dados.analise_jarvis || '';
      resumo.url_audio      = dados.url_audio || null;
      await treinoSalvar({ ...resumo, sincronizado: true });
    }
  } catch { toast('📦 Salvo offline — sincronizará depois'); }

  mostrarResumo(resumo);
}

function montarResumo(duracao) {
  const bpms = ST.bpmHistorico.filter(b => b > 30);
  return {
    idTreino:        ST.idTreino,
    tipo:            ST.tipo,
    inicio:          ST.inicioMs,
    duracaoSegundos: duracao,
    distanciaMetros: Math.round(ST.distM),
    pontos:          ST.pontosRota,
    bpmMedio:        bpms.length ? Math.round(bpms.reduce((a,b)=>a+b,0)/bpms.length) : 0,
    bpmMaximo:       bpms.length ? Math.max(...bpms) : 0,
    pace:            calcPace(),
    velocidadeMedia: calcVelMedia(),
    calorias:        estimarCalorias(ST.distM, duracao),
  };
}

function tempoAtivo() {
  if (!ST.inicioMs) return 0;
  const agora = ST.pausado ? ST.pausaInicio : Date.now();
  return agora - ST.inicioMs - ST.pausaMs;
}

// ─────────────────────────────────────────────
// CRONÔMETRO
// ─────────────────────────────────────────────
function tickTimer() {
  if (ST.pausado) return;
  const ms = tempoAtivo();
  const s  = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const el = document.getElementById('timer');
  if (el) el.textContent = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────────
// MÉTRICAS
// ─────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const dL = (lat2-lat1)*Math.PI/180;
  const dG = (lng2-lng1)*Math.PI/180;
  const a  = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcPace() {
  const km = ST.distM / 1000;
  if (km < 0.01) return '--:--';
  const spk = (tempoAtivo()/1000) / km;
  return `${pad(Math.floor(spk/60))}:${pad(Math.floor(spk%60))}`;
}

function calcVelMedia() {
  const vels = ST.pontosRota.map(p=>p.velocidade).filter(v=>v>0);
  return vels.length ? vels.reduce((a,b)=>a+b,0)/vels.length : 0;
}

function estimarCalorias(distM, durS) {
  const met = { corrida:9.8, ciclismo:7.5, caminhada:3.8 }[ST.tipo] || 7;
  return Math.round(met * ST.cfg.peso * (durS/3600));
}

function renderMetricas() {
  const vd = document.getElementById('v-dist');
  const vp = document.getElementById('v-pace');
  const vv = document.getElementById('v-vel');
  const vb = document.getElementById('v-bpm');
  if (vd) vd.textContent = (ST.distM/1000).toFixed(2);
  if (vp) vp.textContent = calcPace();
  if (vv) vv.textContent = ST.pontosRota.length > 0 ? (ST.pontosRota.at(-1)?.velocidade||0).toFixed(1) : '0.0';
  if (vb && ST.bpmAtual > 0) vb.textContent = ST.bpmAtual;
}

// ─────────────────────────────────────────────
// RESUMO PÓS-TREINO
// ─────────────────────────────────────────────
function mostrarResumo(r) {
  const modal = document.getElementById('modal-resumo');
  const body  = document.getElementById('modal-resumo-body');
  if (!modal || !body) return;

  const zCores = {1:'#4da6ff',2:'#39ff14',3:'#ffb347',4:'#ff8c42',5:'#ff4757'};

  body.innerHTML = `
    <div class="resumo-dist">
      <div class="v">${(r.distanciaMetros/1000).toFixed(2)}</div>
      <div class="u">QUILÔMETROS</div>
    </div>
    <div class="grade-resumo">
      <div class="r-item"><div class="rv">${formatDuracao(r.duracaoSegundos)}</div><div class="rl">DURAÇÃO</div></div>
      <div class="r-item"><div class="rv">${r.pace}</div><div class="rl">PACE (min/km)</div></div>
      <div class="r-item"><div class="rv" style="color:#ff6b8a">${r.bpmMedio||'--'}</div><div class="rl">FC MÉDIA</div></div>
      <div class="r-item"><div class="rv" style="color:#ff4757">${r.bpmMaximo||'--'}</div><div class="rl">FC MÁX.</div></div>
      <div class="r-item"><div class="rv" style="color:#ffb347">${r.calorias}</div><div class="rl">CALORIAS</div></div>
      <div class="r-item"><div class="rv">${(r.velocidadeMedia||0).toFixed(1)}</div><div class="rl">VEL. MÉD.</div></div>
    </div>
    <div id="mapa-mini"></div>
    ${r.analise_jarvis ? `
      <div class="jarvis">
        <div class="jarvis-lbl">🤖 J.A.R.V.I.S.</div>
        <div class="jarvis-txt">${r.analise_jarvis}</div>
      </div>` : ''}
    <button style="width:100%;margin-top:12px;padding:14px;border-radius:12px;border:none;background:#39ff14;color:#000;font-family:var(--font-d);font-size:16px;font-weight:900;letter-spacing:1px;cursor:pointer;" onclick="VX.fecharResumo()">FECHAR</button>
  `;

  modal.classList.add('aberto');

  // Mini mapa da rota
  setTimeout(() => {
    const el = document.getElementById('mapa-mini');
    if (el && r.pontos?.length > 1) {
      const m = L.map('mapa-mini', { zoomControl:false, attributionControl:false, dragging:false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(m);
      const coords = r.pontos.map(p=>[p.lat,p.lng]);
      const rota   = L.polyline(coords, { color:'#39ff14', weight:3 }).addTo(m);
      m.fitBounds(rota.getBounds(), { padding:[20,20] });
    }
  }, 200);

  if (r.url_audio && ST.cfg.audioJarvis) {
    setTimeout(() => new Audio(r.url_audio).play().catch(()=>{}), 1200);
  }
}

function fecharResumo() {
  document.getElementById('modal-resumo')?.classList.remove('aberto');
}

// ─────────────────────────────────────────────
// HISTÓRICO
// ─────────────────────────────────────────────
async function abrirHistorico() {
  const modal = document.getElementById('modal-historico');
  if (modal) modal.classList.add('aberto');

  const container = document.getElementById('lista-treinos');
  if (container) container.innerHTML = '<p style="color:#444;text-align:center;padding:40px 0;">Carregando...</p>';

  let treinos = [];
  try {
    const r = await fetch('/api/treinos?limite=30');
    if (r.ok) treinos = (await r.json()).treinos || [];
  } catch {
    treinos = (await treinosTodos()).sort((a,b)=>b.inicio-a.inicio);
  }

  if (!container) return;

  if (!treinos.length) {
    container.innerHTML = '<p style="color:#444;text-align:center;padding:60px 0;">Nenhum treino ainda.<br>Bora correr! 🏃</p>';
    return;
  }

  const icones = { corrida:'🏃', ciclismo:'🚴', caminhada:'🚶' };
  container.innerHTML = treinos.map(t => {
    const dist = ((t.distancia_metros||t.distanciaMetros||0)/1000).toFixed(2);
    const dur  = formatDuracao(t.duracao_segundos||t.duracaoSegundos||0);
    const pace = t.pace_medio||t.pace||'--:--';
    const bpm  = t.bpm_medio||t.bpmMedio||'--';
    const cal  = t.calorias||'--';
    const tipo = t.tipo||'corrida';
    const data = new Date(t.inicio).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const jarv = t.analise_jarvis||'';
    return `
      <div class="card-tr">
        <div class="card-tr-hdr">
          <div>
            <div class="card-tr-tipo">${icones[tipo]||'🏃'} ${tipo.toUpperCase()}</div>
            <div class="card-tr-data">${data}</div>
          </div>
          <div>
            <div class="card-tr-dist">${dist}<span style="font-size:14px;color:#444"> km</span></div>
            <div style="text-align:right;font-size:10px;color:#444">${dur}</div>
          </div>
        </div>
        <div class="card-tr-stats">
          <div class="st-m"><div class="v">${pace}</div><div class="u">min/km</div></div>
          <div class="st-m"><div class="v" style="color:#ff6b8a">${bpm}</div><div class="u">bpm médio</div></div>
          <div class="st-m"><div class="v" style="color:#ffb347">${cal}</div><div class="u">kcal</div></div>
        </div>
        ${jarv?`<div class="jarvis"><div class="jarvis-lbl">🤖 J.A.R.V.I.S.</div><div class="jarvis-txt">${jarv}</div></div>`:''}
      </div>`;
  }).join('');
}

function fecharHistorico() {
  document.getElementById('modal-historico')?.classList.remove('aberto');
}

// ─────────────────────────────────────────────
// CONFIGURAÇÕES / PERFIL
// ─────────────────────────────────────────────
function abrirConfig() {
  const n = document.getElementById('cfg-nome');
  const i = document.getElementById('cfg-idade');
  const p = document.getElementById('cfg-peso');
  const f = document.getElementById('cfg-fcmax');
  if (n) n.value = ST.cfg.nome;
  if (i) i.value = ST.cfg.idade;
  if (p) p.value = ST.cfg.peso;
  if (f) f.textContent = `${fcMax()} bpm`;
  document.getElementById('modal-config')?.classList.add('aberto');
}

function fecharConfig() {
  document.getElementById('modal-config')?.classList.remove('aberto');
}

function salvarConfig() {
  ST.cfg.nome        = document.getElementById('cfg-nome')?.value || 'Atleta';
  ST.cfg.idade       = parseInt(document.getElementById('cfg-idade')?.value) || 30;
  ST.cfg.peso        = parseFloat(document.getElementById('cfg-peso')?.value) || 70;
  ST.cfg.altaPrecisao = document.getElementById('cfg-precisao')?.checked ?? true;
  ST.cfg.wakelock    = document.getElementById('cfg-wakelock')?.checked ?? true;
  ST.cfg.audioJarvis = document.getElementById('cfg-audio')?.checked ?? true;
  const f = document.getElementById('cfg-fcmax');
  if (f) f.textContent = `${fcMax()} bpm`;
  localStorage.setItem('velox_cfg', JSON.stringify(ST.cfg));
  toast('✅ Configurações salvas!');
}

function carregarConfig() {
  try { Object.assign(ST.cfg, JSON.parse(localStorage.getItem('velox_cfg')||'{}')); } catch {}
}

// ─────────────────────────────────────────────
// EXPORTAR GPX
// ─────────────────────────────────────────────
function exportarGPX() {
  if (!ST.pontosRota.length) { toast('⚠️ Sem rota para exportar'); return; }
  const trkpts = ST.pontosRota.map(p => {
    const ts = new Date(p.timestamp).toISOString();
    return `    <trkpt lat="${p.lat}" lon="${p.lng}"><time>${ts}</time></trkpt>`;
  }).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VELOX">
  <trk><name>VELOX ${ST.tipo}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([gpx], { type:'application/gpx+xml' }));
  a.download = `velox_${ST.tipo}_${Date.now()}.gpx`;
  a.click();
  toast('📥 GPX exportado!');
}

// ─────────────────────────────────────────────
// SINCRONIZAÇÃO
// ─────────────────────────────────────────────
async function enviarPonto(ponto) {
  const r = await fetch('/api/sincronizar', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ modo:'ponto_unico', pontos:[ponto] }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

async function sincronizarPendentes() {
  const todos = await filaTodos();
  const pend  = todos.filter(p => !p.sincronizado);
  if (!pend.length) return;
  toast(`📡 Sincronizando ${pend.length} pontos...`);
  const LOTE = 50;
  for (let i = 0; i < pend.length; i += LOTE) {
    const lote = pend.slice(i, i+LOTE);
    try {
      const r = await fetch('/api/sincronizar', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ modo:'lote_offline', pontos:lote,
          loteAtual:Math.floor(i/LOTE)+1, totalLotes:Math.ceil(pend.length/LOTE) }),
      });
      if (r.ok) {
        const tx = DB.transaction('fila','readwrite');
        const s  = tx.objectStore('fila');
        lote.forEach(p => { const rq=s.get(p.id); rq.onsuccess=()=>{if(rq.result){rq.result.sincronizado=true;s.put(rq.result);}}; });
      }
    } catch { break; }
    await new Promise(r=>setTimeout(r,150));
  }
  atualizarPendentes();
  toast('✅ Sincronização concluída!');
}

async function sincronizarManual() {
  if (!ST.online) { toast('❌ Sem conexão'); return; }
  await sincronizarPendentes();
}

async function atualizarPendentes() {
  const todos = await filaTodos();
  const n     = todos.filter(p=>!p.sincronizado).length;
  const bar   = document.getElementById('pendentes-bar');
  const qtd   = document.getElementById('qtd-pendentes');
  if (bar) bar.classList.toggle('vis', n > 0);
  if (qtd) qtd.textContent = n;
}

// ─────────────────────────────────────────────
// REDE
// ─────────────────────────────────────────────
function atualizarRede() {
  ST.online = navigator.onLine;
  atualizarBadge('rede', ST.online?'on':'off', ST.online?'Online':'Offline');
  const avi = document.getElementById('aviso-offline');
  if (avi) avi.classList.toggle('vis', !ST.online);
  if (ST.online) sincronizarPendentes();
}

function verificarRede() { atualizarRede(); toast(ST.online?'🟢 Online':'🔴 Offline'); }

// ─────────────────────────────────────────────
// NAVEGAÇÃO POR ABAS
// ─────────────────────────────────────────────
function irPara(tela) {
  if (tela === 'perfil') { abrirConfig(); return; }
  if (tela === 'historico') { abrirHistorico(); return; }

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('ativa'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('ativo'));

  const screen = document.getElementById(`screen-${tela}`);
  const navTab = document.getElementById(`nav-${tela}`);
  if (screen) screen.classList.add('ativa');
  if (navTab) navTab.classList.add('ativo');

  if (tela === 'home') atualizarHomeScreen();
}

function setAtividade(tipo) {
  ST.tipo = tipo;
  ['corrida','ciclismo','caminhada'].forEach(t => {
    document.getElementById(`btn-${t}`)?.classList.toggle('ativo', t===tipo);
  });
}

// ─────────────────────────────────────────────
// HOME SCREEN
// ─────────────────────────────────────────────
async function atualizarHomeScreen() {
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) return;
    const { stats } = await r.json();
    const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
    set('home-km-semana',    (stats.km_totais||0).toFixed(1));
    set('home-treinos-semana', `${stats.total_treinos||0} treinos no total`);
    set('home-cal-semana',   stats.calorias_totais||0);
    set('home-tempo-semana', `${Math.floor(stats.horas_totais||0)}h ${Math.round(((stats.horas_totais||0)%1)*60)}m`);
    set('home-km-total',     (stats.km_totais||0).toFixed(1));
    set('home-total-treinos', stats.total_treinos||0);
    set('rank-km-voce',      (stats.km_totais||0).toFixed(1)+' km');
    // Desafio 30km
    const pct = Math.min(((stats.km_totais||0)/30)*100,100);
    const fill = document.getElementById('ch1-fill');
    if (fill) fill.style.width = pct+'%';
    set('ch1-atual', (stats.km_totais||0).toFixed(1)+' km');
  } catch(e) { console.warn('[Home]', e); }
}

// ─────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────
function toast(msg, dur=3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('vis');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('vis'), dur);
}

function atualizarBadge(id, estado, texto) {
  const dot = document.getElementById(`dot-${id}`);
  const txt = document.getElementById(`txt-${id}`);
  if (dot) dot.className = `dot${estado?' '+estado:''}`;
  if (txt) txt.textContent = texto;
}

function formatDuracao(seg) {
  const h = Math.floor(seg/3600);
  const m = Math.floor((seg%3600)/60);
  const s = seg%60;
  if (h>0) return `${h}h${pad(m)}m`;
  return `${m}:${pad(s)}`;
}

// ─────────────────────────────────────────────
// SERVICE WORKER
// ─────────────────────────────────────────────
async function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/service-worker.js', { scope:'/' });
    navigator.serviceWorker.addEventListener('message', evt => {
      if (evt.data?.tipo === 'EXECUTAR_SYNC') sincronizarPendentes();
    });
  } catch(e) { console.warn('[SW]', e); }
}

// ─────────────────────────────────────────────
// INICIALIZAÇÃO
// ─────────────────────────────────────────────
async function inicializar() {
  console.log('⚡ VELOX v3.0 iniciando...');
  carregarConfig();
  await abrirDB();
  initMapa();
  atualizarRede();
  atualizarPendentes();
  await registrarSW();
  window.addEventListener('online',  atualizarRede);
  window.addEventListener('offline', atualizarRede);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState==='visible' && ST.ativo && !ST.wakeLock) await ativarWakeLock();
  });
  // Auto-start via URL
  const params = new URLSearchParams(location.search);
  if (params.get('modo')) setAtividade(params.get('modo'));
  console.log('✅ VELOX pronto!');
}

// ─────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────
window.VX = {
  alternarTreino,
  retomarTreino,
  finalizarTreino,
  setAtividade,
  conectarBLE,
  verificarRede,
  abrirHistorico,
  fecharHistorico,
  abrirConfig,
  fecharConfig,
  salvarConfig,
  exportarGPX,
  fecharResumo,
  sincronizarManual,
  irPara,
};

window.playAudio = (url) => new Audio(url).play().catch(()=>{});

document.addEventListener('DOMContentLoaded', inicializar);
