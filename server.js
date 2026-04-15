// Versão: 1.0.9 - Regex Parser (Relaxed) + UI Sorting
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Inicializa o cliente Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Auto-cria o bucket "videos" se não existir
async function ensureStorageBucket() {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = buckets?.some(b => b.name === 'videos');
    if (!exists) {
      await supabase.storage.createBucket('videos', {
        public: true,
        fileSizeLimit: 524288000 // 500 MB
      });
      console.log('[Storage] Bucket "videos" criado automaticamente.');
    } else {
      console.log('[Storage] Bucket "videos" OK.');
    }
  } catch (e) {
    console.warn('[Storage] Não foi possível verificar bucket:', e.message);
  }
}
ensureStorageBucket();

// Helper para listar arquivos recursivamente no Supabase Storage
async function listAllFiles(path = '') {
  let all = [];
  let offset = 0;
  const PAGE_SIZE = 100;

  while (true) {
    const { data, error } = await supabase.storage.from('videos').list(path, { 
      limit: PAGE_SIZE, 
      offset,
      sortBy: { column: 'name', order: 'asc' } 
    });
    
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const item of data) {
      if (item.name === '.emptyFolderPlaceholder') continue;
      
      // Se não tem metadata (size), assume que é pasta
      if (!item.metadata) {
        const subPath = path ? `${path}/${item.name}` : item.name;
        const subFiles = await listAllFiles(subPath);
        all = all.concat(subFiles);
      } else {
        all.push({
          ...item,
          fullPath: path ? `${path}/${item.name}` : item.name
        });
      }
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  
  return all;
}


// 1. Configuração Robusta de CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,       // https://www.reidobaralho.com.br
  'http://localhost:5173',        // dev local (frontend Vite)
  'http://localhost:3000',        // dev local (alternativo)
  'http://localhost:3001'         // dev local (backend)
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Bloqueado: ${origin}`);
      callback(new Error('Bloqueado por CORS: Origem não permitida.'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// 2. Rota de Teste de Status
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', message: 'Motor do IceoLab online v1.0.9' });
});

// 3. Autenticação OAuth 2.0 — Instagram Business Login (interface 100% Instagram)
app.get('/api/auth/meta', (req, res) => {
  const clientId    = '828166929780571';
  const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
  const scope       = encodeURIComponent('instagram_business_basic,instagram_business_content_publish');

  const authUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;

  console.log('[Auth] client_id   :', clientId);
  console.log('[Auth] redirect_uri:', process.env.REDIRECT_URI);
  console.log('[Auth] scope       : instagram_business_basic, instagram_business_content_publish');
  console.log('[Auth] URL gerada  :', authUrl);
  res.redirect(authUrl);
});

// 4. Callback — Troca o code pelo token, busca o perfil e salva no Supabase
app.get('/api/auth/meta/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = process.env.REDIRECT_URI;

  if (!code) {
    console.error('[Callback] Código de autorização ausente.');
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error&reason=no_code`);
  }

  try {
    // Passo 1: Troca o code pelo access_token (endpoint correto: api.instagram.com)
    const tokenResponse = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    // Novo formato da API: { data: [{ access_token, user_id, permissions }] }
    // Suporta também o formato legado: { access_token, user_id }
    const tokenData = tokenResponse.data?.data?.[0] || tokenResponse.data;
    let { access_token, user_id } = tokenData;
    console.log('[Callback] Token curto recebido para user_id:', user_id);

    // Passo 1.5: Troca o access_token de curto prazo (1-2h) por um de longo prazo (60 dias)
    try {
      const longLivedRes = await axios.get('https://graph.instagram.com/access_token', {
        params: {
          grant_type: 'ig_exchange_token',
          client_secret: process.env.META_APP_SECRET,
          access_token: access_token
        }
      });
      if (longLivedRes.data?.access_token) {
        access_token = longLivedRes.data.access_token;
        console.log('[Callback] Token longo recebido com sucesso (válido por ~60 dias).');
      }
    } catch (exchangeErr) {
      console.warn('[Callback] Aviso: falha ao gerar token longo, usando o curto.', exchangeErr.message);
    }

    // Passo 2: Busca o username e profile_picture_url na Graph API
    const profileResponse = await axios.get('https://graph.instagram.com/me', {
      params: {
        fields: 'id,username,profile_picture_url',
        access_token: access_token
      }
    });

    const { username, profile_picture_url } = profileResponse.data;
    console.log('[Callback] Perfil obtido:', username);

    // Passo 3: Monta o objeto a ser salvo no Supabase
    // UUID fixo de teste — substitua pelo ID real do usuário logado quando houver auth
    const dataToInsert = {
      user_id: null,
      instagram_username: username,
      access_token: access_token,
      profile_picture: profile_picture_url || null
    };

    console.log('=== JSON QUE VAI PRO BANCO ===');
    console.log(JSON.stringify(dataToInsert, null, 2));
    console.log('==============================');

    const { data: savedData, error } = await supabase
      .from('instagram_accounts')
      .insert([dataToInsert])
      .select(); // .select() confirma o retorno do registro inserido

    if (error) {
      console.error('--- ERRO NO SUPABASE ---');
      console.error('Mensagem:', error.message);
      console.error('Código:', error.code);
      console.error('Detalhes:', error.details);
      console.error('Hint:', error.hint);
      console.error('------------------------');
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error&reason=db_error`);
    }

    console.log('--- SALVO COM SUCESSO! ---', savedData);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?success=true`);

  } catch (error) {
    const errDetail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('[Callback] Erro geral:', errDetail);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?status=error&reason=auth_failed`);
  }
});


// 5. Rota: Lista todas as contas Instagram vinculadas
app.get('/api/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('instagram_accounts')
      .select('id, instagram_username, profile_picture, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Accounts] Erro ao buscar contas:', error.message);
      return res.status(500).json({ error: 'Erro ao buscar contas.' });
    }

    res.json({ accounts: data });
  } catch (err) {
    console.error('[Accounts] Erro inesperado:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// 5b. Rota: Deleta uma conta Instagram específica
app.delete('/api/accounts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    console.log(`[Accounts] Removendo conta ID: ${id}`);
    const { error } = await supabase
      .from('instagram_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[Accounts] Erro ao remover conta:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, message: 'Conta removida com sucesso.' });
  } catch (err) {
    console.error('[Accounts] Erro ao remover:', err.message);
    res.status(500).json({ error: 'Erro interno ao remover conta.' });
  }
});

// ── Função compartilhada: posta um Reel no Instagram ──────────────
async function postReelToInstagram(videoUrl, caption = '', accountId = null) {
  try {
    let query = supabase
      .from('instagram_accounts')
      .select('access_token, instagram_username');

    if (accountId) {
      query = query.eq('id', accountId);
    } else {
      query = query.order('created_at', { ascending: false }).limit(1);
    }

    const { data: accounts } = await query;
    if (!accounts?.length) throw new Error('Conta Instagram não encontrada.');
    const { access_token, instagram_username } = accounts[0];

    const meRes = await axios.get('https://graph.instagram.com/me', {
      params: { fields: 'user_id', access_token }
    });
    const igUserId = meRes.data.user_id || meRes.data.id;

    let containerId;
    try {
      const containerRes = await axios.post(
        `https://graph.instagram.com/v22.0/${igUserId}/media`, null,
        { params: { media_type: 'REELS', video_url: videoUrl, caption, access_token } }
      );
      containerId = containerRes.data.id;
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      throw new Error(`Erro ao criar container: ${detail}`);
    }

    // Polling
    let statusCode = 'IN_PROGRESS', attempts = 0;
    while (statusCode === 'IN_PROGRESS' && attempts < 20) {
      await new Promise(r => setTimeout(r, 15000));
      attempts++;
      const s = await axios.get(`https://graph.instagram.com/v22.0/${containerId}`,
        { params: { fields: 'status_code', access_token } });
      statusCode = s.data.status_code;
      if (statusCode === 'ERROR') throw new Error('Meta rejeitou o vídeo: ' + JSON.stringify(s.data));
    }
    if (statusCode !== 'FINISHED') throw new Error('Timeout no processamento do vídeo');

    try {
      const publishRes = await axios.post(
        `https://graph.instagram.com/v22.0/${igUserId}/media_publish`, null,
        { params: { creation_id: containerId, access_token } }
      );
      
      const postId = publishRes.data.id;

      // --- Salva o histórico de publicação no Supabase ---
      const videoName = videoUrl.split('/').pop().split('?')[0]; // Pega apenas o nome do arquivo XXXXX.mp4
      await supabase.from('post_history').insert({
        video_name: videoName,
        account_username: instagram_username,
        post_id: postId
      }).catch(err => console.error('[History] Falha ignorada ao salvar hitórico na DB:', err.message));

      return { post_id: postId, username: instagram_username };
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      throw new Error(`Erro ao publicar o Reel: ${detail}`);
    }
  } catch (globalErr) {
    // Captura qualquer outro erro Axios (como o GET /me) para não perder o detalhe
    if (globalErr.response?.data?.error) {
      throw new Error(`Meta API: ${globalErr.response.data.error.message || JSON.stringify(globalErr.response.data.error)}`);
    }
    throw globalErr;
  }
}


