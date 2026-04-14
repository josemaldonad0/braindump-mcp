import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.API_KEY || '';
const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

const braindumpDir = path.join(process.cwd(), 'braindump');

if (!fs.existsSync(braindumpDir)) {
  fs.mkdirSync(braindumpDir, { recursive: true });
}

app.use(bodyParser.json());

// healthcheck
app.get('/', (req, res) => {
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// Public healthcheck just for connector validation
app.get('/perplexity-health', (req, res) => {
  res.json({ ok: true });
});

// Public healthcheck FIRST (no auth)
// Perplexity validation endpoint: JSON-RPC-shaped response, no auth
app.post('/perplexity-health', (req, res) => {
  res.json({
    jsonrpc: "2.0",
    id: null,
    result: { ok: true }
  });
});

// Simple API key auth
app.use((req, res, next) => {
  if (!apiKey) return next();
  const headerKey = req.headers['x-api-key'];
  if (headerKey !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});



// Helpers
function loadDomain(domainId) {
  const filePath = path.join(braindumpDir, `${domainId}.md`);
  if (!fs.existsSync(filePath)) return { filePath, content: '' };
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
}

function saveDomain(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function domainUrl(domainId) {
  return `${publicBaseUrl}/braindump/${domainId}`;
}

// GET /braindump/:domain_id – serve markdown as plain text
app.get('/braindump/:domain_id', (req, res) => {
  const domainId = req.params.domain_id;
  const { content } = loadDomain(domainId);
  if (!content) return res.status(404).send('Not found');
  res.type('text/plain').send(content);
});

// ---- Tool handlers ----

// dump_context
function handleDumpContext(params) {
  const { domain_id, dump } = params || {};
  if (!domain_id || !dump || !dump.title || !dump.summary) {
    return { error: 'domain_id, dump.title and dump.summary are required' };
  }

  const now = new Date().toISOString();
  const { filePath, content } = loadDomain(domain_id);

  const dumpId = `${Date.now()}`;
  const section = [
    `## Dump ${dumpId} – ${now} – ${dump.title}`,
    '',
    '**Summary**',
    `- ${dump.summary}`,
    ''
  ];

  const pushList = (label, items) => {
    if (Array.isArray(items) && items.length) {
      section.push(`**${label}**`);
      items.forEach(i => section.push(`- ${i}`));
      section.push('');
    }
  };

  pushList('Decisions', dump.decisions);
  pushList('Facts', dump.facts);
  pushList('Actions', dump.actions);
  pushList('Questions', dump.questions);

  if (dump.metadata && Object.keys(dump.metadata).length) {
    section.push('**Metadata**');
    Object.entries(dump.metadata).forEach(([k, v]) => {
      section.push(`- ${k}: ${v}`);
    });
    section.push('');
  }

  let newContent = content;
  if (!content) {
    newContent = `# Domain: ${domain_id}\n\n## Dumps\n\n`;
  }
  newContent += section.join('\n') + '\n';

  saveDomain(filePath, newContent);

  return { dump_id: dumpId, note_url: domainUrl(domain_id) };
}

// get_domain_note
function handleGetDomainNote(params) {
  const { domain_id } = params || {};
  if (!domain_id) return { error: 'domain_id is required' };
  const { content } = loadDomain(domain_id);
  const url = domainUrl(domain_id);
  if (!content) return { error: 'Domain not found', note_url: url };
  return { markdown: content, note_url: url };
}

// search_dumps (very naive text search)
function handleSearchDumps(params) {
  const { domain_id, query, limit = 3 } = params || {};
  if (!domain_id || !query) return { error: 'domain_id and query are required' };
  const { content } = loadDomain(domain_id);
  const url = domainUrl(domain_id);
  if (!content) return { dumps: [], note_url: url };

  const lines = content.split('\n');
  const dumps = [];
  let current = null;

  lines.forEach(line => {
    const m = line.match(/^## Dump (\d+) – (.+?) – (.+)$/);
    if (m) {
      if (current) dumps.push(current);
      current = {
        dump_id: m[1],
        created_at: m[2],
        title: m[3],
        raw: line + '\n'
      };
    } else if (current) {
      current.raw += line + '\n';
    }
  });
  if (current) dumps.push(current);

  const q = query.toLowerCase();
  const relevant = dumps
    .map(d => ({
      ...d,
      score: d.raw.toLowerCase().includes(q) ? 1 : 0
    }))
    .filter(d => d.score > 0)
    .slice(0, limit);

  return {
    dumps: relevant.map(d => ({
      dump_id: d.dump_id,
      title: d.title,
      summary: '', // could parse from raw if needed
      created_at: d.created_at
    })),
    note_url: url
  };
}

// MCP-like entrypoint: POST /mcp/tools/invoke
app.post('/mcp/tools/invoke', (req, res) => {
  const { tool, params } = req.body || {};
  let result;

  if (tool === 'dump_context') {
    result = handleDumpContext(params);
  } else if (tool === 'get_domain_note') {
    result = handleGetDomainNote(params);
  } else if (tool === 'search_dumps') {
    result = handleSearchDumps(params);
  } else {
    result = { error: 'Unknown tool' };
  }

  res.json(result);
});

app.listen(port, () => {
  console.log(`braindump MCP server listening on port ${port}`);
});
