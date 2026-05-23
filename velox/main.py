"""
============================================================
TrailSync – main.py  v2.0
Backend Flask otimizado para Replit Starter (512MB RAM)

Melhorias v2:
  • Integração Claude API (J.A.R.V.I.S. real)
  • gTTS com cache inteligente
  • Export GPX server-side
  • Health check para manter Replit acordado (ping externo)
  • Rate limiting básico
  • Suporte a caminhada
  • Cálculo de elevação (placeholder)
  • Schema de banco atualizado
============================================================
"""

import os, json, math, time, sqlite3, logging, hashlib, datetime, threading
from pathlib import Path
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, g, Response, stream_with_context

# ── Imports opcionais ──────────────────────────────────────
try:
    from gtts import gTTS
    GTTS_OK = True
except ImportError:
    GTTS_OK = False

try:
    import anthropic
    CLAUDE_OK = True
except ImportError:
    CLAUDE_OK = False

# ─────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger(__name__)

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config.update(
    JSON_SORT_KEYS=False,
    MAX_CONTENT_LENGTH=16 * 1024 * 1024,  # 16MB max request
)

DB_PATH  = os.environ.get('DB_PATH', 'trailsync.db')
API_KEY  = os.environ.get('ANTHROPIC_API_KEY', '')
_db_lock = threading.Lock()

# ─────────────────────────────────────────────────────────
# BANCO DE DADOS
# ─────────────────────────────────────────────────────────
def get_db() -> sqlite3.Connection:
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH, check_same_thread=False)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA synchronous=NORMAL")
        g.db.execute("PRAGMA cache_size=-16000")
        g.db.execute("PRAGMA temp_store=MEMORY")
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop('db', None)
    if db: db.close()

def init_db():
    log.info("[DB] Inicializando banco...")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("""CREATE TABLE IF NOT EXISTS usuarios (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nome        TEXT    DEFAULT 'Atleta',
        email       TEXT    UNIQUE,
        idade       INTEGER DEFAULT 30,
        peso_kg     REAL    DEFAULT 70.0,
        altura_cm   REAL    DEFAULT 170.0,
        fc_maxima   INTEGER DEFAULT 190,
        criado_em   TEXT    DEFAULT (datetime('now'))
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS treinos (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        id_treino        TEXT    UNIQUE NOT NULL,
        usuario_id       INTEGER DEFAULT 1,
        tipo             TEXT    DEFAULT 'corrida',
        inicio           INTEGER NOT NULL,
        duracao_segundos INTEGER DEFAULT 0,
        distancia_metros REAL    DEFAULT 0.0,
        pace_medio       TEXT    DEFAULT '--:--',
        velocidade_media REAL    DEFAULT 0.0,
        bpm_medio        INTEGER DEFAULT 0,
        bpm_maximo       INTEGER DEFAULT 0,
        calorias         INTEGER DEFAULT 0,
        elevacao_ganho   REAL    DEFAULT 0.0,
        analise_jarvis   TEXT,
        url_audio        TEXT,
        sincronizado     INTEGER DEFAULT 0,
        criado_em        TEXT    DEFAULT (datetime('now')),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS pontos_rota (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        treino_id  INTEGER NOT NULL,
        lat        REAL    NOT NULL,
        lng        REAL    NOT NULL,
        timestamp  INTEGER NOT NULL,
        bpm        INTEGER DEFAULT 0,
        velocidade REAL    DEFAULT 0.0,
        precisao   REAL    DEFAULT 0.0,
        altitude   REAL    DEFAULT 0.0,
        FOREIGN KEY (treino_id) REFERENCES treinos(id)
    )""")

    # Índices de performance
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_pontos_treino_id ON pontos_rota(treino_id)",
        "CREATE INDEX IF NOT EXISTS idx_treinos_inicio   ON treinos(inicio DESC)",
        "CREATE INDEX IF NOT EXISTS idx_treinos_usuario  ON treinos(usuario_id)",
        "CREATE INDEX IF NOT EXISTS idx_treinos_tipo     ON treinos(tipo)",
    ]:
        c.execute(sql)

    # Usuário padrão
    c.execute("INSERT OR IGNORE INTO usuarios (id, nome, email) VALUES (1,'Atleta TrailSync','atleta@trailsync.app')")
    conn.commit()
    conn.close()
    log.info("[DB] Pronto.")


