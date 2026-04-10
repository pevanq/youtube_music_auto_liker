document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusDiv = document.getElementById('status');
  const urlInput = document.getElementById('playlistUrl');

  const escapeHTML = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag]));
  };

  function updateUI(state, extraStatus = null) {
    startBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'none';
    stopBtn.style.display = 'none';

    if (state === 'idle') {
      startBtn.style.display = 'block';
    } else if (state === 'running') {
      pauseBtn.style.display = 'block';
      stopBtn.style.display = 'block';
    } else if (state === 'paused') {
      resumeBtn.style.display = 'block';
      stopBtn.style.display = 'block';
    }
    
    if (extraStatus) {
      statusDiv.innerHTML = extraStatus;
    }
  }

  // Initialize reading state from storage
  chrome.storage.local.get(['playlistUrl', 'delayMs', 'reverseOrder', 'appState', 'statusHTML'], (r) => {
    if (r.playlistUrl) urlInput.value = r.playlistUrl;
    if (r.delayMs) document.getElementById('delayMs').value = r.delayMs;
    if (r.reverseOrder !== undefined) document.getElementById('reverseOrder').checked = r.reverseOrder;
    
    const state = r.appState || 'idle';
    updateUI(state, r.statusHTML || 'Ready. Please paste a URL and click Start.');
  });

  startBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
      statusDiv.innerHTML = '❌ Please enter a valid Playlist URL or ID';
      return;
    }

    let playlistId = url;
    const match = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (match) playlistId = match[1];

    const delay = parseFloat(document.getElementById('delayMs').value);
    const reverse = document.getElementById('reverseOrder').checked;

    chrome.storage.local.set({ playlistUrl: url, delayMs: delay, reverseOrder: reverse });

    updateUI('running', `⏳ Initializing, reading playlist...<br><span class="progress-info">${escapeHTML(playlistId)}</span>`);
    chrome.runtime.sendMessage({ action: 'start_liking', playlistId, delay, reverse });
  });

  pauseBtn.addEventListener('click', () => {
    updateUI('paused', statusDiv.innerHTML + '<br><span style="color:#ffaa00">⏸ Paused</span>');
    chrome.runtime.sendMessage({ action: 'pause_liking' });
  });

  resumeBtn.addEventListener('click', () => {
    updateUI('running', statusDiv.innerHTML.replace('<br><span style="color:#ffaa00">⏸ Paused</span>', '') + '<br><span style="color:#00cc00">▶ Resuming...</span>');
    chrome.runtime.sendMessage({ action: 'resume_liking' });
  });

  stopBtn.addEventListener('click', () => {
    updateUI('idle', '🛑 Stopped manually.');
    chrome.runtime.sendMessage({ action: 'stop_liking' });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      const text = `[${msg.current}/${msg.total}] ❤️ ${escapeHTML(msg.title)}`;
      statusDiv.innerHTML = text;
      chrome.storage.local.set({ statusHTML: text }); // Store it so the popup shows progress when reopened
    } else if (msg.type === 'error') {
      const text = `❌ Error: ${escapeHTML(msg.error)}`;
      updateUI('idle', text);
      chrome.storage.local.set({ statusHTML: text, appState: 'idle' });
    } else if (msg.type === 'done') {
      const text = `🎉 Done! Processed ${msg.total} songs in total.`;
      updateUI('idle', text);
      chrome.storage.local.set({ statusHTML: text, appState: 'idle' });
    } else if (msg.type === 'state_changed') {
      updateUI(msg.state);
    }
  });
});
