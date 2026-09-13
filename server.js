/**
 * Jarvis Web — backend proxy server.
 *
 * Bridges a browser (camera + mic UI) to the Hermes Agent API Server
 * (OpenAI-compatible endpoint running on this same VPS, port 8642 by
 * default). Chat/tool calls run inside the FULL Jarvis agent (memory,
 * skills, Oracle) — not a bare LLM call — because we proxy straight into
 * Hermes's own API server rather than calling Anthropic directly.
 *
 * Endpoints:
 *   GET  /                      -> static frontend
 *   POST /api/chat              -> forwards to Hermes /v1/chat/completions (SSE streamed)
 *   POST /api/vision            -> forwards an image + question to Hermes as a vision message
 *   POST /api/transcribe        -> forwards recorded audio to Groq Whisper (STT)
 *   POST /api/speak             -> Edge TTS text-to-speech, returns audio/mpeg
 */
'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = process.env.JARVIS_WEB_PORT || 3001;
const HERMES_API_BASE = process.env.HERMES_API_BASE || 'http://127.0.0.1:8642/v1';
const HERMES_API_KEY = process.env.HERMES_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || 'th-TH-NiwatNeural';

if (!HERMES_API_KEY) {
  console.error('[jarvis-web] WARNING: HERMES_API_KEY is not set — /api/chat and /api/vision will fail.');
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Chat: forwards to Hermes Agent's OpenAI-compatible endpoint, streamed ---
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages[] is required' });
  }

  try {
    const upstream = await fetch(`${HERMES_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HERMES_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: 'Hermes API error', detail: text });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('[jarvis-web] /api/chat error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Vision: send a single camera snapshot + a question, non-streamed ---
app.post('/api/vision', async (req, res) => {
  const { imageDataUrl, question } = req.body;
  if (!imageDataUrl) return res.status(400).json({ error: 'imageDataUrl is required' });

  try {
    const upstream = await fetch(`${HERMES_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HERMES_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: question || 'ดูภาพนี้แล้วบอกว่าเห็นอะไรบ้าง' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Hermes API error', detail: data });
    const reply = data?.choices?.[0]?.message?.content || '';
    res.json({ reply });
  } catch (err) {
    console.error('[jarvis-web] /api/vision error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Speech-to-text via Groq Whisper ---
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file is required' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', req.file.buffer, { filename: 'audio.webm', contentType: req.file.mimetype });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'th');

    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
      body: form,
    });

    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Groq API error', detail: data });
    res.json({ text: data.text || '' });
  } catch (err) {
    console.error('[jarvis-web] /api/transcribe error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Text-to-speech via edge-tts (shells out to the `edge-tts` python package) ---
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const tmpFile = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);

  const proc = spawn(process.env.EDGE_TTS_BIN || 'edge-tts', [
    '--voice', EDGE_TTS_VOICE,
    '--text', text,
    '--write-media', tmpFile,
  ]);

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(tmpFile)) {
      console.error('[jarvis-web] edge-tts failed:', stderr);
      return res.status(500).json({ error: 'TTS failed', detail: stderr });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(tmpFile, () => {}));
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, hermesConfigured: !!HERMES_API_KEY, groqConfigured: !!GROQ_API_KEY }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-web] listening on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-web] Hermes API base: ${HERMES_API_BASE}`);
});