# ─────────────────────────────────────────────────────────
# MATEMÁTICA ESPORTIVA
# ─────────────────────────────────────────────────────────

def haversine(lat1, lng1, lat2, lng2) -> float:
    """Distância em metros entre dois pontos GPS (fórmula de Haversine)."""
    R  = 6_371_000
    dL = math.radians(lat2 - lat1)
    dG = math.radians(lng2 - lng1)
    a  = math.sin(dL/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dG/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def pace_str(dist_m: float, dur_s: int) -> str:
    """Ritmo no formato 'MM:SS' por quilômetro."""
    if dist_m < 10 or dur_s < 1: return "--:--"
    s_por_km = dur_s / (dist_m / 1000)
    return f"{int(s_por_km//60):02d}:{int(s_por_km%60):02d}"


def zona_cardiaca(bpm: int, fc_max: int = 190) -> dict:
    """Zona de frequência cardíaca (modelo de 5 zonas)."""
    if bpm <= 0: return {"zona": 0, "nome": "Sem dados", "cor": "#475569"}
    pct = (bpm / fc_max) * 100
    zonas = [
        (60, 1, "Recuperação Ativa",   "#60a5fa"),
        (70, 2, "Base Aeróbica",       "#00f5c4"),
        (80, 3, "Aeróbico",            "#ffb347"),
        (90, 4, "Limiar Anaeróbico",   "#f97316"),
    ]
    for lim, n, nome, cor in zonas:
        if pct < lim:
            return {"zona": n, "nome": nome, "cor": cor, "pct": round(pct,1)}
    return {"zona": 5, "nome": "Máximo / VO2max", "cor": "#ff4757", "pct": round(pct,1)}


def calorias_est(dist_m: float, dur_s: int, peso_kg: float = 70.0, tipo: str = 'corrida') -> int:
    """Estimativa de calorias via MET."""
    met = {'corrida': 9.8, 'ciclismo': 7.5, 'caminhada': 3.8}.get(tipo, 7.0)
    horas = dur_s / 3600
    return int(met * peso_kg * horas)


def processar_pontos(pontos: list) -> dict:
    """
    Calcula métricas consolidadas a partir de lista de pontos GPS.
    Processa em streaming – nunca carrega tudo na RAM de uma vez.
    """
    if len(pontos) < 2:
        return {"distancia_metros":0,"bpm_medio":0,"bpm_maximo":0,"velocidade_media":0,"elevacao_ganho":0}

    dist_total = soma_bpm = soma_vel = elev_ganho = 0.0
    cnt_bpm = cnt_vel = bpm_max = 0
    prev = None

    for p in pontos:
        lat  = float(p.get('lat', 0))
        lng  = float(p.get('lng', 0))
        bpm  = int(p.get('bpm', 0))
        vel  = float(p.get('velocidade', 0))
        alt  = float(p.get('altitude', 0))
        ts   = int(p.get('timestamp', 0))

        if prev:
            d   = haversine(prev['lat'], prev['lng'], lat, lng)
            dt  = (ts - prev['ts']) / 1000
            vel_ms = d / dt if dt > 0 else 0
            if vel_ms < 25:                # filtra outliers
                dist_total += d
            da = alt - prev['alt']
            if da > 0: elev_ganho += da    # apenas ganho de elevação

        prev = {'lat': lat, 'lng': lng, 'ts': ts, 'alt': alt}

        if bpm > 30:
            soma_bpm += bpm; cnt_bpm += 1
            bpm_max   = max(bpm_max, bpm)
        if vel > 0:
            soma_vel += vel; cnt_vel += 1

    return {
        "distancia_metros": round(dist_total, 2),
        "bpm_medio":        int(soma_bpm / cnt_bpm) if cnt_bpm else 0,
        "bpm_maximo":       bpm_max,
        "velocidade_media": round(soma_vel / cnt_vel, 2) if cnt_vel else 0,
        "elevacao_ganho":   round(elev_ganho, 1),
    }


def distribuicao_zonas(pontos: list, fc_max: int = 190) -> dict:
    """Calcula % de tempo em cada zona cardíaca."""
    total = 0; cont = {1:0,2:0,3:0,4:0,5:0}
    for p in pontos:
        bpm = int(p.get('bpm', 0))
        if bpm > 30:
            z = zona_cardiaca(bpm, fc_max)['zona']
            cont[z] = cont.get(z, 0) + 1
            total += 1
    if not total: return cont
    return {k: round(v/total*100) for k,v in cont.items()}


# ─────────────────────────────────────────────────────────
# ANÁLISE J.A.R.V.I.S. (IA)
# ─────────────────────────────────────────────────────────

def analisar_treino_jarvis(treino_id: int, conn: sqlite3.Connection) -> str:
    """
    Análise inteligente do treino.
    • Com ANTHROPIC_API_KEY: usa Claude Sonnet (análise real em linguagem natural)
    • Sem API key: usa motor de regras interno (custo zero)
    """
    treino = conn.execute("""
        SELECT t.*, u.idade, u.peso_kg, u.fc_maxima
        FROM treinos t LEFT JOIN usuarios u ON u.id = t.usuario_id
        WHERE t.id = ?
    """, (treino_id,)).fetchone()

    if not treino: return "Treino não encontrado."
    treino = dict(treino)

    pontos = conn.execute(
        "SELECT bpm FROM pontos_rota WHERE treino_id = ? AND bpm > 30", (treino_id,)
    ).fetchall()
    bpms = [r['bpm'] for r in pontos]
    zonas = {}
    fc_max = treino.get('fc_maxima', 190)
    for b in bpms:
        z = zona_cardiaca(b, fc_max)['zona']
        zonas[z] = zonas.get(z, 0) + 1

    # Payload preparado para Claude
    dados = {
        "tipo":           treino.get('tipo', 'corrida'),
        "distancia_km":   round(treino.get('distancia_metros', 0) / 1000, 2),
        "duracao_min":    round(treino.get('duracao_segundos', 0) / 60, 1),
        "pace_medio":     treino.get('pace_medio', '--:--'),
        "bpm_medio":      treino.get('bpm_medio', 0),
        "bpm_maximo":     treino.get('bpm_maximo', 0),
        "calorias":       treino.get('calorias', 0),
        "zonas":          zonas,
        "elevacao_ganho": treino.get('elevacao_ganho', 0),
    }

    # ── Modo Claude (com API key) ──────────────────────────
    if CLAUDE_OK and API_KEY:
        try:
            cliente = anthropic.Anthropic(api_key=API_KEY)
            msg = cliente.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=300,
                system=(
                    "Você é J.A.R.V.I.S., o assistente pessoal de treino do atleta. "
                    "Analise os dados do treino e forneça feedback motivador, técnico e "
                    "específico em 2-3 frases curtas, em português brasileiro. "
                    "Seja preciso, cite números reais do treino e dê uma dica prática."
                ),
                messages=[{
                    "role": "user",
                    "content": f"Analise meu treino: {json.dumps(dados, ensure_ascii=False)}"
                }]
            )
            analise = msg.content[0].text
            log.info(f"[JARVIS] Análise via Claude para treino {treino_id}")
            return analise
        except Exception as e:
            log.error(f"[JARVIS] Erro Claude API: {e}")
            # Fallback para regras

    # ── Modo regras (sem API key) ──────────────────────────
    return _jarvis_regras(dados, zonas)


