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
  let analyser = null;
  let analyserData = null;
  let vadFrame = null;
  let voiceStartAt = 0;
  let silenceStartAt = 0;
  let recordingStartedAt = 0;
  let jarvisSpeaking = false;
  let autoListen = true;
  let textEnabled = false;
  let pendingListenAfterVision = false;
  let audioUnlocked = false;

  const VAD_START_THRESHOLD = 0.035;
  const VAD_STOP_THRESHOLD = 0.018;
  const VAD_START_HOLD_MS = 120;
  const VAD_SILENCE_HOLD_MS = 1400;
  const VAD_MIN_RECORD_MS = 450;

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
  const toggleChatPanelBtn = $('toggleChatPanel');
  const voiceSensor = $('voiceSensor');
  const sensorLabel = $('sensorLabel');
  const unlockAudioBtn = $('unlockAudio');
  const jarvisAudioEl = $('jarvisAudio');
  const eqBars = Array.from(document.querySelectorAll('#eqBars span'));
  const cyborgFace = $('cyborgFace');
  const browLeftEl = $('browLeft');
  const browRightEl = $('browRight');
  const mouthBarEls = Array.from(document.querySelectorAll('#mouthBars .mouth-bar'));

  // ---------- Cyborg face: state -> expression, mouth reacts to audio ----------
  const BROW_SHAPES = {
    standby:   ['M58 68 L88 74', 'M112 74 L142 68'],
    listening: ['M58 66 L88 71', 'M112 71 L142 66'],
    thinking:  ['M58 71 L88 66', 'M112 66 L142 71'],
    speaking:  ['M58 68 L88 74', 'M112 74 L142 68'],
    analyzing: ['M58 70 L88 68', 'M112 68 L142 70'],
    error:     ['M58 74 L88 68', 'M112 68 L142 74'],
  };
  function setFaceState(state) {
    if (!cyborgFace) return;
    const key = BROW_SHAPES[state] ? state : 'standby';
    cyborgFace.dataset.state = key;
    if (browLeftEl && browRightEl) {
      browLeftEl.setAttribute('d', BROW_SHAPES[key][0]);
      browRightEl.setAttribute('d', BROW_SHAPES[key][1]);
    }
  }
  let mouthRAF = null;
  let mouthLevel = 0; // 0..1 target amplitude driving the mouth bars
  function animateMouth() {
    const t = performance.now() / 1000;
    mouthBarEls.forEach((bar, i) => {
      const wobble = (Math.sin(t * 9 + i * 1.3) + 1) / 2; // 0..1 per-bar jitter
      const idle = 0.32; // small idle movement even at rest so it never looks frozen
      const scale = idle + mouthLevel * (0.45 + wobble * 0.75);
      bar.style.transform = `scaleY(${Math.max(0.12, Math.min(1.15, scale))})`;
      bar.style.opacity = String(Math.max(0.35, Math.min(1, 0.4 + mouthLevel * 0.8)));
    });
    mouthRAF = requestAnimationFrame(animateMouth);
  }
  animateMouth();
  setFaceState('standby');


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
    const map = {
      STANDBY: 'standby', LISTENING: 'listening', TRANSCRIBING: 'thinking',
      THINKING: 'thinking', SPEAKING: 'speaking', ANALYZING: 'analyzing',
    };
    setFaceState(map[state] || 'standby');
  }
  function setConnStatus(state, label) {
    connStatus.className = `status-pill ${state}`;
    connStatus.querySelector('span:last-child').textContent = label;
  }

  function setSensorState(state, label) {
    if (!voiceSensor || !sensorLabel) return;
    voiceSensor.className = `voice-sensor ${state || ''}`.trim();
    sensorLabel.textContent = label;
  }

  function updateEq(level = 0) {
    if (!eqBars.length) return;
    const now = performance.now() / 180;
    eqBars.forEach((bar, i) => {
      const wave = (Math.sin(now + i * 0.85) + 1) / 2;
      const jitter = 0.55 + wave * 0.45;
      const h = Math.max(6, Math.min(100, (level * 120 * jitter) + (micOn ? 5 : 2)));
      bar.style.height = `${h}%`;
      bar.style.opacity = String(Math.max(0.28, Math.min(1, 0.25 + level * 5)));
    });
    // While the user is talking (not Jarvis), let the mouth react to mic input
    // too so the face feels alive even before a reply starts playing back.
    if (!jarvisSpeaking) mouthLevel = Math.max(0, Math.min(1, level * 6));
  }

  function setTextEnabled(enabled) {
    textEnabled = enabled;
    document.body.classList.toggle('text-disabled', !enabled);
    if (toggleChatPanelBtn) {
      toggleChatPanelBtn.textContent = enabled ? 'TEXT ON' : 'TEXT OFF';
      toggleChatPanelBtn.classList.toggle('off', !enabled);
      toggleChatPanelBtn.title = enabled
        ? 'ปิดหน้าต่างข้อความและหยุด audio-to-text'
        : 'เปิดหน้าต่างข้อความและ audio-to-text';
    }
    if (!enabled) {
      chatInput.value = '';
      setSensorState(micOn ? 'ready' : '', micOn ? 'VOICE SENSOR READY · TEXT HIDDEN' : 'VOICE SENSOR STANDBY');
    } else {
      setSensorState(micOn ? 'ready' : '', micOn ? 'VOICE SENSOR READY' : 'VOICE SENSOR STANDBY');
    }
  }

  toggleChatPanelBtn?.addEventListener('click', () => setTextEnabled(!textEnabled));

  // health check
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.ok && data.hermesConfigured) {
        setConnStatus('online', 'JARVIS ONLINE');
        if (cyborgFace && cyborgFace.dataset.state === 'error') setFaceState('standby');
      } else {
        setConnStatus('error', 'CONFIG MISSING');
        setFaceState('error');
      }
    } catch {
      setConnStatus('error', 'OFFLINE');
      setFaceState('error');
    }
  }
  checkHealth();
  setInterval(checkHealth, 20000);

  // ---------- Camera ----------
  // camPrefStore remembers the user's *explicit* camera preference so the
  // next manual press of the toggle can act on it. We never auto-open the
  // camera on first paint — preference is consulted only on user gesture.
  const camPrefStore = (() => {
    const KEY = 'jarvisWeb.camera.preference';
    const ls = (typeof window !== 'undefined' && window.localStorage) || null;
    return {
      load() {
        if (!ls) return false;
        try { return ls.getItem(KEY) === 'on'; } catch (_) { return false; }
      },
      save(wantsOn) {
        if (!ls) return;
        try { ls.setItem(KEY, wantsOn ? 'on' : 'off'); } catch (_) { /* quota / disabled — ignore */ }
      },
    };
  })();
  async function enableCamera() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      video.srcObject = mediaStream;
      camOn = true;
      placeholder.classList.add('hidden');
      camState.textContent = 'CAM ON';
      camState.classList.remove('off'); camState.classList.add('on');
      toggleCamBtn.classList.add('active');
      camPrefStore.save(true); // user explicitly enabled — remember for next page
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
  // camAutoRelease + mirror guard: after a /api/vision snapshot settles
  // (reply OR error), we stop the camera tracks, null srcObject, flip the
  // chips, and remove the active class. While we're releasing the
  // camera — the small synchronous window inside this function — we set a
  // `dataset.autoReleasing` flag on the toggle button. A user click that
  // arrives during that window is *queued* (their intent — "on" or "off"
  // relative to the state at the moment they pressed) and drained after a
  // microtask; the flag is also cleared then. The user's prior manual
  // preference still survives across reload via camPrefStore.
  let camAutoReleasing = false;
  let pendingCamIntent = null; // 'on' | 'off' | null
  function camAutoRelease(reason) {
    if (!camOn || camAutoReleasing) return;
    camAutoReleasing = true;
    try { toggleCamBtn.dataset.autoReleasing = reason || 'true'; } catch (_) { /* ignore */ }
    try {
      disableCamera();
    } finally {
      const finish = () => {
        try { delete toggleCamBtn.dataset.autoReleasing; } catch (_) { /* ignore */ }
        camAutoReleasing = false;
        const intent = pendingCamIntent;
        pendingCamIntent = null;
        if (intent === 'on' && !camOn) enableCamera();
        else if (intent === 'off' && camOn) disableCamera();
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(finish);
      else Promise.resolve().then(finish);
    }
  }
  toggleCamBtn.addEventListener('click', () => {
    if (camAutoReleasing) {
      // Queue the user's intent — opposite of the current state — rather
      // than racing our auto-release.
      pendingCamIntent = camOn ? 'off' : 'on';
      return;
    }
    if (camOn) { disableCamera(); camPrefStore.save(false); }
    else enableCamera();
  });

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
        pendingListenAfterVision = true;
        if (!textEnabled) setTextEnabled(true);
        if (!micOn) {
          setSensorState('guarded', 'กำลังเปิดไมค์เพื่อรอสนทนาต่อ...');
          await enableMic({ silent: true });
        }
        await speak(data.reply);
        camAutoRelease('reply'); // /api/vision settled -> snap cameras off
      } else {
        addMessage('system', 'เกิดข้อผิดพลาด: ' + (data.error || 'unknown'));
        camAutoRelease('error');
      }
    } catch (err) {
      addMessage('system', 'เชื่อมต่อไม่สำเร็จ: ' + err.message);
      camAutoRelease('error');
    }
    setCoreState('STANDBY');
  });

  // ---------- Microphone toggle (enables push-to-talk) ----------
  async function enableMic(options = {}) {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      window.__jarvisAudioStream = audioStream;
      setupVoiceSensor(audioStream);
      micOn = true;
      micState.textContent = 'MIC SENSOR ON';
      micState.classList.remove('off'); micState.classList.add('on');
      toggleMicBtn.classList.add('active');
      pushToTalkBtn.querySelector('span').textContent = 'กดค้าง/Auto Listen';
      setSensorState('ready', pendingListenAfterVision ? 'รอฟังเสียงต่อจากการดูภาพ...' : 'VOICE SENSOR READY');
      if (!options.silent) addMessage('system', '🎙️ เปิด Voice Sensor แล้ว — พูดได้เลย ระบบจะเริ่มฟังอัตโนมัติ และจะพักไมค์ตอน Jarvis พูด');
      return true;
    } catch (err) {
      if (!options.silent) addMessage('system', 'ไม่สามารถเปิดไมค์ได้: ' + err.message);
      return false;
    }
  }
  function disableMic() {
    stopVoiceSensor();
    if (isRecording) stopRecording(true);
    if (window.__jarvisAudioStream) {
      window.__jarvisAudioStream.getTracks().forEach((t) => t.stop());
      window.__jarvisAudioStream = null;
    }
    micOn = false;
    micState.textContent = 'MIC OFF';
    micState.classList.remove('on'); micState.classList.add('off');
    toggleMicBtn.classList.remove('active');
    pushToTalkBtn.querySelector('span').textContent = 'กดค้างเพื่อพูด';
    setSensorState('', 'VOICE SENSOR STANDBY');
    updateEq(0);
  }
  toggleMicBtn.addEventListener('click', () => (micOn ? disableMic() : enableMic()));

  // ---------- Voice sensor + push to talk ----------
  function setupVoiceSensor(stream) {
    stopVoiceSensor();
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.68;
    analyserData = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    voiceStartAt = 0;
    silenceStartAt = 0;
    runVoiceSensor();
  }

  function stopVoiceSensor() {
    if (vadFrame) cancelAnimationFrame(vadFrame);
    vadFrame = null;
    analyser = null;
    analyserData = null;
  }

  function runVoiceSensor() {
    if (!micOn || !analyser || !analyserData) {
      vadFrame = requestAnimationFrame(runVoiceSensor);
      return;
    }

    analyser.getByteTimeDomainData(analyserData);
    let sum = 0;
    for (const v of analyserData) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / analyserData.length);
    updateEq(rms);

    const now = performance.now();
    const guarded = jarvisSpeaking || coreState.textContent === 'THINKING' || coreState.textContent === 'TRANSCRIBING';

    if (guarded) {
      if (isRecording) stopRecording(true);
      setSensorState('guarded', 'OUTPUT GUARD — MIC PAUSED');
      voiceStartAt = 0;
      silenceStartAt = 0;
      vadFrame = requestAnimationFrame(runVoiceSensor);
      return;
    }

    if (rms > VAD_START_THRESHOLD) {
      if (!voiceStartAt) voiceStartAt = now;
      silenceStartAt = 0;
      if (!isRecording && autoListen && now - voiceStartAt > VAD_START_HOLD_MS) {
        startRecording({ auto: true });
      }
    } else if (rms < VAD_STOP_THRESHOLD) {
      voiceStartAt = 0;
      if (isRecording) {
        if (!silenceStartAt) silenceStartAt = now;
        if (now - silenceStartAt > VAD_SILENCE_HOLD_MS && now - recordingStartedAt > VAD_MIN_RECORD_MS) {
          stopRecording();
        }
      }
    }

    if (!isRecording && !guarded) {
      const pct = Math.min(99, Math.round(rms * 900));
      setSensorState('ready', `VOICE SENSOR READY · LEVEL ${pct}%`);
    }
    vadFrame = requestAnimationFrame(runVoiceSensor);
  }

  function startRecording(options = {}) {
    if (!micOn || !window.__jarvisAudioStream) {
      if (textEnabled) addMessage('system', 'กรุณาเปิดไมค์ก่อนครับ');
      return;
    }
    if (jarvisSpeaking) return;
    if (isRecording) return;
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(window.__jarvisAudioStream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();
    recordingStartedAt = performance.now();
    isRecording = true;
    pushToTalkBtn.classList.add('active');
    waveform.classList.add('active');
    setSensorState('recording', options.auto ? 'VOICE DETECTED — LISTENING' : 'MANUAL LISTENING');
    setCoreState('LISTENING');
  }
  function stopRecording(discard = false) {
    if (mediaRecorder && isRecording) {
      mediaRecorder.__discard = discard;
      mediaRecorder.stop();
      isRecording = false;
      pushToTalkBtn.classList.remove('active');
      waveform.classList.remove('active');
      silenceStartAt = 0;
      voiceStartAt = 0;
    }
  }
  pushToTalkBtn.addEventListener('mousedown', startRecording);
  pushToTalkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
  pushToTalkBtn.addEventListener('mouseup', stopRecording);
  pushToTalkBtn.addEventListener('mouseleave', () => { if (isRecording) stopRecording(); });
  pushToTalkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });

  async function handleRecordingStop() {
    const discard = mediaRecorder?.__discard;
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    if (discard || blob.size < 1000) {
      setCoreState('STANDBY');
      setSensorState(micOn ? 'ready' : '', micOn ? 'VOICE SENSOR READY' : 'VOICE SENSOR STANDBY');
      return;
    }
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
  let ttsAnalyser = null;
  let ttsData = null;
  let ttsRAF = null;
  function setupTtsAnalyser() {
    if (ttsAnalyser) return; // only wire the <audio> element into WebAudio once
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(jarvisAudioEl);
      ttsAnalyser = audioCtx.createAnalyser();
      ttsAnalyser.fftSize = 512;
      ttsAnalyser.smoothingTimeConstant = 0.6;
      ttsData = new Uint8Array(ttsAnalyser.fftSize);
      src.connect(ttsAnalyser);
      ttsAnalyser.connect(audioCtx.destination); // keep audio audible
    } catch { /* MediaElementSource can only be created once per element; ignore if already wired */ }
  }
  function runTtsLipSync() {
    if (!ttsAnalyser || !ttsData) { mouthLevel = 0; return; }
    ttsAnalyser.getByteTimeDomainData(ttsData);
    let sum = 0;
    for (const v of ttsData) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / ttsData.length);
    mouthLevel = Math.max(0, Math.min(1, rms * 5.5));
    if (jarvisSpeaking) ttsRAF = requestAnimationFrame(runTtsLipSync);
    else mouthLevel = 0;
  }
  function setUnlockState(unlocked) {
    audioUnlocked = unlocked;
    if (!unlockAudioBtn) return;
    unlockAudioBtn.classList.toggle('active', unlocked);
    unlockAudioBtn.querySelector('span').textContent = unlocked ? 'SPEAKER ON' : 'SPEAKER';
    unlockAudioBtn.title = unlocked ? 'เสียงเปิดใช้งานแล้ว — กดอีกครั้งเพื่อทดสอบ' : 'กดเพื่อเปิดเสียง Jarvis (เบราว์เซอร์ต้องการการกดก่อนเล่นเสียงได้)';
  }
  async function unlockAudioContext(playTest) {
    try {
      if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
      // Play + immediately pause a silent tick on the shared <audio> element so the
      // browser marks this origin as "has user gesture for audio" going forward.
      jarvisAudioEl.muted = false;
      jarvisAudioEl.src = jarvisAudioEl.src || '';
      await jarvisAudioEl.play().catch(() => {});
      jarvisAudioEl.pause();
      setUnlockState(true);
      if (playTest) {
        setSensorState('guarded', 'กำลังทดสอบเสียง Jarvis...');
        if (textEnabled) addMessage('system', '🔊 ทดสอบเสียง Jarvis...');
        await speak('สวัสดีครับ ผมจาร์วิส ทดสอบเสียงเรียบร้อยครับ ได้ยินผมไหมครับ');
      }
    } catch (err) {
      setSensorState('', 'เปิดเสียงไม่สำเร็จ — กดปุ่ม SPEAKER อีกครั้ง');
      if (textEnabled) addMessage('system', 'เปิดเสียงไม่สำเร็จ: ' + err.message + ' — ลองกดปุ่ม SPEAKER อีกครั้งครับ');
    }
  }
  unlockAudioBtn?.addEventListener('click', () => unlockAudioContext(true));

  async function speak(text) {
    try {
      jarvisSpeaking = true;
      if (isRecording) stopRecording(true);
      setSensorState('guarded', 'OUTPUT GUARD — MIC PAUSED');
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        if (textEnabled) addMessage('system', 'สร้างเสียงไม่สำเร็จ (HTTP ' + res.status + ')');
        throw new Error('speak http ' + res.status);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setCoreState('SPEAKING');
      waveform.classList.add('active');
      const releaseGuard = () => {
        jarvisSpeaking = false;
        setCoreState('STANDBY');
        waveform.classList.remove('active');
        if (pendingListenAfterVision && micOn) {
          pendingListenAfterVision = false;
          setSensorState('ready', 'ดูภาพแล้ว — พูดต่อได้เลย ผมกำลังฟัง');
        } else {
          setSensorState(micOn ? 'ready' : '', micOn ? 'VOICE SENSOR READY' : 'VOICE SENSOR STANDBY');
        }
        URL.revokeObjectURL(url);
      };
      jarvisAudioEl.onended = releaseGuard;
      jarvisAudioEl.onerror = releaseGuard;
      jarvisAudioEl.src = url;
      jarvisAudioEl.muted = false;
      jarvisAudioEl.volume = 1;
      setupTtsAnalyser();
      try {
        await jarvisAudioEl.play();
        setUnlockState(true);
        if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
        runTtsLipSync();
      } catch (playErr) {
        // Autoplay blocked — most common cause of "Jarvis พูดแต่ไม่ได้ยิน".
        setUnlockState(false);
        if (textEnabled) addMessage('system', '🔇 เบราว์เซอร์บล็อกไม่ให้เล่นเสียงอัตโนมัติ — กดปุ่ม SPEAKER ที่แถบกล้อง 1 ครั้งเพื่อปลดล็อกเสียงครับ');
        else setSensorState('', 'กดปุ่ม SPEAKER ที่แถบกล้องเพื่อเปิดเสียง');
        releaseGuard();
      }
    } catch {
      jarvisSpeaking = false;
      if (pendingListenAfterVision && micOn) {
        pendingListenAfterVision = false;
        setSensorState('ready', 'ดูภาพแล้ว — พูดต่อได้เลย ผมกำลังฟัง');
      } else {
        setSensorState(micOn ? 'ready' : '', micOn ? 'VOICE SENSOR READY' : 'VOICE SENSOR STANDBY');
      }
    }
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

  async function autoStartVoiceSensorOnLoad() {
    if (micOn) return;
    setSensorState('guarded', 'กำลังขอสิทธิ์ไมค์เพื่อเริ่มฟังอัตโนมัติ...');
    const ok = await enableMic({ silent: true });
    if (ok) {
      setSensorState('ready', 'AUTO LISTENING · TEXT OFF — พูดได้เลย');
    } else {
      setSensorState('', 'MIC PERMISSION NEEDED');
    }
  }

  // ---------- Welcome ----------
  setSensorState('', 'VOICE SENSOR STANDBY');
  updateEq(0);
  setTextEnabled(false);
  setTimeout(autoStartVoiceSensorOnLoad, 600);
  setTimeout(() => {
    if (!audioUnlocked) addMessage('system', '🔈 ถ้ากด Jarvis พูดแล้วไม่ได้ยิน ให้กดปุ่ม SPEAKER ที่แถบกล้อง 1 ครั้งก่อนครับ (เบราว์เซอร์กันเล่นเสียงอัตโนมัติ)');
  }, 1200);
})();
