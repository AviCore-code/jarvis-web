/* ============================================================
   JARVIS WEB — frontend logic
   Camera preview (free, local only) + on-demand vision snapshot,
   push-to-talk voice (Groq Whisper STT -> Hermes chat -> Edge TTS),
   and a streamed text chat, all against our own backend proxy.
   ============================================================ */

(() => {
  'use strict';

  // ---------- State ----------
  let mediaStream = null;
  let camOn = false;
  let micOn = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let conversation = []; // {role, content}
  let audioCtx = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const video = $('localVideo');
  const canvas = $('captureCanvas');
  const placeholder = $('videoPlaceholder');
  const camState = $('camState');
  const micState = $('micState');
  const toggleCamBtn = $('toggleCam');
  const toggleMicBtn = $('toggleMic');
  const askVisionBtn = $('askVision');
  const pushToTalkBtn = $('pushToTalk');
  const chatLog = $('chatLog');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const connStatus = $('connStatus');
  const coreState = $('coreState');
  const waveform = $('waveform');
  const clockEl = $('clock');
  const latencyEl = $('latency');

  // ---------- Clock ----------
  function tickClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('th-TH', { hour12: false });
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ---------- Particle background ----------
  const pCanvas = $('particles');
  const pCtx = pCanvas.getContext('2d');
  let particles = [];
  function resizeParticles() {
    pCanvas.width = window.innerWidth;
    pCanvas.height = window.innerHeight;
  }
  function initParticles() {
    resizeParticles();
    const count = Math.floor((window.innerWidth * window.innerHeight) / 18000);
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * pCanvas.width,
      y: Math.random() * pCanvas.height,
      r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      a: Math.random() * 0.6 + 0.2,
    }));
  }
  function drawParticles() {
    pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
    pCtx.fillStyle = 'rgba(78,225,255,0.8)';
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = pCanvas.width; if (p.x > pCanvas.width) p.x = 0;
      if (p.y < 0) p.y = pCanvas.height; if (p.y > pCanvas.height) p.y = 0;
      pCtx.globalAlpha = p.a;
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      pCtx.fill();
    }
    pCtx.globalAlpha = 1;
    requestAnimationFrame(drawParticles);
  }
  window.addEventListener('resize', resizeParticles);
  initParticles();
  drawParticles();

  // ---------- Chat log rendering ----------
  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }
  function setCoreState(state) {
    coreState.textContent = state;
  }
  function setConnStatus(state, label) {
    connStatus.className = `status-pill ${state}`;
    connStatus.querySelector('span:last-child').textContent = label;
  }

  // health check
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.ok && data.hermesConfigured) {
        setConnStatus('online', 'JARVIS ONLINE');
      } else {
        setConnStatus('error', 'CONFIG MISSING');
      }
    } catch {
      setConnStatus('error', 'OFFLINE');
    }
  }
  checkHealth();
  setInterval(checkHealth, 20000);

  // ---------- Camera ----------
  async function enableCamera() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      video.srcObject = mediaStream;
      camOn = true;
      placeholder.classList.add('hidden');
      camState.textContent = 'CAM ON';
      camState.classList.remove('off'); camState.classList.add('on');
      toggleCamBtn.classList.add('active');
      addMessage('system', '📷 เปิดกล้องแล้ว — Jarvis จะไม่เห็นภาพจนกว่าคุณจะกด "ให้ดูภาพ"');
    } catch (err) {
      addMessage('system', 'ไม่สามารถเปิดกล้องได้: ' + err.message);
    }
  }
  function disableCamera() {
    if (mediaStream) {
      mediaStream.getVideoTracks().forEach((t) => t.stop());
    }
    camOn = false;
    video.srcObject = null;
    placeholder.classList.remove('hidden');
    camState.textContent = 'CAM OFF';
    camState.classList.remove('on'); camState.classList.add('off');
    toggleCamBtn.classList.remove('active');
  }
  toggleCamBtn.addEventListener('click', () => (camOn ? disableCamera() : enableCamera()));

  // ---------- Vision snapshot (on-demand only — cost-controlled) ----------
  askVisionBtn.addEventListener('click', async () => {
    if (!camOn) {
      addMessage('system', 'กรุณาเปิดกล้องก่อนครับ');
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    addMessage('user', '📸 [ส่งภาพให้ Jarvis ดู]');
    setCoreState('ANALYZING');
    const t0 = performance.now();
    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: dataUrl, question: 'คุณเห็นอะไรในภาพนี้บ้าง อธิบายสั้นๆ เป็นภาษาไทย' }),
      });
      const data = await res.json();
      latencyEl.textContent = `LATENCY ${Math.round(performance.now() - t0)}ms`;
      if (data.reply) {
        addMessage('assistant', data.reply);
        speak(data.reply);
      } else {
        addMessage('system', 'เกิดข้อผิดพลาด: ' + (data.error || 'unknown'));
      }
    } catch (err) {
      addMessage('system', 'เชื่อมต่อไม่สำเร็จ: ' + err.message);
    }
    setCoreState('STANDBY');
  });

  // ---------- Microphone toggle (enables push-to-talk) ----------
  async function enableMic() {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // merge into mediaStream if camera already running, else keep separate
      window.__jarvisAudioStream = audioStream;
      micOn = true;
      micState.textContent = 'MIC ON';
      micState.classList.remove('off'); micState.classList.add('on');
      toggleMicBtn.classList.add('active');
      addMessage('system', '🎙️ เปิดไมค์แล้ว — กดปุ่ม "กดค้างเพื่อพูด" เพื่อคุย');
    } catch (err) {
      addMessage('system', 'ไม่สามารถเปิดไมค์ได้: ' + err.message);
    }
  }
  function disableMic() {
    if (window.__jarvisAudioStream) {
      window.__jarvisAudioStream.getTracks().forEach((t) => t.stop());
      window.__jarvisAudioStream = null;
    }
    micOn = false;
    micState.textContent = 'MIC OFF';
    micState.classList.remove('on'); micState.classList.add('off');
    toggleMicBtn.classList.remove('active');
  }
  toggleMicBtn.addEventListener('click', () => (micOn ? disableMic() : enableMic()));

  // ---------- Push to talk ----------
  function startRecording() {
    if (!micOn || !window.__jarvisAudioStream) {
      addMessage('system', 'กรุณาเปิดไมค์ก่อนครับ');
      return;
    }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(window.__jarvisAudioStream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();
    isRecording = true;
    pushToTalkBtn.classList.add('active');
    waveform.classList.add('active');
    setCoreState('LISTENING');
  }
  function stopRecording() {
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
      pushToTalkBtn.classList.remove('active');
      waveform.classList.remove('active');
    }
  }
  pushToTalkBtn.addEventListener('mousedown', startRecording);
  pushToTalkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
  pushToTalkBtn.addEventListener('mouseup', stopRecording);
  pushToTalkBtn.addEventListener('mouseleave', () => { if (isRecording) stopRecording(); });
  pushToTalkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });

  async function handleRecordingStop() {
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    if (blob.size < 1000) return; // too short, ignore
    setCoreState('TRANSCRIBING');
    const form = new FormData();
    form.append('audio', blob, 'audio.webm');
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      const data = await res.json();
      if (data.text && data.text.trim()) {
        chatInput.value = data.text.trim();
        submitChat(data.text.trim());
      } else {
        setCoreState('STANDBY');
      }
    } catch (err) {
      addMessage('system', 'แปลงเสียงไม่สำเร็จ: ' + err.message);
      setCoreState('STANDBY');
    }
  }

  // ---------- Text-to-speech playback ----------
  async function speak(text) {
    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      setCoreState('SPEAKING');
      waveform.classList.add('active');
      audio.onended = () => { setCoreState('STANDBY'); waveform.classList.remove('active'); URL.revokeObjectURL(url); };
      audio.play();
    } catch { /* non-fatal */ }
  }

  // ---------- Chat (streamed) ----------
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    submitChat(text);
  });

  async function submitChat(text) {
    addMessage('user', text);
    conversation.push({ role: 'user', content: text });
    setCoreState('THINKING');

    const assistantDiv = addMessage('assistant', '');
    let fullText = '';
    const t0 = performance.now();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversation }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        assistantDiv.textContent = 'เกิดข้อผิดพลาด: ' + (errData.error || res.statusText);
        setCoreState('STANDBY');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      setCoreState('SPEAKING');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullText += delta;
              assistantDiv.textContent = fullText;
              chatLog.scrollTop = chatLog.scrollHeight;
            }
          } catch { /* ignore partial json */ }
        }
      }

      latencyEl.textContent = `LATENCY ${Math.round(performance.now() - t0)}ms`;
      conversation.push({ role: 'assistant', content: fullText });
      if (fullText) speak(fullText);
    } catch (err) {
      assistantDiv.textContent = 'เชื่อมต่อไม่สำเร็จ: ' + err.message;
    }
    setCoreState('STANDBY');
  }

  // ---------- Welcome ----------
  addMessage('system', 'ระบบพร้อมใช้งาน — พิมพ์ข้อความ หรือเปิดกล้อง/ไมค์เพื่อเริ่มคุยกับ Jarvis');
})();