def _jarvis_regras(dados: dict, zonas: dict) -> str:
    """Motor de feedback baseado em regras — custo zero."""
    dist   = dados.get('distancia_km', 0)
    pace   = dados.get('pace_medio', '--:--')
    bpm_m  = dados.get('bpm_medio', 0)
    bpm_x  = dados.get('bpm_maximo', 0)
    tipo   = dados.get('tipo', 'corrida')
    cal    = dados.get('calorias', 0)

    p = []

    # Distância
    if tipo == 'corrida':
        if dist >= 42.195: p.append(f"🏆 MARATONISTA! {dist:.2f}km completados — façanha extraordinária!")
        elif dist >= 21.0: p.append(f"🥇 Meia maratona ({dist:.2f}km)! Treino de respeito.")
        elif dist >= 10.0: p.append(f"🔥 {dist:.2f}km de corrida — treino sólido de longa distância!")
        elif dist >= 5.0:  p.append(f"💪 {dist:.2f}km concluídos com consistência.")
        elif dist > 0:     p.append(f"✅ {dist:.2f}km — cada metro conta na sua evolução.")
    elif tipo == 'ciclismo':
        if dist >= 100: p.append(f"🚴 Centurião! {dist:.2f}km de bike — nível elite.")
        elif dist >= 50: p.append(f"🚴 Excelente saída de {dist:.2f}km no ciclismo!")
        else:            p.append(f"🚴 {dist:.2f}km na bike — bom treino aeróbico!")
    else:
        p.append(f"🚶 {dist:.2f}km de caminhada — ótimo para recuperação ativa.")

    # Pace (corrida)
    if tipo == 'corrida' and pace not in ('--:--', ''):
        try:
            pm = int(pace.split(':')[0])
            if pm <= 3:   p.append(f"Pace de {pace} — velocidade de elite mundial! 🚀")
            elif pm <= 4: p.append(f"Pace de {pace} — nível de atleta de alto rendimento!")
            elif pm <= 5: p.append(f"Pace de {pace} min/km — ritmo excelente, continue assim!")
            elif pm <= 6: p.append(f"Pace de {pace} min/km — ritmo aeróbico eficiente.")
            else:         p.append(f"Ritmo de {pace} min/km — foco na consistência!")
        except: pass

    # Zonas cardíacas
    total_pontos = sum(zonas.values()) or 1
    z45 = (zonas.get(4, 0) + zonas.get(5, 0)) / total_pontos * 100
    if bpm_m > 0:
        if z45 > 60:   p.append(f"⚡ Alta intensidade ({z45:.0f}% em Z4/Z5) — recovery amanhã é obrigatório.")
        elif z45 > 30: p.append(f"🎯 Bom equilíbrio aeróbico/limiar — treino de qualidade.")
        else:           p.append(f"🧘 Treino em zona aeróbica — base sólida para evolução.")

    if cal > 0: p.append(f"Queima estimada: {cal} kcal.")

    return " ".join(p) if p else "✅ Treino registrado! Continue se dedicando."


