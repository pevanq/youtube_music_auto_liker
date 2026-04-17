// Retrieve Authorization Hash (Calculate SAPISIDHASH)
async function getAuthHeaders() {
  const cookie = await chrome.cookies.get({ url: 'https://music.youtube.com', name: 'SAPISID' });
  if (!cookie) {
    throw new Error('SAPISID Cookie not found. Please ensure you are logged into YouTube Music!');
  }

  const sapisid = cookie.value;
  const time = Math.floor(Date.now() / 1000);
  const origin = 'https://music.youtube.com';
  const str = `${time} ${sapisid} ${origin}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    'content-type': 'application/json',
    'authorization': `SAPISIDHASH ${time}_${hashHex}`,
    'x-origin': 'https://music.youtube.com',
    'x-youtube-client-name': '67',
    'x-youtube-client-version': '1.20260403.09.00' // Latest version
  };
}

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MIN_DELAY_SECONDS = 1.0;
const MAX_DELAY_SECONDS = 15.0;
let activeRequestController = null;
let isLoopRunning = false;
let isInitializing = false;

function normalizeDelaySeconds(rawDelay) {
  const parsed = Number.parseFloat(rawDelay);
  if (!Number.isFinite(parsed)) return MIN_DELAY_SECONDS;
  return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, parsed));
}

function backoffDelayMs(attempt, baseDelayMs = 1000) {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  return exponential + Math.random() * 400;
}

function makeAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function setActiveRequestController(controller) {
  activeRequestController = controller;
}

function clearActiveRequestController(controller) {
  if (activeRequestController === controller) {
    activeRequestController = null;
  }
}

function abortActiveRequest() {
  if (activeRequestController) {
    activeRequestController.abort();
    activeRequestController = null;
  }
}

async function initializeRunFromConfig(config, options = {}) {
  const { resetProgress = true } = options;

  if (!config?.playlistId) {
    throw new Error('Missing playlistId for initialization.');
  }

  if (isInitializing) {
    return;
  }

  isInitializing = true;
  const safeDelaySeconds = normalizeDelaySeconds(config.delay);
  const runConfig = {
    playlistId: config.playlistId,
    delay: safeDelaySeconds,
    reverse: Boolean(config.reverse)
  };

  try {
    await chrome.storage.local.set({ lastStartConfig: runConfig });

    if (resetProgress) {
      await chrome.storage.local.set({ currentIndex: 0, storedTracks: [] });
    }

    const headers = await getAuthHeaders();
    const tracks = await getPlaylistTracks(runConfig.playlistId, headers);

    if (runConfig.reverse) {
      tracks.reverse();
    }

    await chrome.storage.local.set({
      storedTracks: tracks,
      currentIndex: 0,
      currentDelay: safeDelaySeconds
    });

    const { appState } = await chrome.storage.local.get(['appState']);
    if (appState === 'running') {
      executeLoop();
    }
  } finally {
    isInitializing = false;
  }
}

async function fetchWithRetry(url, fetchOptions, options = {}) {
  const {
    maxAttempts = 4,
    baseDelayMs = 1000,
    requestLabel = 'Request'
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, fetchOptions);

      if (response.ok) {
        return response;
      }

      if (!RETRYABLE_HTTP_STATUS.has(response.status) || attempt === maxAttempts) {
        return response;
      }

      let waitMs = backoffDelayMs(attempt, baseDelayMs);
      const retryAfter = Number.parseFloat(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = retryAfter * 1000;
      }

      chrome.runtime.sendMessage({
        type: 'info',
        message: `${requestLabel} got HTTP ${response.status}. Retrying in ${(waitMs / 1000).toFixed(1)}s... (${attempt}/${maxAttempts})`
      });
      await sleep(waitMs);
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw err;
      }

      lastError = err;
      if (attempt === maxAttempts) {
        throw err;
      }

      const waitMs = backoffDelayMs(attempt, baseDelayMs);
      chrome.runtime.sendMessage({
        type: 'info',
        message: `${requestLabel} network error. Retrying in ${(waitMs / 1000).toFixed(1)}s... (${attempt}/${maxAttempts})`
      });
      await sleep(waitMs);
    }
  }

  throw lastError || new Error(`${requestLabel} failed after retries`);
}

// Send Like API request
async function rateSong(videoId, authHeaders) {
  const apiKey = await getInnerTubeApiKey();
  const url = `https://music.youtube.com/youtubei/v1/like/like?prettyPrint=false&key=${apiKey}`;
  const body = {
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20260403.09.00'
      }
    },
    target: { videoId: videoId }
  };

  const controller = new AbortController();
  setActiveRequestController(controller);

  let res;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: authHeaders,
        credentials: 'include',
        body: JSON.stringify(body),
        signal: controller.signal
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1200,
        requestLabel: 'Like request'
      }
    );
  } finally {
    clearActiveRequestController(controller);
  }
  
  if (!res.ok) {
     const text = await res.text();
     throw new Error(`Like failed HTTP ${res.status}: ${text.substring(0, 100)}`);
  }
  return res.ok;
}