// 6. Motor de Publicação de Reels
// configuração multer — armazena em memória, limite de 500MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// 6a. Upload de vídeo → Supabase Storage → retorna URL pública
app.post('/api/videos/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const { originalname, buffer, mimetype } = req.file;
  let safeName = `${Date.now()}-${originalname.replace(/[^a-z0-9._-]/gi, '_')}`;

  if (req.body.folder) {
    const safeFolder = req.body.folder.replace(/[^a-z0-9_-]/gi, '_'); // prevent path traversal
    safeName = `${safeFolder}/${safeName}`;
  }

  console.log(`[Upload] Recebido: ${originalname} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

  const { error: uploadError } = await supabase.storage
    .from('videos')
    .upload(safeName, buffer, { contentType: mimetype, upsert: false });

  if (uploadError) {
    console.error('[Upload] Erro no Supabase Storage:', uploadError.message);
    return res.status(500).json({ error: uploadError.message });
  }

  const { data: urlData } = supabase.storage.from('videos').getPublicUrl(safeName);
  console.log(`[Upload] ✅ URL pública: ${urlData.publicUrl}`);

  res.json({ success: true, url: urlData.publicUrl, name: originalname });
});

// 6b. Motor de postagem de Reels (já existente)
app.post('/api/reels/post', async (req, res) => {
  const { video_url, caption } = req.body;

  if (!video_url) {
    return res.status(400).json({ error: 'video_url é obrigatório.' });
  }

  console.log('\n========== [Reels] Nova Solicitação de Postagem ==========');
  console.log('video_url :', video_url);
  console.log('caption   :', caption || '(sem legenda)');

  try {
    // ── Etapa 0: Busca o access_token e username no Supabase ─────────
    const { data: accounts, error: dbError } = await supabase
      .from('instagram_accounts')
      .select('access_token, instagram_username')
      .order('created_at', { ascending: false })
      .limit(1);

    if (dbError || !accounts?.length) {
      console.error('[Reels] Nenhuma conta no Supabase:', dbError?.message);
      return res.status(404).json({ error: 'Nenhuma conta Instagram conectada.' });
    }

    const { access_token, instagram_username } = accounts[0];
    console.log('[Reels] Conta:', instagram_username);

    // ── Etapa 0b: Busca o Instagram User ID via /me ──────────────────
    const meRes = await axios.get('https://graph.instagram.com/me', {
      params: { fields: 'user_id,username', access_token }
    });
    const igUserId = meRes.data.user_id || meRes.data.id;
    console.log('[Reels] ig_user_id:', igUserId);

    // ── Etapa 1: Cria o container de mídia (Reel) ────────────────────
    console.log('\n[Reels] Etapa 1 — Criando container...');
    const containerRes = await axios.post(
      `https://graph.instagram.com/v22.0/${igUserId}/media`,
      null,
      {
        params: {
          media_type: 'REELS',
          video_url,
          caption: caption || '',
          access_token
        }
      }
    );
    const containerId = containerRes.data.id;
    console.log('[Reels] ✅ Container criado. ID:', containerId);

    // ── Etapa 2: Polling — aguarda a Meta processar o vídeo ──────────
    console.log('[Reels] Etapa 2 — Aguardando processamento do vídeo...');
    const MAX_ATTEMPTS = 20;      // 20 tentativas × 15s = 5 min máximo
    const POLL_INTERVAL_MS = 15000;
    let attempt = 0;
    let statusCode = 'IN_PROGRESS';

    while (statusCode === 'IN_PROGRESS' && attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      attempt++;

      const statusRes = await axios.get(
        `https://graph.instagram.com/v22.0/${containerId}`,
        { params: { fields: 'status_code,status', access_token } }
      );
      statusCode = statusRes.data.status_code;
      console.log(`[Reels] Tentativa ${attempt}/${MAX_ATTEMPTS} — status: ${statusCode}`);

      if (statusCode === 'ERROR') {
        console.error('[Reels] ❌ Erro reportado pela Meta:', statusRes.data);
        return res.status(500).json({
          error: 'A Meta retornou erro no processamento do vídeo.',
          detail: statusRes.data
        });
      }
    }

    if (statusCode !== 'FINISHED') {
      return res.status(504).json({
        error: `Timeout: vídeo não processado em ${MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. Status: ${statusCode}`,
        container_id: containerId
      });
    }

    // ── Etapa 3: Publica o Reel ──────────────────────────────────────
    console.log('[Reels] Etapa 3 — Publicando Reel...');
    const publishRes = await axios.post(
      `https://graph.instagram.com/v22.0/${igUserId}/media_publish`,
      null,
      { params: { creation_id: containerId, access_token } }
    );
    const postId = publishRes.data.id;
    console.log('[Reels] 🎉 Reel publicado! Post ID:', postId);
    console.log('===========================================================\n');

    res.json({
      success: true,
      post_id: postId,
      username: instagram_username,
      message: `Reel publicado com sucesso em @${instagram_username}!`
    });

  } catch (err) {
    const errData = err.response?.data || { message: err.message };
    console.error('[Reels] ❌ Erro geral:', JSON.stringify(errData, null, 2));
    res.status(500).json({
      error: 'Falha ao publicar o Reel.',
      detail: errData
    });
  }
});