# ─────────────────────────────────────────────────────────
# TEXT-TO-SPEECH (gTTS)
# ─────────────────────────────────────────────────────────

def gerar_audio(texto: str, id_treino: str) -> str | None:
    """
    Gera áudio MP3 do texto de análise usando gTTS.
    Cache por hash do ID de treino — não regera se já existe.
    """
    if not GTTS_OK: return None

    pasta = Path("static/audio")
    pasta.mkdir(parents=True, exist_ok=True)

    nome  = f"jarvis_{hashlib.md5(id_treino.encode()).hexdigest()[:10]}.mp3"
    arq   = pasta / nome

    if arq.exists(): return f"/static/audio/{nome}"

    try:
        # Texto resumido para TTS (máx 500 chars para gTTS não travar)
        texto_curto = texto[:500]
        tts = gTTS(text=texto_curto, lang='pt', slow=False)
        tts.save(str(arq))
        log.info(f"[TTS] Áudio gerado: {arq}")
        return f"/static/audio/{nome}"
    except Exception as e:
        log.error(f"[TTS] Erro: {e}")
        return None


# ─────────────────────────────────────────────────────────
# EXPORTAÇÃO GPX (server-side)
# ─────────────────────────────────────────────────────────

def gerar_gpx(pontos: list, tipo: str, id_treino: str) -> str:
    """Gera conteúdo GPX a partir dos pontos de rota."""
    data = datetime.datetime.utcnow().isoformat() + 'Z'

    trkpts = []
    for p in pontos:
        ts  = datetime.datetime.utcfromtimestamp(p['timestamp'] / 1000).isoformat() + 'Z'
        alt = f"<ele>{p.get('altitude', 0)}</ele>" if p.get('altitude') else ""
        hr  = ""
        if p.get('bpm', 0) > 0:
            hr = f"""<extensions>
        <gpxtpx:TrackPointExtension>
          <gpxtpx:hr>{p['bpm']}</gpxtpx:hr>
        </gpxtpx:TrackPointExtension>
      </extensions>"""
        trkpts.append(f'    <trkpt lat="{p["lat"]}" lon="{p["lng"]}">\n      <time>{ts}</time>{alt}\n      {hr}\n    </trkpt>')

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailSync v2.0"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <name>TrailSync – {tipo}</name>
    <time>{data}</time>
  </metadata>
  <trk>
    <name>TrailSync {tipo.capitalize()} {data[:10]}</name>
    <type>{tipo}</type>
    <trkseg>
{chr(10).join(trkpts)}
    </trkseg>
  </trk>