// Parse JSON to extract detailed track info AND continuation token
function extractTracksAndContinuation(jsonObj) {
  const tracks = [];
  let nextContinuation = null;
  let continuationPriority = 0;
  let totalSongsText = '';

  function setContinuation(token, priority) {
    if (!token) return;
    if (priority > continuationPriority) {
      nextContinuation = token;
      continuationPriority = priority;
    }
  }
  
  function traverse(obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) traverse(item);
    } else if (typeof obj === 'object' && obj !== null) {
      // Use continuationItemRenderer token first; some nextContinuationData tokens do not page playlist rows.
      if (obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        setContinuation(obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token, 3);
      }
      if (obj.continuationEndpoint?.continuationCommand?.token) {
        setContinuation(obj.continuationEndpoint.continuationCommand.token, 2);
      }
      if (obj.nextContinuationData && obj.nextContinuationData.continuation) {
        setContinuation(obj.nextContinuationData.continuation, 1);
      }
      if (obj.reloadContinuationData?.continuation) {
        setContinuation(obj.reloadContinuationData.continuation, 1);
      }
      if (obj.timedContinuationData?.continuation) {
        setContinuation(obj.timedContinuationData.continuation, 1);
      }
      
      // Find total songs directly from shelf if available
      if (obj.musicPlaylistShelfRenderer && obj.musicPlaylistShelfRenderer.collapsedItemCount !== undefined) {
        if (!totalSongsText) totalSongsText = obj.musicPlaylistShelfRenderer.collapsedItemCount.toString();
      }
      
      // Try to find total songs text from headers
      if (obj.musicDetailHeaderRenderer || obj.musicResponsiveHeaderRenderer) {
        const header = obj.musicDetailHeaderRenderer || obj.musicResponsiveHeaderRenderer;
        const runs1 = header.subtitle?.runs || [];
        const runs2 = header.secondSubtitle?.runs || [];
        const runs = runs1.concat(runs2);
        for (const r of runs) {
          if (r.text) {
             const match = r.text.match(/([0-9,]+)\s*(首|song|track)/i);
             if (match) {
               totalSongsText = match[1];
             }
          }
        }
      }
      
      if (obj.musicResponsiveListItemRenderer) {
        const item = obj.musicResponsiveListItemRenderer;
        
        try {
          let videoId = null;
          let title = '';
          let artist = '';
          
          // Locate videoId (often inside overlay buttons or playlistItemData)
          if (item.playlistItemData && item.playlistItemData.videoId) {
            videoId = item.playlistItemData.videoId;
          } else {
            const str = JSON.stringify(item);
            const match = str.match(/"videoId":"([a-zA-Z0-9_-]{11})/);
            if (match) videoId = match[1];
          }
          
          if (videoId && item.flexColumns) {
            // First column: Title
            const titleRuns = item.flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
            if (titleRuns) title = titleRuns.map(r => r.text).join('');
            
            // Second column: Artist / Album
            const artistRuns = item.flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
            if (artistRuns) artist = artistRuns.map(r => r.text).join('').split(' • ')[0];

            if (title) {
               tracks.push({ videoId, title, artist });
            }
          }
        } catch (e) {
          // ignore
        }
      } else {
        for (const key of Object.keys(obj)) {
          traverse(obj[key]);
        }
      }
    }
  }
  
  traverse(jsonObj);
  return { tracks, nextContinuation, totalSongsText };
}

