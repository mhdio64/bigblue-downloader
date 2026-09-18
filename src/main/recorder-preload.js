const { ipcRenderer } = require('electron');

let mediaRecorder = null;
let mediaStream = null;
let progressInterval = null;
let targetMedia = null;

// Listen for start command from main process
ipcRenderer.on('bbb:start-recording-cmd', async (event, config) => {
  try {
    const playbackRate = config.playbackRate || 1.0;

    // 1. Request display media from the frame (handled by main process setDisplayMediaRequestHandler)
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    // 2. Determine best supported mimeType
    let mimeType = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
        mimeType = 'video/webm;codecs=vp9,opus';
      } else if (MediaRecorder.isTypeSupported('video/webm')) {
        mimeType = 'video/webm';
      }
    }

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        const arrayBuf = await e.data.arrayBuffer();
        ipcRenderer.send('bbb:recorder-chunk', arrayBuf);
      }
    };

    mediaRecorder.onstop = () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
      }
      clearInterval(progressInterval);
      ipcRenderer.send('bbb:recorder-stopped');
    };

    // Start recorder with 1-second chunks
    mediaRecorder.start(1000);

    // 3. Find and start media playback in BBB player
    await startBBBPlayback(playbackRate);

    // 4. Progress tracker loop
    progressInterval = setInterval(() => {
      checkPlaybackProgress();
    }, 1000);

    ipcRenderer.send('bbb:recorder-started');
  } catch (err) {
    console.error('Failed to start in-page recorder:', err);
    ipcRenderer.send('bbb:recorder-error', err.message);
  }
});

// Stop recording command from main process
ipcRenderer.on('bbb:stop-recording-cmd', () => {
  stopRecorder();
});

function stopRecorder() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.warn('Error stopping mediaRecorder:', e.message);
    }
  }
}

async function startBBBPlayback(rate = 1.0) {
  // Wait up to 15 seconds for audio/video elements or play buttons
  let attempts = 0;
  while (attempts < 30) {
    targetMedia = document.querySelector('video, audio');
    const playBtn = document.querySelector('button[aria-label="Play"], button.vjs-play-control, button.playback-play-button, button.play');

    if (targetMedia) {
      try {
        targetMedia.playbackRate = rate;
        if (targetMedia.paused) {
          await targetMedia.play();
        }
        if (playBtn) playBtn.click();
        console.log('[BBB Recorder] Media playback initiated successfully.');
        break;
      } catch (err) {
        // Autoplay may need button click
        if (playBtn) {
          playBtn.click();
          break;
        }
      }
    } else if (playBtn) {
      playBtn.click();
    }

    await new Promise(r => setTimeout(r, 500));
    attempts++;
  }

  // Hook playback end event
  if (targetMedia) {
    targetMedia.addEventListener('ended', () => {
      console.log('[BBB Recorder] Media playback reached end.');
      stopRecorder();
    });
  }
}

function checkPlaybackProgress() {
  if (!targetMedia) {
    targetMedia = document.querySelector('video, audio');
  }

  if (targetMedia && !isNaN(targetMedia.duration) && targetMedia.duration > 0) {
    const cur = targetMedia.currentTime || 0;
    const dur = targetMedia.duration || 1;
    const percent = Math.min(100, Math.round((cur / dur) * 100));

    ipcRenderer.send('bbb:recorder-progress', {
      currentTime: cur,
      duration: dur,
      percent
    });

    if (cur >= dur - 0.5) {
      console.log('[BBB Recorder] Target duration reached.');
      stopRecorder();
    }
  }
}