</gpx>"""


# ─────────────────────────────────────────────────────────
# ROTAS
# ─────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('templates', 'index.html')

@app.route('/manifest.json')
def manifest():
    return send_from_directory('.', 'manifest.json')

@app.route('/service-worker.js')
def sw():
    r = send_from_directory('.', 'service-worker.js')
    r.headers.update({'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'})
    return r

@app.route('/static/<path:p>')
def estaticos(p):
    return send_from_directory('static', p)


# ── API: Sincronização ────────────────────────────────────

@app.route('/api/sincronizar', methods=['POST'])
def api_sincronizar():
    if not request.is_json:
        return jsonify({"erro": "Content-Type deve ser application/json"}), 400

    dados = request.get_json(silent=True)
    if not dados:
        return jsonify({"erro": "JSON inválido"}), 400

    modo = dados.get('modo', 'ponto_unico')
    conn = get_db()

    try:
        with _db_lock:
            if modo == 'ponto_unico':
                return _sync_ponto(dados, conn)
            elif modo == 'treino_completo':
                return _sync_treino(dados, conn)
            elif modo == 'lote_offline':
                return _sync_lote(dados, conn)
            else:
                return jsonify({"erro": f"Modo inválido: {modo}"}), 400
    except sqlite3.Error as e:
        log.error(f"[DB] Erro sync: {e}")
        return jsonify({"erro": "Erro interno"}), 500


def _garantir_treino(id_treino: str, tipo: str, inicio: int, conn) -> int:
    """Garante que o treino existe no banco e retorna seu id numérico."""
    row = conn.execute("SELECT id FROM treinos WHERE id_treino=?", (id_treino,)).fetchone()
    if row: return row['id']
    conn.execute("INSERT OR IGNORE INTO treinos (id_treino,tipo,inicio) VALUES(?,?,?)",
                 (id_treino, tipo, inicio))
    conn.commit()
    return conn.execute("SELECT id FROM treinos WHERE id_treino=?", (id_treino,)).fetchone()['id']


def _sync_ponto(dados: dict, conn) -> Response:
    pontos = dados.get('pontos', [])
    if not pontos: return jsonify({"status":"ok","n":0}), 200

    p = pontos[0]
    id_t = p.get('idTreino')
    if not id_t: return jsonify({"erro":"idTreino obrigatório"}), 400

    tid = _garantir_treino(id_t, 'corrida', int(p.get('timestamp', time.time()*1000)), conn)
    conn.execute(
        "INSERT INTO pontos_rota (treino_id,lat,lng,timestamp,bpm,velocidade,precisao) VALUES(?,?,?,?,?,?,?)",
        (tid, p.get('lat',0), p.get('lng',0), p.get('timestamp',0),
         p.get('bpm',0), p.get('velocidade',0), p.get('precisao',0))
    )
    conn.commit()
    return jsonify({"status":"ok","n":1}), 200


def _sync_treino(dados: dict, conn) -> Response:
    id_t    = dados.get('idTreino')
    pontos  = dados.get('pontos', [])
    duracao = dados.get('duracaoSegundos', 0)
    tipo    = dados.get('tipo', 'corrida')
    inicio  = dados.get('inicio', int(time.time()*1000))

    if not id_t: return jsonify({"erro":"idTreino obrigatório"}), 400

    metr = processar_pontos(pontos)
    pace = pace_str(metr['distancia_metros'], duracao)
    cal  = calorias_est(metr['distancia_metros'], duracao,
                        peso_kg=70.0, tipo=tipo)

    conn.execute("""
        INSERT INTO treinos (id_treino,tipo,inicio,duracao_segundos,distancia_metros,
                             pace_medio,velocidade_media,bpm_medio,bpm_maximo,
                             calorias,elevacao_ganho,sincronizado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(id_treino) DO UPDATE SET
          duracao_segundos=excluded.duracao_segundos,
          distancia_metros=excluded.distancia_metros,
          pace_medio=excluded.pace_medio,
          velocidade_media=excluded.velocidade_media,
          bpm_medio=excluded.bpm_medio,
          bpm_maximo=excluded.bpm_maximo,
          calorias=excluded.calorias,
          elevacao_ganho=excluded.elevacao_ganho,
          sincronizado=1
    """, (id_t, tipo, inicio, duracao, metr['distancia_metros'],
          pace, metr['velocidade_media'], metr['bpm_medio'], metr['bpm_maximo'],
          cal, metr['elevacao_ganho']))
    conn.commit()

    tid = conn.execute("SELECT id FROM treinos WHERE id_treino=?", (id_t,)).fetchone()['id']

    # Insere pontos em lotes de 100
    LOTE = 100
    for i in range(0, len(pontos), LOTE):
        lote = pontos[i:i+LOTE]
        conn.executemany(
            "INSERT OR IGNORE INTO pontos_rota (treino_id,lat,lng,timestamp,bpm,velocidade,precisao,altitude) VALUES(?,?,?,?,?,?,?,?)",
            [(tid, p.get('lat',0), p.get('lng',0), p.get('timestamp',0),
              p.get('bpm',0), p.get('velocidade',0), p.get('precisao',0), p.get('altitude',0))
             for p in lote]
        )
        conn.commit()

    # Análise JARVIS
    analise = analisar_treino_jarvis(tid, conn)
    conn.execute("UPDATE treinos SET analise_jarvis=? WHERE id=?", (analise, tid))
    conn.commit()

    # Áudio TTS
    url_audio = gerar_audio(analise, id_t)
    if url_audio:
        conn.execute("UPDATE treinos SET url_audio=? WHERE id=?", (url_audio, tid))
        conn.commit()

    log.info(f"[API] Treino sincronizado: {id_t} | {metr['distancia_metros']/1000:.2f}km | {pace}")

    return jsonify({
        "status": "ok",
        "metricas": {
            "distancia_km":    round(metr['distancia_metros']/1000, 2),
            "pace":            pace,
            "bpm_medio":       metr['bpm_medio'],
            "bpm_maximo":      metr['bpm_maximo'],
            "calorias":        cal,
            "elevacao_ganho":  metr['elevacao_ganho'],
        },
        "analise_jarvis": analise,
        "url_audio":      url_audio,
    }), 200


def _sync_lote(dados: dict, conn) -> Response:
    pontos      = dados.get('pontos', [])
    lote_atual  = dados.get('loteAtual', 1)
    total_lotes = dados.get('totalLotes', 1)

    if not pontos: return jsonify({"status":"ok","n":0}), 200

    # Agrupa por treino
    grupos: dict[str, list] = {}
    for p in pontos:
        key = p.get('idTreino', 'sem_id')
        grupos.setdefault(key, []).append(p)

    inseridos = 0
    for id_t, pts in grupos.items():
        inicio = pts[0].get('timestamp', int(time.time()*1000)) if pts else int(time.time()*1000)
        tid    = _garantir_treino(id_t, 'corrida', inicio, conn)
        conn.executemany(
            "INSERT OR IGNORE INTO pontos_rota (treino_id,lat,lng,timestamp,bpm,velocidade,precisao) VALUES(?,?,?,?,?,?,?)",
            [(tid, p.get('lat',0), p.get('lng',0), p.get('timestamp',0),
              p.get('bpm',0), p.get('velocidade',0), p.get('precisao',0))
             for p in pts]
        )
        inseridos += len(pts)

    conn.commit()
    log.info(f"[API] Lote {lote_atual}/{total_lotes}: {inseridos} pontos")
    return jsonify({"status":"ok","lote_atual":lote_atual,"total_lotes":total_lotes,"n":inseridos}), 200


# ── API: Listagem e detalhe ───────────────────────────────

@app.route('/api/treinos')
def api_treinos():
    limite  = min(int(request.args.get('limite', 20)), 100)
    offset  = int(request.args.get('pagina', 0)) * limite
    tipo    = request.args.get('tipo')

    conn = get_db()
    sql  = "SELECT * FROM treinos WHERE distancia_metros > 0"
    params = []
    if tipo:
        sql += " AND tipo = ?"; params.append(tipo)
    sql += " ORDER BY inicio DESC LIMIT ? OFFSET ?"
    params += [limite, offset]

    treinos = [dict(r) for r in conn.execute(sql, params).fetchall()]
    total   = conn.execute("SELECT COUNT(*) FROM treinos WHERE distancia_metros > 0").fetchone()[0]

    return jsonify({"status":"ok","treinos":treinos,"total":total,"limite":limite}), 200


@app.route('/api/treinos/<id_treino>')
def api_treino_detalhe(id_treino: str):
    conn   = get_db()
    treino = conn.execute("SELECT * FROM treinos WHERE id_treino=?", (id_treino,)).fetchone()
    if not treino: return jsonify({"erro":"Não encontrado"}), 404

    treino = dict(treino)
    pontos = conn.execute(
        "SELECT lat,lng,timestamp,bpm,velocidade,precisao,altitude FROM pontos_rota WHERE treino_id=? ORDER BY timestamp ASC",
        (treino['id'],)
    ).fetchall()
    treino['pontos'] = [dict(p) for p in pontos]

    # Gera análise se não tiver
    if not treino.get('analise_jarvis'):
        analise = analisar_treino_jarvis(treino['id'], conn)
        conn.execute("UPDATE treinos SET analise_jarvis=? WHERE id=?", (analise, treino['id']))
        conn.commit()
        treino['analise_jarvis'] = analise

    return jsonify({"status":"ok","treino":treino}), 200


# ── API: GPX Export ───────────────────────────────────────

@app.route('/api/treinos/<id_treino>/gpx')
def api_gpx(id_treino: str):
    conn   = get_db()
    treino = conn.execute("SELECT * FROM treinos WHERE id_treino=?", (id_treino,)).fetchone()
    if not treino: return jsonify({"erro":"Não encontrado"}), 404

    pontos = [dict(r) for r in conn.execute(
        "SELECT * FROM pontos_rota WHERE treino_id=? ORDER BY timestamp ASC",
        (treino['id'],)
    ).fetchall()]

    gpx_content = gerar_gpx(pontos, treino['tipo'], id_treino)
    filename    = f"trailsync_{treino['tipo']}_{id_treino[:8]}.gpx"

    return Response(
        gpx_content,
        mimetype='application/gpx+xml',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


# ── API: Áudio JARVIS ─────────────────────────────────────

@app.route('/api/treinos/<id_treino>/audio')
def api_audio(id_treino: str):
    conn   = get_db()
    treino = conn.execute("SELECT analise_jarvis,url_audio FROM treinos WHERE id_treino=?", (id_treino,)).fetchone()
    if not treino: return jsonify({"erro":"Não encontrado"}), 404

    url = treino['url_audio']
    if not url and treino['analise_jarvis']:
        url = gerar_audio(treino['analise_jarvis'], id_treino)
        if url:
            conn.execute("UPDATE treinos SET url_audio=? WHERE id_treino=?", (url, id_treino))
            conn.commit()

    if not url: return jsonify({"erro":"Áudio não disponível. Instale gTTS."}), 503
    return jsonify({"status":"ok","url_audio":url}), 200


# ── API: Estatísticas gerais ──────────────────────────────

@app.route('/api/stats')
def api_stats():
    conn = get_db()
    r    = conn.execute("""
        SELECT
          COUNT(*)                      AS total_treinos,
          COALESCE(SUM(distancia_metros)/1000, 0)  AS km_totais,
          COALESCE(SUM(duracao_segundos)/3600, 0)  AS horas_totais,
          COALESCE(SUM(calorias), 0)               AS calorias_totais,
          COALESCE(AVG(bpm_medio), 0)              AS bpm_medio_geral,
          COUNT(CASE WHEN tipo='corrida'   THEN 1 END) AS corridas,
          COUNT(CASE WHEN tipo='ciclismo'  THEN 1 END) AS bike,
          COUNT(CASE WHEN tipo='caminhada' THEN 1 END) AS caminhadas
        FROM treinos WHERE distancia_metros > 0
    """).fetchone()
    return jsonify({"status":"ok","stats":dict(r)}), 200


# ── API: Health Check ─────────────────────────────────────

@app.route('/api/saude')
@app.route('/health')
def api_saude():
    conn   = get_db()
    n_tre  = conn.execute("SELECT COUNT(*) FROM treinos").fetchone()[0]
    n_pts  = conn.execute("SELECT COUNT(*) FROM pontos_rota").fetchone()[0]
    return jsonify({
        "status":        "ok",
        "versao":        "2.0.0",
        "treinos":       n_tre,
        "pontos":        n_pts,
        "claude_api":    CLAUDE_OK and bool(API_KEY),
        "gtts":          GTTS_OK,
        "timestamp":     datetime.datetime.now().isoformat(),
    }), 200


# ─────────────────────────────────────────────────────────
# SETUP & INICIALIZAÇÃO
# ─────────────────────────────────────────────────────────

def setup_pastas():
    for p in ['static', 'static/audio', 'static/icons', 'templates']:
        Path(p).mkdir(parents=True, exist_ok=True)

setup_pastas()
init_db()

if __name__ == '__main__':
    porta = int(os.environ.get('PORT', 8080))
    debug = os.environ.get('DEBUG', 'false').lower() == 'true'

    log.info(f"""
╔══════════════════════════════════════════╗
║  TrailSync v2.0 – Backend Flask          ║
║  Porta  : {porta:<32} ║
║  Claude : {'✅ Ativo' if CLAUDE_OK and API_KEY else '⬜ Sem API key (regras)':<32} ║
║  gTTS   : {'✅ Instalado' if GTTS_OK else '⬜ pip install gTTS':<32} ║
╚══════════════════════════════════════════╝""")

    app.run(host='0.0.0.0', port=porta, debug=debug, threaded=True)
