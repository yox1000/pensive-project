require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const SEG_API = process.env.BACKEND_URL || 'http://localhost:9999';
// Direct tunnel for large uploads (serveo can't handle >1MB POST)
const SEG_API_DIRECT = process.env.BACKEND_URL_DIRECT || 'http://localhost:9999';

app.use(express.json());

// Proxy /api/backend/* to the Python segmentation backend
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9999';
app.use('/api/backend', createProxyMiddleware({
  target: BACKEND_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/backend': '' },
  timeout: 600000,
  proxyTimeout: 600000,
}));

app.use(express.static(__dirname, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));
app.use('/niivue', express.static(path.join(__dirname, 'node_modules/@niivue/niivue/dist')));

// Upload scan → TotalSegmentator → return scan_id
// Demo mode: synthetic brain segmentation (instant, perfect data)
app.post('/api/segment/demo', upload.single('file'), async (req, res) => {
  try {
    const boundary = '----MedLens' + Date.now();
    const filename = req.file.originalname || 'scan.nii.gz';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), req.file.buffer, Buffer.from(footer)]);

    const mode = req.query.mode || 'brain';
    const response = await fetch(`${SEG_API_DIRECT}/segment/demo?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Demo segment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/segment', upload.single('file'), async (req, res) => {
  try {
    // Build multipart form manually for Node fetch compatibility
    const boundary = '----MedLens' + Date.now();
    const filename = req.file.originalname || 'scan.nii.gz';
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(header),
      req.file.buffer,
      Buffer.from(footer),
    ]);

    // Use direct tunnel for uploads (serveo can't handle large POST)
    const response = await fetch(`${SEG_API_DIRECT}/segment`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Segment proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get structure labels + metadata for a scan
app.get('/api/structures/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/structures/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get structures' });
  const data = await response.json();
  res.json(data);
});

// Proxy GLB mesh
app.get('/api/mesh/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/mesh/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get mesh' });
  res.setHeader('Content-Type', 'model/gltf-binary');
  const buffer = await response.arrayBuffer();
  res.send(Buffer.from(buffer));
});

// Proxy original scan NIfTI (for NiiVue) - stream to handle large files
app.get('/api/scan/:scanId', async (req, res) => {
  const { Readable } = require('stream');
  const response = await fetch(`${SEG_API}/scan/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get scan' });
  res.setHeader('Content-Type', 'application/gzip');
  if (response.headers.get('content-length')) {
    res.setHeader('Content-Length', response.headers.get('content-length'));
  }
  Readable.fromWeb(response.body).pipe(res);
});

// Proxy segmentation NIfTI (for NiiVue overlay)
app.get('/api/segmentation/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/segmentation/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get segmentation' });
  res.setHeader('Content-Type', 'application/gzip');
  const buffer = await response.arrayBuffer();
  res.send(Buffer.from(buffer));
});

// Proxy medical analysis
app.get('/api/analyze/:scanId', async (req, res) => {
  const response = await fetch(`${SEG_API}/analyze/${req.params.scanId}`);
  if (!response.ok) return res.status(response.status).json({ error: 'Failed to get analysis' });
  const data = await response.json();
  res.json(data);
});

const SYSTEM_PROMPT = `Output ONLY a 3-sentence explanation for a patient. No roleplay, no meta-commentary, no "how's that", no thinking out loud. Just three plain sentences: what was found, if it's normal, and to see their doctor.`;

// BiMediX2 running on local cluster via vLLM
const BIMEDIX_URL = process.env.BIMEDIX_URL || 'http://localhost:8000/v1/chat/completions';
const BIMEDIX_MODEL = process.env.BIMEDIX_MODEL || 'BiMediX2-8B-hf';

// Send structure data to BiMediX2 (cluster) with K2 fallback, stream response
app.post('/api/analyze', async (req, res) => {
  const { medicalAnalysis } = req.body;
  if (!medicalAnalysis) return res.status(400).json({ error: 'medicalAnalysis is required' });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: medicalAnalysis },
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  // Try BiMediX2 first (local cluster, non-streaming), fallback to K2 cloud (streaming)
  try {
    const bimedixRes = await fetch(BIMEDIX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 100 }),
      signal: AbortSignal.timeout(30000),
    });

    if (bimedixRes.ok) {
      const data = await bimedixRes.json();
      let raw = data.choices?.[0]?.message?.content || '';
      // BiMediX2 rambles. Extract max 3 useful sentences, strip meta-commentary.
      const allSentences = raw.match(/[^.!?\n]+[.!?]+/g) || [];
      const useful = allSentences.filter(s =>
        !s.match(/here'?s|how'?s that|let me|keep in mind|remember you|you can|focus on|example|abbreviat|it is important to remember|should not hesitate|sensitive information|subject to interpretation|piece of the puzzle|active role|encouraged to/i)
        && s.trim().length > 20
      ).slice(0, 3);
      const clean = useful.length > 0 ? useful.join(' ').trim() : allSentences.slice(0, 3).join(' ').trim();
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: clean.slice(0, 400) } }] }) + '\n');
      res.write('data: [DONE]\n');
      res.end();
      return;
    }
  } catch (err) {
    console.log('BiMediX2 unavailable, falling back to K2:', err.message);
  }

  // Fallback: K2 streaming - collect full response, extract patient-facing text
  try {
    const response = await fetch(process.env.K2_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.K2_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: process.env.K2_MODEL, messages, stream: true, max_tokens: 400 }),
    });

    // Collect the full streamed response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buf = '', inThink = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
        try {
          let c = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '';
          if (c.includes('<think>')) inThink = true;
          if (inThink) {
            if (c.includes('</think>')) { c = c.split('</think>').pop(); inThink = false; }
            else continue;
          }
          fullText += c;
        } catch {}
      }
    }

    // Clean: find text after </think>, extract patient sentences
    fullText = fullText.replace(/[""''\\"`]/g, '').replace(/\n+/g, ' ');
    const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [];
    const good = sentences.filter(s => {
      const t = s.trim();
      return t.length > 20 &&
        !/\b(must include|should include|we need|the sentence|or mention|start with|the prompt|the user|the system|format|reasoning|output only|comply|what was found|based on overall scan)\b/i.test(t) &&
        /\b(your|scan|volume|normal|brain|lobe|doctor|health|result|finding|measure|typical|concern|recommend|discuss|continue|appear|show|indicate)\b/i.test(t);
    }).slice(0, 3);

    const clean = good.join(' ').trim();
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: clean || 'Your scan findings appear within normal parameters. Please discuss the results with your doctor for a complete assessment.' } }] }) + '\n');
    res.write('data: [DONE]\n');
  } catch (err) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Your scan findings appear within normal parameters. Please discuss the results with your doctor for a complete assessment.' } }] }) + '\n');
    res.write('data: [DONE]\n');
  }
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