// Dynamically fetch the InnerTube API key from YouTube Music homepage
let cachedApiKey = null;
async function getInnerTubeApiKey() {
  if (cachedApiKey) return cachedApiKey;
  try {
    const res = await fetch('https://music.youtube.com/');
    const html = await res.text();
    const match = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (match && match[1]) {
      cachedApiKey = match[1];
      return cachedApiKey;
    }
  } catch (err) {
    console.error("Failed to dynamically fetch API Key", err);
  }
  // Fallback to the universally known static key if parsing fails
  return 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
}

// Fetch ALL tracks from the playlist using pagination
async function getPlaylistTracks(playlistId, authHeaders) {
  const apiKey = await getInnerTubeApiKey();
  const url = `https://music.youtube.com/youtubei/v1/browse?prettyPrint=false&key=${apiKey}`;
  let allTracks = [];
  let nextToken = null;
  let globalTotalSongsText = '';
  
  do {
    const stateCheck = await chrome.storage.local.get(['appState']);
    if (stateCheck.appState !== 'running') {
      throw makeAbortError('Playlist fetch aborted because app state is no longer running.');
    }

    const body = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20260403.09.00'
        }
      }
    };
    
    // First request needs browseId, subsequent requests need continuation token
    if (nextToken) {
      body.continuation = nextToken;
    } else {
      body.browseId = playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId;
    }

    const controller = new AbortController();
    setActiveRequestController(controller);

    let res;
    try {
      res = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: authHeaders,
          credentials: 'include',
          body: JSON.stringify(body),
          signal: controller.signal
        },
        {
          maxAttempts: 4,
          baseDelayMs: 1000,
          requestLabel: 'Playlist fetch'
        }
      );
    } finally {
      clearActiveRequestController(controller);
    }

    const text = await res.text();
    if (!res.ok) {
       throw new Error(`Failed to load playlist HTTP ${res.status}: ${text.substring(0, 200)}`);
    }
    
    const jsonObj = JSON.parse(text);
    const { tracks, nextContinuation, totalSongsText } = extractTracksAndContinuation(jsonObj);
    
    if (totalSongsText) {
      globalTotalSongsText = totalSongsText;
    }
    
    allTracks = allTracks.concat(tracks);
    nextToken = nextContinuation;
    
    // Notify about scraping progress and aggregate total songs found
    let progressMessage = '';
    if (globalTotalSongsText) {
      progressMessage += `Total tracks detected: ${globalTotalSongsText}`;
    }
    
    if (nextToken) {
      progressMessage += (progressMessage ? '\n' : '') + `⏳ Fetching playlist pages... (${allTracks.length} tracks loaded so far)`;
    }
    
    chrome.runtime.sendMessage({
      type: 'info',
      message: progressMessage
    });
    
    // Safety delay between pagination requests with jitter (0.5s - 1.5s) to avoid bot detection
    if (nextToken) {
      await sleep(500 + Math.random() * 1000);
    }

  } while (nextToken);
  
  if (allTracks.length === 0) {
     throw new Error('Playlist not found or is private/empty.');
  }

  // Keep playlist items as-is (including duplicates) so progress matches playlist row count.
  return allTracks;
}

