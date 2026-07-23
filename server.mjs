import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadConfig() {
  const defaults = {
    port: 3456,
    sources: { opencode: '~/.local/share/opencode/opencode.db', claude: '~/.claude/projects' }
  };
  let cfg = defaults;
  const cfgPath = join(__dirname, 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      cfg = deepMerge(defaults, parsed);
    } catch (e) {
      console.warn(`配置文件解析失败，使用默认值: ${e.message}`);
    }
  }
  return {
    port: process.env.PORT || cfg.port,
    opencodeDB: expand(process.env.OPENCODE_DB || cfg.sources.opencode),
    claudeDir: expand(process.env.CLAUDE_DIR || cfg.sources.claude)
  };
}

function expand(path) {
  return path.replace(/^~/, homedir());
}

function validateDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

const CONFIG = loadConfig();

async function parseClaude(since, until) {
  const entries = [];
  if (!existsSync(CONFIG.claudeDir)) return entries;
  let projectDirs = [];
  try {
    projectDirs = readdirSync(CONFIG.claudeDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch (e) {
    console.warn(`读取 Claude 目录失败: ${e.message}`);
    return entries;
  }

  for (const pdir of projectDirs) {
    const projPath = join(CONFIG.claudeDir, pdir.name);
    const home = homedir();
    const projName = pdir.name
      .replace(new RegExp('^' + home.replace(/\//g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '')
      .replace(/^-/, '')
      .replace(/-/g, '/')
      .replace(/^\//, '~/');

    let files = [];
    try { files = readdirSync(projPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const f of files) {
      const fp = join(projPath, f);
      try {
        const rl = createInterface({ input: createReadStream(fp, 'utf-8'), crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type !== 'assistant') continue;
          const ts = new Date(obj.timestamp).getTime();
          if (ts < since || ts > until) continue;
          const u = obj.message?.usage;
          if (!u || (!u.input_tokens && !u.output_tokens)) continue;
          entries.push({
            source: 'claude',
            model: obj.message?.model || 'unknown',
            project: projName,
            timestamp: new Date(obj.timestamp).toISOString(),
            input: u.input_tokens || 0,
            output: u.output_tokens || 0,
            cache_read: u.cache_read_input_tokens || 0,
            cache_write: u.cache_creation_input_tokens || 0,
            total: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          });
        }
      } catch (e) {
        console.warn(`解析 Claude 文件失败 ${fp}: ${e.message}`);
      }
    }
  }
  return entries;
}

function queryOpenCode(since, until) {
  if (!existsSync(CONFIG.opencodeDB)) {
    return { totals: { msg_count: 0, sessions: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0, activeDays: 0 }, daily: [], models: [], editStats: [], lastUpdate: 'N/A' };
  }

  let db;
  try {
    db = new DatabaseSync(CONFIG.opencodeDB, { readonly: true });
  } catch (e) {
    console.warn(`打开 openCode 数据库失败: ${e.message}`);
    return { totals: { msg_count: 0, sessions: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0, activeDays: 0 }, daily: [], models: [], editStats: [], lastUpdate: 'N/A' };
  }

  try {
    const daily = db.prepare(`
      SELECT date(time_created/1000, 'unixepoch') as day,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.total'), '0') AS INTEGER)) as tokens
      FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL AND time_created >= ? AND time_created <= ?
      GROUP BY day ORDER BY day
    `).all(since, until);

    const models = db.prepare(`
      SELECT 
        COALESCE(json_extract(data, '$.modelID'), 'unknown') as model,
        COALESCE(json_extract(data, '$.providerID'), 'unknown') as provider,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.input'), '0') AS INTEGER)) as input,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.output'), '0') AS INTEGER)) as output,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.reasoning'), '0') AS INTEGER)) as reasoning,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.cache.read'), '0') AS INTEGER)) as cache_read,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.cache.write'), '0') AS INTEGER)) as cache_write,
        SUM(CAST(COALESCE(json_extract(data, '$.tokens.total'), '0') AS INTEGER)) as total_tokens,
        ROUND(SUM(CAST(COALESCE(json_extract(data, '$.cost'), '0') AS REAL)), 6) as cost,
        COUNT(*) as msg_count
      FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL AND time_created >= ? AND time_created <= ?
      GROUP BY model, provider ORDER BY total_tokens DESC
    `).all(since, until);

    const totals = db.prepare(`
      SELECT 
        COUNT(*) as msg_count,
        COUNT(DISTINCT session_id) as sessions,
        COALESCE(SUM(CAST(json_extract(data, '$.tokens.input') AS INTEGER)), 0) as input,
        COALESCE(SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)), 0) as output,
        COALESCE(SUM(CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER)), 0) as reasoning,
        COALESCE(SUM(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER)), 0) as cache_read,
        COALESCE(SUM(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER)), 0) as cache_write,
        COALESCE(SUM(CAST(json_extract(data, '$.tokens.total') AS INTEGER)), 0) as total,
        ROUND(SUM(CAST(COALESCE(json_extract(data, '$.cost'), '0') AS REAL)), 4) as cost
      FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL AND time_created >= ? AND time_created <= ?
    `).get(since, until);

    const activeDays = db.prepare(`
      SELECT COUNT(DISTINCT date(time_created/1000, 'unixepoch')) as cnt
      FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL AND time_created >= ? AND time_created <= ?
    `).get(since, until);

    const editStats = db.prepare(`
      SELECT 
        json_extract(m.data, '$.modelID') as model,
        json_extract(m.data, '$.providerID') as provider,
        SUM(CASE WHEN json_extract(p.data, '$.state.status') = 'completed' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN json_extract(p.data, '$.state.status') = 'error' THEN 1 ELSE 0 END) as failed
      FROM part p
      JOIN message m ON p.message_id = m.id
      WHERE json_extract(p.data, '$.type') = 'tool'
        AND json_extract(p.data, '$.tool') IN ('edit', 'write')
        AND m.time_created >= ? AND m.time_created <= ?
      GROUP BY model, provider
      HAVING success + failed > 0
      ORDER BY success DESC
    `).all(since, until);

    const lastMsg = db.prepare(`
      SELECT datetime(time_created/1000, 'unixepoch') as last_ts
      FROM message WHERE json_extract(data, '$.tokens') IS NOT NULL ORDER BY time_created DESC LIMIT 1
    `).get();

    return { totals: { ...totals, activeDays: activeDays.cnt }, daily, models, editStats, lastUpdate: lastMsg?.last_ts || 'N/A' };
  } finally {
    db.close();
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function shouldCompress(req) {
  const ae = req.headers['accept-encoding'] || '';
  return ae.includes('gzip');
}

function gzipResponse(content, res, extraHeaders = {}) {
  const compressed = gzipSync(content);
  res.writeHead(res.statusCode, {
    ...extraHeaders,
    'Content-Encoding': 'gzip',
    'Content-Length': compressed.length,
  });
  res.end(compressed);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);

  if (url.pathname === '/chart.js') {
    try {
      const content = readFileSync(join(__dirname, 'node_modules/chart.js/dist/chart.umd.js'));
      if (shouldCompress(req)) {
        res.statusCode = 200;
        gzipResponse(content, res, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600' });
        res.end(content);
      }
    } catch (e) {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  if (url.pathname === '/api/data') {
    const since = url.searchParams.get('since') || `${new Date().getFullYear()}-01-01`;
    const until = url.searchParams.get('until') || '2099-12-31';
    const source = url.searchParams.get('source') || 'all';

    if (!validateDate(since) || !validateDate(until)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效的日期格式，请使用 YYYY-MM-DD' }));
      return;
    }

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime() + 86400000;

    if (sinceMs >= untilMs) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '起始日期必须早于结束日期' }));
      return;
    }

    try {
      const result = { sources: {}, refreshedAt: new Date().toISOString() };

      if (source === 'all' || source === 'opencode') {
        const oc = queryOpenCode(sinceMs, untilMs);
        const claudeEntries = await parseClaude(sinceMs, untilMs);

        if (claudeEntries.length > 0) {
          const claudeModels = {};
          const claudeDaily = {};
          claudeEntries.forEach(e => {
            const k = e.model;
            if (!claudeModels[k]) claudeModels[k] = { model: e.model, provider: 'claude', input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0, msg_count: 0 };
            claudeModels[k].input += e.input;
            claudeModels[k].output += e.output;
            claudeModels[k].cache_read += e.cache_read;
            claudeModels[k].cache_write += e.cache_write;
            claudeModels[k].total_tokens += e.total;
            claudeModels[k].msg_count += 1;
            const day = e.timestamp.slice(0, 10);
            claudeDaily[day] = (claudeDaily[day] || 0) + e.total;
          });
          const dailyMap = {};
          oc.daily.forEach(d => { dailyMap[d.day] = d.tokens; });
          Object.entries(claudeDaily).forEach(([day, tokens]) => {
            dailyMap[day] = (dailyMap[day] || 0) + tokens;
          });
          oc.daily = Object.entries(dailyMap).map(([day, tokens]) => ({ day, tokens })).sort((a, b) => a.day.localeCompare(b.day));
          oc.claudeModels = Object.values(claudeModels).sort((a, b) => b.total_tokens - a.total_tokens);
          oc.claudeTotal = claudeEntries.reduce((s, e) => s + e.total, 0);
        }

        result.sources.opencode = oc;
      }

      const json = JSON.stringify(result);
      if (shouldCompress(req)) {
        res.statusCode = 200;
        gzipResponse(Buffer.from(json), res, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(json);
      }
    } catch (err) {
      console.error(`API 错误: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), opencodeDB: existsSync(CONFIG.opencodeDB), claudeDir: existsSync(CONFIG.claudeDir) }));
    return;
  }

  try {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (shouldCompress(req)) {
    res.statusCode = 200;
    gzipResponse(Buffer.from(html), res, { 'Content-Type': 'text/html; charset=utf-8' });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(CONFIG.port, () => {
  console.log(`\n  AI Coding Dashboard`);
  console.log(`  ─────────────────`);
  console.log(`  http://localhost:${CONFIG.port}`);
  console.log(`  数据源: openCode${existsSync(CONFIG.opencodeDB) ? ' ✓' : ' ✗'}  Claude${existsSync(CONFIG.claudeDir) ? ' ✓' : ' ✗'}\n`);
});
