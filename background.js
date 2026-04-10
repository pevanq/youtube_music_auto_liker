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

// Send Like API request
async function rateSong(videoId, authHeaders) {
  const url = 'https://music.youtube.com/youtubei/v1/like/like?prettyPrint=false';
  const body = {
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20260403.09.00'
      }
    },
    target: { videoId: videoId }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders,
    credentials: 'include',
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
     const text = await res.text();
     throw new Error(`Like failed HTTP ${res.status}: ${text.substring(0, 100)}`);
  }
  return res.ok;
}

// Parse JSON to extract detailed track info (title and artist)
function extractTracks(jsonObj) {
  const tracks = [];
  
  function traverse(obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) traverse(item);
    } else if (typeof obj === 'object' && obj !== null) {
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
            if (artistRuns) artist = artistRuns.map(r => r.text).join('').split(' • ')[0]; // Extract primary artist name

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
  
  // Deduplicate tracks
  const uniqueTracks = [];
  const seenIds = new Set();
  for (const t of tracks) {
    if (!seenIds.has(t.videoId)) {
      seenIds.add(t.videoId);
      uniqueTracks.push(t);
    }
  }
  
  return uniqueTracks;
}

// Fetch tracks from the playlist
async function getPlaylistTracks(playlistId, authHeaders) {
  const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false';
  const body = {
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20260403.09.00'
      }
    },
    browseId: playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders,
    credentials: 'include',
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
     throw new Error(`Failed to load playlist HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  
  const jsonObj = JSON.parse(text);
  const tracks = extractTracks(jsonObj);
  
  if (tracks.length === 0) {
     throw new Error('Playlist not found or is private/empty.');
  }
  
  return tracks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
// Main execution loop mapping chrome.storage.local states to support resume/pause natively
async function executeLoop() {
  const { storedTracks = [], currentIndex = 0, currentDelay = 1.0 } = await chrome.storage.local.get(['storedTracks', 'currentIndex', 'currentDelay']);
  
  if (storedTracks.length === 0) return;

  try {
    const headers = await getAuthHeaders();
    
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
        await sleep(currentDelay * 1000);
      }
    }
    
    // Check if fully finished
    const finalCheck = await chrome.storage.local.get(['appState', 'currentIndex']);
    if (finalCheck.appState === 'running' && finalCheck.currentIndex >= storedTracks.length) {
       chrome.storage.local.set({ appState: 'idle' });
       chrome.runtime.sendMessage({ type: 'done', total: storedTracks.length });
    }
  } catch (err) {
    chrome.storage.local.set({ appState: 'idle' });
    chrome.runtime.sendMessage({ type: 'error', error: err.toString() });
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stop_liking') {
    chrome.storage.local.set({ appState: 'idle' });
    return;
  }
  
  if (request.action === 'pause_liking') {
    chrome.storage.local.set({ appState: 'paused' });
    return;
  }

  if (request.action === 'resume_liking') {
    chrome.storage.local.set({ appState: 'running' });
    executeLoop(); // Continue iteration
    return;
  }

  if (request.action === 'start_liking') {
    chrome.storage.local.set({ appState: 'running', currentIndex: 0 });
    
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const tracks = await getPlaylistTracks(request.playlistId, headers);

        if (request.reverse) {
          tracks.reverse();
        }
        
        // Define initial allocation internally using Storage
        await chrome.storage.local.set({ 
          storedTracks: tracks, 
          currentIndex: 0, 
          currentDelay: request.delay 
        });
        
        executeLoop();
      } catch (err) {
        chrome.storage.local.set({ appState: 'idle' });
        chrome.runtime.sendMessage({ type: 'error', error: err.toString() });
      }
    })();
  }
});