function sleep(ms) {
  // Add ~15% randomness (jitter) to make the delay look more human
  const jitter = ms * 0.15;
  const finalMs = ms + (Math.random() * jitter * 2 - jitter);
  return new Promise(resolve => setTimeout(resolve, Math.max(10, finalMs)));
}
// Main execution loop mapping chrome.storage.local states to support resume/pause natively
async function executeLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  const { storedTracks = [], currentIndex = 0, currentDelay = 1.0 } = await chrome.storage.local.get(['storedTracks', 'currentIndex', 'currentDelay']);
  
  if (storedTracks.length === 0) {
    isLoopRunning = false;
    return;
  }

  try {
    const headers = await getAuthHeaders();
    const safeDelaySeconds = normalizeDelaySeconds(currentDelay);
    
    for (let i = currentIndex; i < storedTracks.length; i++) {
      // Check prior to hitting YouTube if state is still running natively
      const r = await chrome.storage.local.get(['appState']);
      if (r.appState !== 'running') {
         // Break loop (paused or stopped)
         break; 
      }
      
      const track = storedTracks[i];
      const displayTitle = track.artist ? `${track.title} - ${track.artist}` : track.title;
            
      // Update UI Popup
      chrome.runtime.sendMessage({ 
        type: 'progress', 
        current: i + 1, 
        total: storedTracks.length, 
        title: displayTitle 
      });

      // Submit API request
      await rateSong(track.videoId, headers);
      
      // Persist index to storage securely in case of interruptions
      await chrome.storage.local.set({ currentIndex: i + 1 });
      
      if (i < storedTracks.length - 1) {
        // Break long streaks to mimic human behavior (rest for 10-15s every 50 songs)
        if ((i + 1) % 50 === 0) {
          chrome.runtime.sendMessage({ 
            type: 'info', 
            message: `Taking a short human-like break (10-15s) to avoid rate limits...` 
          });
          await sleep(10000 + Math.random() * 5000); // 10s ~ 15s
        } else {
          await sleep(safeDelaySeconds * 1000);
        }
      }
    }
    
    // Check if fully finished
    const finalCheck = await chrome.storage.local.get(['appState', 'currentIndex']);
    if (finalCheck.appState === 'running' && finalCheck.currentIndex >= storedTracks.length) {
       chrome.storage.local.set({ appState: 'idle' });
       chrome.runtime.sendMessage({ type: 'done', total: storedTracks.length });
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      return;
    }

    chrome.storage.local.set({ appState: 'idle' });
    chrome.runtime.sendMessage({ type: 'error', error: err.toString() });
  } finally {
    isLoopRunning = false;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stop_liking') {
    chrome.storage.local.set({ appState: 'idle' });
    abortActiveRequest();
    return;
  }
  
  if (request.action === 'pause_liking') {
    chrome.storage.local.set({ appState: 'paused' });
    abortActiveRequest();
    return;
  }

  if (request.action === 'resume_liking') {
    chrome.storage.local.set({ appState: 'running' });

    (async () => {
      try {
        const { storedTracks = [], lastStartConfig = null } = await chrome.storage.local.get(['storedTracks', 'lastStartConfig']);

        // If pause happened during playlist-fetch initialization, restart the initialization phase.
        if (storedTracks.length === 0) {
          if (!lastStartConfig?.playlistId) {
            chrome.storage.local.set({ appState: 'idle' });
            chrome.runtime.sendMessage({ type: 'error', error: 'Nothing to resume. Please start again.' });
            return;
          }

          chrome.runtime.sendMessage({
            type: 'info',
            message: '▶ Resuming initialization, reading playlist pages...'
          });

          await initializeRunFromConfig(lastStartConfig, { resetProgress: false });
          return;
        }

        executeLoop(); // Continue liking loop
      } catch (err) {
        if (err?.name === 'AbortError') {
          return;
        }
        chrome.storage.local.set({ appState: 'idle' });
        chrome.runtime.sendMessage({ type: 'error', error: err.toString() });
      }
    })();

    return;
  }

  if (request.action === 'start_liking') {
    abortActiveRequest();
    chrome.storage.local.set({ appState: 'running' });
    
    (async () => {
      try {
        await initializeRunFromConfig(
          {
            playlistId: request.playlistId,
            delay: request.delay,
            reverse: request.reverse
          },
          { resetProgress: true }
        );
      } catch (err) {
        if (err?.name === 'AbortError') {
          return;
        }

        chrome.storage.local.set({ appState: 'idle' });
        chrome.runtime.sendMessage({ type: 'error', error: err.toString() });
      }
    })();
  }
});

// Prevent orphaned "running" states if Chrome is fully closed and restarted
function handleServiceWorkerStartup() {
  chrome.storage.local.get(['appState'], (r) => {
    if (r.appState === 'running') {
      chrome.storage.local.set({ appState: 'paused' });
    }
  });
}
chrome.runtime.onStartup.addListener(handleServiceWorkerStartup);
chrome.runtime.onInstalled.addListener(handleServiceWorkerStartup);
