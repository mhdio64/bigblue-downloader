const { BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function getFFmpegPath() {
  try {
    let ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
      const unpacked = ffmpegStatic.split('app.asar').join('app.asar.unpacked');
      if (fs.existsSync(unpacked)) {
        return unpacked;
      }
      if (fs.existsSync(ffmpegStatic)) {
        return ffmpegStatic;
      }
    }
  } catch {}
  return 'ffmpeg';
}

/**
 * Records a BigBlueButton lecture directly from its in-app player in the background
 * 
 * @param {string} url BigBlueButton playback URL
 * @param {object} options
 * @param {string} options.outputPath Target MP4 file path
 * @param {string} options.tempDir Temporary working directory
 * @param {Array<object>|string} [options.cookies] Session cookies for authenticated LMS
 * @param {boolean} [options.muteSpeaker=true] Whether to mute audio output to speakers during recording
 * @param {number} [options.playbackRate=1.0] Playback rate (1.0 default for exact sync)
 * @param {AbortSignal} [options.signal] Signal to abort or stop recording
 * @param {function} [options.onProgress] Callback for progress updates
 * @returns {Promise<string>} Output MP4 file path
 */
async function recordMeetingPlayer(url, options = {}) {
  if (!url) throw new Error('Meeting playback URL is required');
  if (!options.outputPath) throw new Error('Output path is required');

  const muteSpeaker = options.muteSpeaker !== false; // Default true (silent speakers)
  const playbackRate = options.playbackRate || 1.0;
  const tempWebmPath = path.join(options.tempDir, 'raw_player_recording.webm');

  // Ensure output directory exists
  const outputDir = path.dirname(options.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(tempWebmPath);

  // Dedicated background window for rendering the BBB playback canvas
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false // Prevent Chromium from sleeping when window is hidden
    }
  });

  // Mute audio playback at the window level as well
  if (muteSpeaker) {
    win.webContents.setAudioMuted(true);
  }

  const winSession = win.webContents.session;

  // Set up screen/audio capture stream handler
  winSession.setDisplayMediaRequestHandler((request, callback) => {
    callback({
      video: win.webContents.mainFrame,
      audio: win.webContents.mainFrame,
      enableLocalEcho: !muteSpeaker // If true, sounds play on speakers. If false, silent!
    });
  });

  // Automatically grant display capture and media permissions
  winSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'display-capture' || permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Inject cookies if available
  if (options.cookies) {
    try {
      let cookieList = [];
      if (Array.isArray(options.cookies)) {
        cookieList = options.cookies;
      } else if (typeof options.cookies === 'string') {
        const parts = options.cookies.split(';');
        const urlObj = new URL(url);
        cookieList = parts.map(p => {
          const [k, v] = p.trim().split('=');
          return { url: urlObj.origin, name: k, value: v || '' };
        }).filter(c => c.name);
      }

      for (const c of cookieList) {
        if (c.name && c.value) {
          await winSession.cookies.set({
            url: c.url || url,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/'
          });
        }
      }
    } catch (cookieErr) {
      console.warn('[PlayerRecorder] Failed to set some cookies:', cookieErr.message);
    }
  }

  return new Promise(async (resolve, reject) => {
    let isCleanedUp = false;
    let isRecording = false;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;

      ipcMain.removeListener('bbb:recorder-chunk', onChunk);
      ipcMain.removeListener('bbb:recorder-progress', onProgressMsg);
      ipcMain.removeListener('bbb:recorder-started', onStarted);
      ipcMain.removeListener('bbb:recorder-stopped', onStopped);
      ipcMain.removeListener('bbb:recorder-error', onError);

      try {
        if (!writeStream.writableEnded) {
          writeStream.end();
        }
      } catch {}

      if (!win.isDestroyed()) {
        win.destroy();
      }
    };

    const onChunk = (event, arrayBuffer) => {
      if (event.sender.id === win.webContents.id) {
        writeStream.write(Buffer.from(arrayBuffer));
      }
    };

    const onProgressMsg = (event, data) => {
      if (event.sender.id === win.webContents.id && options.onProgress) {
        options.onProgress({
          stage: 'player_recording',
          stageLabel: `Recording presentation (${data.percent}%)...`,
          percent: Math.min(95, Math.round(data.percent * 0.95)),
          speed: `${playbackRate}x`,
          currentTime: data.currentTime,
          duration: data.duration
        });
      }
    };

    const onStarted = (event) => {
      if (event.sender.id === win.webContents.id) {
        isRecording = true;
        if (options.onProgress) {
          options.onProgress({
            stage: 'player_recording',
            stageLabel: 'Recording live player in background...',
            percent: 5,
            speed: `${playbackRate}x`
          });
        }
      }
    };

    const onStopped = async (event) => {
      if (event.sender.id === win.webContents.id) {
        console.log('[PlayerRecorder] Recording stopped, finalizing file...');
        try {
          cleanup();
          await remuxWebmToMp4(tempWebmPath, options.outputPath, options.onProgress);
          resolve(options.outputPath);
        } catch (err) {
          reject(err);
        }
      }
    };

    const onError = (event, msg) => {
      if (event.sender.id === win.webContents.id) {
        console.error('[PlayerRecorder] In-page recording error:', msg);
        cleanup();
        reject(new Error(`Player recorder error: ${msg}`));
      }
    };

    ipcMain.on('bbb:recorder-chunk', onChunk);
    ipcMain.on('bbb:recorder-progress', onProgressMsg);
    ipcMain.on('bbb:recorder-started', onStarted);
    ipcMain.on('bbb:recorder-stopped', onStopped);
    ipcMain.on('bbb:recorder-error', onError);

    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        console.log('[PlayerRecorder] Abort signal received');
        if (isRecording) {
          // Send stop command to finish and salvage what was recorded
          try {
            win.webContents.send('bbb:stop-recording-cmd');
          } catch {
            cleanup();
            reject(new Error('Recording cancelled'));
          }
        } else {
          cleanup();
          reject(new Error('Recording cancelled'));
        }
      });
    }

    try {
      console.log('[PlayerRecorder] Loading BBB playback URL:', url);
      await win.loadURL(url);

      // Wait 3 seconds for DOM and player scripts to initialize
      await new Promise(r => setTimeout(r, 3000));

      if (win.isDestroyed()) return;

      console.log('[PlayerRecorder] Dispatching start recording command...');
      win.webContents.send('bbb:start-recording-cmd', { playbackRate });
    } catch (loadErr) {
      cleanup();
      reject(new Error(`Failed to load playback page: ${loadErr.message}`));
    }
  });
}

/**
 * Converts recorded webm to high-compatibility MP4 using FFmpeg
 */
function remuxWebmToMp4(inputWebm, outputMp4, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputWebm) || fs.statSync(inputWebm).size === 0) {
      return reject(new Error('Recorded video file is empty'));
    }

    if (onProgress) {
      onProgress({
        stage: 'muxing',
        stageLabel: 'Converting recorded video to standard MP4...',
        percent: 96,
        speed: 'FFmpeg'
      });
    }

    const args = [
      '-y',
      '-i', inputWebm,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputMp4
    ];

    const ffmpegBin = getFFmpegPath();
    const proc = spawn(ffmpegBin, args);
    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputMp4)) {
        // Clean up temporary webm file
        try { fs.unlinkSync(inputWebm); } catch {}
        resolve(outputMp4);
      } else {
        reject(new Error(`FFmpeg remux failed with code ${code}: ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

module.exports = {
  recordMeetingPlayer,
  remuxWebmToMp4
};