// 7. Lista vídeos disponíveis no Supabase Storage (Recursivo)
app.get('/api/videos', async (req, res) => {
  try {
    const data = await listAllFiles('');
    // Regex relaxada para aceitar prefixos de timestamp
    const regex = /Top(?<rank>\d{2})_(?<views>[\d\.MK]+)_v_(?<id>.+)\.mp4$/;
    
    const videos = data.map(f => {
      const match = f.name.match(regex);
      const meta = match?.groups || {};
      
      return {
        name: f.name,
        fullPath: f.fullPath,
        size: f.metadata?.size || 0,
        created_at: f.created_at,
        url: supabase.storage.from('videos').getPublicUrl(f.fullPath).data.publicUrl,
        // Metadata extraída do nome do arquivo
        rank: meta.rank ? parseInt(meta.rank) : null,
        views: meta.views || null,
        videoId: meta.id || null
      };
    });

    res.json({ videos });
  } catch (error) {
    console.error('[Videos] Erro ao listar:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 7c. Rota para Resetar o Laboratório (Apagar tudo)
app.get('/api/videos/reset', async (req, res) => {
  try {
    console.log('[Reset] Iniciando limpeza total...');
    
    // 1. Listar todos os arquivos
    const allFiles = await listAllFiles('');
    const pathsToDelete = allFiles.map(f => f.fullPath);

    // 2. Apagar do Storage
    if (pathsToDelete.length > 0) {
      const { error: storageErr } = await supabase.storage.from('videos').remove(pathsToDelete);
      if (storageErr) throw storageErr;
      console.log(`[Reset] ${pathsToDelete.length} arquivos removidos do storage.`);
    }

    // 3. Limpar histórico no banco (mais robusto)
    const { error: dbErr } = await supabase
      .from('post_history')
      .delete()
      .not('created_at', 'is', null); // Deleta tudo que tem data de criação (quase tudo)

    if (dbErr) {
      console.warn('[Reset] Falha ao limpar post_history do banco:', dbErr.message);
      // Não damos throw aqui porque o storage já foi limpo, o que é o principal
    }
    
    console.log('[Reset] Limpeza concluída.');
    res.json({ success: true, message: 'Laboratório resetado com sucesso.' });
  } catch (error) {
    console.error('[Reset] Erro:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// 7b. Rota de Histórico de Posts para o Frontend mapear de quais contas o vídeo foi postado
app.get('/api/post-history', async (req, res) => {
  const { data, error } = await supabase
    .from('post_history')
    .select('video_name, account_username')
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('[History] Aviso ao buscar histórico:', error.message);
    // Retorna vazio em vez de 500 se houver erro (tabela não criada, etc)
    return res.json({ history: {} });
  }

  // Agrupa os dados no backend para enviar num dicionário: { "nome_do_video": { "conta1": 2, "conta2": 1 } }
  const historyMap = {};
  for (const row of (data || [])) {
    const v = row.video_name;
    const acc = row.account_username;
    if (!historyMap[v]) historyMap[v] = {};
    if (!historyMap[v][acc]) historyMap[v][acc] = 0;
    historyMap[v][acc]++;
  }

  res.json({ history: historyMap });
});

// 8. Agendador — enfileira posts com intervalo/humanizador

// Variável para rastrear número de tarefas ativas na memória (evita sleep)
let activeJobs = 0;

// Rota de ping para o próprio servidor se manter acordado
app.get('/api/ping', (req, res) => res.send('pong'));

// A cada 10 minutos, se houver jobs, o servidor bate em si mesmo
setInterval(() => {
  if (activeJobs > 0) {
    console.log(`[Keep-Alive] Pingando o servidor. Jobs ativos na fila: ${activeJobs}`);
    axios.get('https://iceolab-backend.onrender.com/api/ping').catch(() => {});
  }
}, 10 * 60 * 1000); // 10 minutos

app.post('/api/schedule', async (req, res) => {
  const { items, postNow, scheduledAt, intervalMode, intervalMin, intervalMax, account_id } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'Nenhum item para agendar.' });
  if (!account_id) return res.status(400).json({ error: 'Selecione uma conta para postagem.' });

  const minMs = (intervalMin || 10) * 60 * 1000;
  const maxMs = (intervalMax || 15) * 60 * 1000;
  const humanize = intervalMode === 'humanize';

  const startMs = postNow
    ? Date.now()
    : new Date(scheduledAt).getTime();

  const queue = [];
  let accumulatedDelay = 0;

  items.forEach((item, idx) => {
    if (idx > 0) {
      const gap = humanize
        ? Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
        : minMs;
      accumulatedDelay += gap;
    }

    const fireAt = startMs + accumulatedDelay;
    const delayFromNow = Math.max(0, fireAt - Date.now());

    console.log(`[Schedule] Item ${idx + 1}/${items.length} "${item.name}" → em ${Math.round(delayFromNow / 1000)}s`);

    activeJobs++; // Registra um novo job agendado

    setTimeout(async () => {
      console.log(`[Schedule] ▶ Postando "${item.name}"...`);
      try {
        const result = await postReelToInstagram(item.url, item.caption || '', account_id);
        console.log(`[Schedule] ✅ "${item.name}" publicado. Post ID: ${result.post_id}`);
      } catch (e) {
        console.error(`[Schedule] ❌ Erro em "${item.name}":`, e.message);
      } finally {
        activeJobs--; // Libera o job (em sucesso ou erro)
      }
    }, delayFromNow);

    queue.push({
      index: idx + 1,
      name: item.name,
      scheduled_at: new Date(fireAt).toISOString(),
      delay_min: Math.round(accumulatedDelay / 60000)
    });
  });

  res.json({ success: true, total: items.length, queue });
});

// Inicialização do Servidor
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 IceoLab Backend v1.0.6 Operacional`);
  console.log(`🔌 Porta: ${PORT}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? 'Conectado' : '⚠️ URL ausente!'}`);
  console.log(`🛡️  CORS: ${process.env.FRONTEND_URL}`);
  console.log(`========================================\n`);
});
