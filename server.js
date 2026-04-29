const express = require('express');
const path = require('path');
const fs = require('fs');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const cache = {};

// Redis para persistência entre deploys (opcional — funciona sem se variáveis não configuradas)
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

function hoje() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-');
}

function dataFile(filial) {
  return path.join(DATA_DIR, `${filial}.json`);
}

function histFile(filial) {
  return path.join(DATA_DIR, `${filial}_historico.csv`);
}

async function carregarRedis() {
  if (!redis) return;
  try {
    const keys = await redis.keys('filial:*');
    for (const key of keys) {
      const nome = key.replace('filial:', '');
      const dados = await redis.get(key);
      if (dados) {
        cache[nome] = typeof dados === 'string' ? JSON.parse(dados) : dados;
        if (cache[nome].repetir === undefined) cache[nome].repetir = 0;
      }
    }
    console.log(`Redis: ${keys.length} filial(is) carregada(s)`);
  } catch (e) {
    console.error('Erro ao carregar Redis:', e.message);
  }
}

function salvarRedis(filial, dados) {
  if (!redis) return;
  redis.set(`filial:${filial}`, JSON.stringify(dados)).catch(e => {
    console.error('Erro ao salvar Redis:', e.message);
  });
}

function lerDados(filial) {
  if (!cache[filial]) {
    const file = dataFile(filial);
    if (!fs.existsSync(file)) {
      cache[filial] = { senha_p: 0, senha_n: 0, ultima_geral: '', data: hoje(), orcamentos: 0, repetir: 0 };
    } else {
      cache[filial] = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cache[filial].repetir === undefined) cache[filial].repetir = 0;
    }
  }
  return cache[filial];
}

function contarHoje(filial) {
  const file = histFile(filial);
  if (!fs.existsSync(file)) return { hoje_p: 0, hoje_n: 0 };
  const hojeStr = hoje();
  let hoje_p = 0, hoje_n = 0;
  const linhas = fs.readFileSync(file, 'utf8').split('\n');
  for (const l of linhas) {
    const parts = l.split(',');
    if (!parts[0] || parts[0] === 'timestamp') continue;
    const dataLinha = new Date(parts[0]).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      .split('/').reverse().join('-');
    if (dataLinha !== hojeStr) continue;
    if (parts[1] === 'P') hoje_p++;
    if (parts[1] === 'N') hoje_n++;
  }
  return { hoje_p, hoje_n };
}

function salvarDados(filial, dados) {
  cache[filial] = dados;
  try { fs.writeFileSync(dataFile(filial), JSON.stringify(dados)); } catch (e) {}
  salvarRedis(filial, dados);
}

function registrarHistorico(filial, tipo, numero) {
  const file = histFile(filial);
  const agora = new Date().toISOString();
  const linha = `${agora},${tipo},${numero}\n`;
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, 'timestamp,tipo,numero\n' + linha);
    } else {
      fs.appendFileSync(file, linha);
    }
  } catch (e) {}
}

app.get('/dados', (req, res) => {
  const filial = req.query.filial || 'default';
  res.json(lerDados(filial));
});

app.post('/chamar', (req, res) => {
  const filial = req.query.filial || 'default';
  const { tipo } = req.body;
  const d = lerDados(filial);

  if (tipo === 'P') {
    d.senha_p++;
    d.ultima_geral = 'P' + String(d.senha_p).padStart(3, '0');
  } else {
    d.senha_n++;
    d.ultima_geral = 'N' + String(d.senha_n).padStart(3, '0');
  }

  salvarDados(filial, d);
  registrarHistorico(filial, tipo, tipo === 'P' ? d.senha_p : d.senha_n);
  res.json({ ok: true, dados: d });
});

app.post('/voltar', (req, res) => {
  const filial = req.query.filial || 'default';
  const { tipo } = req.body;
  const d = lerDados(filial);

  if (tipo === 'P' && d.senha_p > 0) d.senha_p--;
  if (tipo === 'N' && d.senha_n > 0) d.senha_n--;

  salvarDados(filial, d);
  res.json({ ok: true, dados: d });
});

app.post('/repetir', (req, res) => {
  const filial = req.query.filial || 'default';
  const d = lerDados(filial);
  if (!d.ultima_geral) return res.json({ ok: false });
  d.repetir = (d.repetir || 0) + 1;
  salvarDados(filial, d);
  res.json({ ok: true, dados: d });
});

app.post('/resetar', (req, res) => {
  const filial = req.query.filial || 'default';
  const { tipo } = req.body || {};
  const d = lerDados(filial);

  if (tipo === 'P') {
    d.senha_p = 0;
    if (d.ultima_geral.startsWith('P')) d.ultima_geral = '';
  } else if (tipo === 'N') {
    d.senha_n = 0;
    if (d.ultima_geral.startsWith('N')) d.ultima_geral = '';
  } else {
    d.senha_p = 0;
    d.senha_n = 0;
    d.ultima_geral = '';
  }

  d.repetir = (d.repetir || 0) + 1;
  d.data = hoje();
  salvarDados(filial, d);
  res.json({ ok: true, dados: d });
});

app.post('/orcamentos', (req, res) => {
  const filial = req.query.filial || 'default';
  const { quantidade } = req.body;
  const d = lerDados(filial);
  d.orcamentos = parseInt(quantidade) || 0;
  salvarDados(filial, d);
  res.json({ ok: true });
});

app.get('/historico', (req, res) => {
  const filial = req.query.filial || 'default';
  const file = histFile(filial);
  if (!fs.existsSync(file)) return res.json([]);

  const hojeStr = hoje();
  const linhas = fs.readFileSync(file, 'utf8').split('\n')
    .filter(l => {
      const ts = l.split(',')[0];
      if (!ts || ts === 'timestamp') return false;
      const dataLinha = new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        .split('/').reverse().join('-');
      return dataLinha === hojeStr;
    })
    .map(l => {
      const parts = l.split(',');
      return { ts: parts[0], tipo: parts[1], numero: parseInt(parts[2]) };
    });

  res.json(linhas);
});

app.get('/resumo', (req, res) => {
  const resumo = {};
  const filiais = new Set();

  // filiais em memória
  Object.keys(cache).forEach(f => filiais.add(f));

  // filiais em arquivo (quando existir)
  try {
    fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .forEach(f => filiais.add(f.replace('.json', '')));
  } catch (e) {}

  filiais.forEach(nome => {
    const dados = lerDados(nome);
    const { hoje_p, hoje_n } = contarHoje(nome);
    resumo[nome] = { ...dados, hoje_p, hoje_n };
  });

  res.json(resumo);
});

carregarRedis().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('  Chamador de Senhas - Santa Apolônia');
    console.log('='.repeat(50));
    console.log(`  Servidor:  http://localhost:${PORT}`);
    console.log(`  Redis:     ${redis ? 'conectado' : 'não configurado (só memória)'}`);
    console.log('='.repeat(50));
  });
});
