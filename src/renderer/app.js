// BigBlueButton Downloader - Renderer Logic (English SaaS Interface)

const STATUS_LABELS = {
  queued: { text: 'Queued', class: 'status-queued' },
  fetching: { text: 'Fetching Info', class: 'status-active' },
  recording: { text: 'Downloading', class: 'status-active' },
  muxing: { text: 'Muxing', class: 'status-active' },
  paused: { text: 'Paused', class: 'status-paused' },
  completed: { text: 'Completed', class: 'status-completed' },
  failed: { text: 'Failed', class: 'status-danger' },
  cancelled: { text: 'Cancelled', class: 'status-cancelled' }
};

// State
let jobsList = [];
let activeJob = null;
let currentSettings = {};

// DOM Elements
const urlForm = document.getElementById('url-form');
const inputUrl = document.getElementById('input-url');
const btnSubmit = document.getElementById('btn-submit');
const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const emptyQueue = document.getElementById('empty-queue');

// Active Job Card Elements
const activeCard = document.getElementById('active-card');
const activeTitle = document.getElementById('active-title');
const activeMeta = document.getElementById('active-meta');
const activeStage = document.getElementById('active-stage');
const activePercent = document.getElementById('active-percent');
const activeFill = document.getElementById('active-fill');
const metricSpeed = document.getElementById('metric-speed');
const metricStatus = document.getElementById('metric-status');
const btnPauseActive = document.getElementById('btn-pause-active');
const btnCancelActive = document.getElementById('btn-cancel-active');

// Settings Elements
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const settingsModal = document.getElementById('settings-modal');
const settingOutputDir = document.getElementById('setting-output-dir');
const btnBrowseDir = document.getElementById('btn-browse-dir');
const settingNotify = document.getElementById('setting-notify');
const settingChat = document.getElementById('setting-chat');
const settingSlidePdf = document.getElementById('setting-slide-pdf');
const settingMuteSpeakers = document.getElementById('setting-mute-speakers');
const settingWebcamVideo = document.getElementById('setting-webcam-video');
const settingLmsPortalUrl = document.getElementById('setting-lms-portal-url');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnOpenOutputDir = document.getElementById('btn-open-output-dir');

// LMS Portal Elements
const btnOpenLMS = document.getElementById('btn-open-lms');
const lmsBtnText = document.getElementById('lms-btn-text');
const lmsStatusIndicator = document.getElementById('lms-status-indicator');
const btnSettingsOpenLMS = document.getElementById('btn-settings-open-lms');
const btnClearLMSSession = document.getElementById('btn-clear-lms-session');

/**
 * Formats seconds into mm:ss or hh:mm:ss
 */
function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Initializes the application
 */
async function initApp() {
  currentSettings = await window.bbbApi.getSettings();
  updateSettingsForm(currentSettings);

  jobsList = await window.bbbApi.getJobs();
  renderQueue();

  await updateLMSStatus();

  // Setup Event Listeners from Main Process
  if (window.bbbApi.onSettingsUpdated) {
    window.bbbApi.onSettingsUpdated((newSettings) => {
      currentSettings = newSettings;
      updateSettingsForm(newSettings);
      updateLMSStatus();
    });
  }

  if (window.bbbApi.onLMSDetectedUrl) {
    window.bbbApi.onLMSDetectedUrl(({ url }) => {
      if (url && inputUrl) {
        inputUrl.value = url;
        inputUrl.focus();
        updateLMSStatus();
      }
    });
  }

  window.bbbApi.onJobAdded((job) => {
    jobsList.unshift(job);
    renderQueue();
  });

  window.bbbApi.onJobUpdated((job) => {
    const idx = jobsList.findIndex(j => j.id === job.id);
    if (idx !== -1) {
      jobsList[idx] = job;
    }
    renderQueue();
  });

  window.bbbApi.onJobProgress((progressData) => {
    const job = jobsList.find(j => j.id === progressData.jobId);
    if (job) {
      job.progress = { ...job.progress, ...progressData };
      if (job.status === 'queued' || job.status === 'fetching') {
        job.status = 'recording';
      }
      activeJob = job;
      updateActiveCard(job);
    }
  });

  window.bbbApi.onJobCompleted((data) => {
    const job = jobsList.find(j => j.id === data.jobId);
    if (job) {
      job.status = 'completed';
      job.progress.percent = 100;
      job.outputPath = data.outputPath;
      job.chatPath = data.chatPath;
      job.pdfPath = data.pdfPath;
    }
    if (activeJob && activeJob.id === data.jobId) {
      activeJob = null;
      hideActiveCard();
    }
    renderQueue();
  });

  window.bbbApi.onJobFailed((data) => {
    const job = jobsList.find(j => j.id === data.jobId);
    if (job) {
      job.status = 'failed';
      job.error = data.error;
    }
    if (activeJob && activeJob.id === data.jobId) {
      activeJob = null;
      hideActiveCard();
    }
    renderQueue();
  });

  window.bbbApi.onJobCancelled((data) => {
    const job = jobsList.find(j => j.id === data.jobId);
    if (job) {
      job.status = 'cancelled';
    }
    if (activeJob && activeJob.id === data.jobId) {
      activeJob = null;
      hideActiveCard();
    }
    renderQueue();
  });
}

/**
 * Updates the Active Download hero section
 */
function updateActiveCard(job) {
  if (!job) {
    hideActiveCard();
    return;
  }

  activeCard.style.display = 'block';
  activeTitle.textContent = job.title || 'Processing Meeting';
  activeMeta.textContent = `Date: ${job.date} | Duration: ${formatTime(job.durationSeconds)}`;

  activeStage.textContent = job.progress.stageLabel || 'Processing...';

  const percent = job.progress.percent || 0;
  activePercent.textContent = `${percent}%`;
  activeFill.style.width = `${percent}%`;

  metricSpeed.textContent = job.progress.speed || (job.status === 'paused' ? 'Paused' : 'Calculating...');
  metricStatus.textContent = job.status === 'paused'
    ? 'Download Paused'
    : (job.mode === 'record'
      ? (job.progress.stage === 'muxing' ? 'Muxing Video' : 'Recording Player (Muted)')
      : (job.progress.stage === 'muxing' ? 'Muxing with FFmpeg' : 'Downloading Streams'));

  if (job.status === 'paused') {
    btnPauseActive.textContent = 'Resume';
    btnPauseActive.className = 'btn-resume';
    btnPauseActive.onclick = () => window.bbbApi.resumeJob(job.id);
  } else {
    btnPauseActive.textContent = 'Pause';
    btnPauseActive.className = 'btn-pause';
    btnPauseActive.onclick = () => window.bbbApi.pauseJob(job.id);
  }

  btnCancelActive.onclick = () => {
    if (confirm('Are you sure you want to cancel this download?')) {
      window.bbbApi.cancelJob(job.id);
    }
  };
}

function hideActiveCard() {
  activeCard.style.display = 'none';
}

/**
 * Renders the Queue list items
 */
function renderQueue() {
  queueCount.textContent = `${jobsList.length} ${jobsList.length === 1 ? 'item' : 'items'}`;

  const runningJob = jobsList.find(j => ['fetching', 'recording', 'muxing', 'paused'].includes(j.status));
  if (runningJob) {
    activeJob = runningJob;
    updateActiveCard(runningJob);
  } else if (!activeJob) {
    hideActiveCard();
  }

  if (jobsList.length === 0) {
    queueList.innerHTML = '';
    emptyQueue.style.display = 'flex';
    return;
  }

  emptyQueue.style.display = 'none';

  queueList.innerHTML = jobsList.map(job => {
    const statusMeta = STATUS_LABELS[job.status] || { text: job.status, class: '' };
    const isCompleted = job.status === 'completed';
    const isQueued = job.status === 'queued';
    const isPaused = job.status === 'paused';
    const isFailed = job.status === 'failed';

    return `
      <div class="queue-item animate-enter" data-id="${job.id}">
        <div class="queue-item-info">
          <div class="queue-item-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
          <div class="queue-item-meta">
            <span>Date: ${job.date}</span>
            <span>Duration: ${formatTime(job.durationSeconds)}</span>
            ${job.mode === 'record' ? '<span style="font-size:11px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,0.1);color:#ef4444;font-weight:700;">Live Record</span>' : ''}
            <span class="queue-item-status ${statusMeta.class}">
              ${statusMeta.text}
            </span>
            ${isFailed && job.error ? `<span style="color: var(--status-danger-text);" title="${escapeHtml(job.error)}">(${escapeHtml(job.error)})</span>` : ''}
          </div>
        </div>

        <div class="queue-item-actions">
          ${isCompleted && job.pdfPath ? `
            <button class="btn-open-pdf" title="Open Slides PDF Booklet" onclick="openTargetFile('${escapeQuotes(job.pdfPath)}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-left:2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
              PDF Booklet
            </button>
          ` : ''}

          ${isCompleted && job.outputPath ? `
            <button class="btn-open-folder" onclick="openTargetFolder('${escapeQuotes(job.outputPath)}')">
              Show in Folder
            </button>
          ` : ''}

          ${(isPaused || isFailed) ? `
            <button class="btn-resume" onclick="resumeQueueItem('${job.id}')">
              Resume
            </button>
            <button class="btn-cancel" onclick="cancelQueueItem('${job.id}')">
              Remove
            </button>
          ` : ''}

          ${isQueued ? `
            <button class="btn-cancel" onclick="cancelQueueItem('${job.id}')">
              Cancel
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.openTargetFolder = (path) => {
  window.bbbApi.openFolder(path);
};

window.openTargetFile = (path) => {
  window.bbbApi.openFile(path);
};

window.resumeQueueItem = (jobId) => {
  window.bbbApi.resumeJob(jobId);
};

window.cancelQueueItem = (jobId) => {
  window.bbbApi.cancelJob(jobId);
};

// Mode Switcher Logic
let currentMode = 'direct';

const modeTabDirect = document.getElementById('mode-tab-direct');
const modeTabRecord = document.getElementById('mode-tab-record');
const recordModeOptions = document.getElementById('record-mode-options');
const recordMuteSpeakers = document.getElementById('record-mute-speakers');
const modeHintText = document.getElementById('mode-hint-text');
const btnSubmitText = document.getElementById('btn-submit-text');

if (modeTabDirect && modeTabRecord) {
  modeTabDirect.addEventListener('click', () => {
    currentMode = 'direct';
    modeTabDirect.classList.add('active');
    modeTabRecord.classList.remove('active');
    if (recordModeOptions) recordModeOptions.style.display = 'none';
    if (btnSubmitText) btnSubmitText.textContent = 'Add to Queue';
    if (modeHintText) modeHintText.textContent = 'Direct media streams are downloaded at maximum network bandwidth and cleanly stitched with FFmpeg.';
  });

  modeTabRecord.addEventListener('click', () => {
    currentMode = 'record';
    modeTabRecord.classList.add('active');
    modeTabDirect.classList.remove('active');
    if (recordModeOptions) recordModeOptions.style.display = 'flex';
    if (btnSubmitText) btnSubmitText.textContent = 'Start Player Record';
    if (modeHintText) modeHintText.textContent = 'Headless player recording captures the full presentation canvas & instructor audio in the background with zero speaker noise.';
  });
}

// Form Submission (Add Job)
urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = inputUrl.value.trim();
  if (!url) return;

  btnSubmit.disabled = true;
  btnSubmit.innerHTML = `
    <span class="animate-spin" style="display:inline-block;width:14px;height:14px;border:2px solid #ffffff;border-top-color:transparent;border-radius:50%;"></span>
    Checking...
  `;

  try {
    await window.bbbApi.addJob(url, {
      mode: currentMode,
      muteSpeaker: recordMuteSpeakers ? recordMuteSpeakers.checked : true
    });
    inputUrl.value = '';
  } catch (err) {
    alert(`Failed to add meeting: ${err.message}`);
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>
      <span id="btn-submit-text">${currentMode === 'record' ? 'Start Player Record' : 'Add to Queue'}</span>
    `;
  }
});

// Settings Management
function updateSettingsForm(settings) {
  if (settings.outputDirectory) settingOutputDir.value = settings.outputDirectory;
  if (typeof settings.enableNotification === 'boolean') settingNotify.checked = settings.enableNotification;
  if (typeof settings.saveChat === 'boolean') settingChat.checked = settings.saveChat;
  if (typeof settings.generateSlidePdf === 'boolean' && settingSlidePdf) settingSlidePdf.checked = settings.generateSlidePdf;
  if (typeof settings.muteSpeakerRecording === 'boolean' && settingMuteSpeakers) settingMuteSpeakers.checked = settings.muteSpeakerRecording;
  settingWebcamVideo.checked = !!settings.includeWebcamVideo;
  if (settingLmsPortalUrl) settingLmsPortalUrl.value = settings.lmsPortalUrl || '';
}

btnOpenSettings.addEventListener('click', () => {
  updateSettingsForm(currentSettings);
  settingsModal.classList.add('active');
});

btnCloseSettings.addEventListener('click', () => {
  settingsModal.classList.remove('active');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.remove('active');
  }
});

btnBrowseDir.addEventListener('click', async () => {
  const selectedPath = await window.bbbApi.selectDirectory();
  if (selectedPath) {
    settingOutputDir.value = selectedPath;
  }
});

btnSaveSettings.addEventListener('click', async () => {
  const newSettings = {
    outputDirectory: settingOutputDir.value.trim(),
    enableNotification: settingNotify.checked,
    saveChat: settingChat.checked,
    generateSlidePdf: settingSlidePdf ? settingSlidePdf.checked : true,
    muteSpeakerRecording: settingMuteSpeakers ? settingMuteSpeakers.checked : true,
    includeWebcamVideo: settingWebcamVideo.checked,
    lmsPortalUrl: settingLmsPortalUrl ? settingLmsPortalUrl.value.trim() : ''
  };

  currentSettings = await window.bbbApi.saveSettings(newSettings);
  settingsModal.classList.remove('active');
  await updateLMSStatus();
});

btnOpenOutputDir.addEventListener('click', () => {
  if (currentSettings.outputDirectory) {
    window.bbbApi.openFolder(currentSettings.outputDirectory);
  }
});

// LMS Portal Management
async function updateLMSStatus() {
  try {
    if (!window.bbbApi.getLMSStatus) return;
    const portalUrl = currentSettings ? currentSettings.lmsPortalUrl : '';
    const hasSession = await window.bbbApi.getLMSStatus(portalUrl);
    if (hasSession) {
      if (lmsStatusIndicator) lmsStatusIndicator.classList.add('active');
      if (lmsBtnText) lmsBtnText.textContent = 'LMS Connected';
    } else {
      if (lmsStatusIndicator) lmsStatusIndicator.classList.remove('active');
      if (lmsBtnText) lmsBtnText.textContent = 'LMS Login';
    }
  } catch (err) {
    console.warn('Failed to check LMS status:', err);
  }
}

if (btnOpenLMS) {
  btnOpenLMS.addEventListener('click', async () => {
    await window.bbbApi.openLMSBrowser(currentSettings.lmsPortalUrl || '');
    setTimeout(updateLMSStatus, 3000);
    setTimeout(updateLMSStatus, 8000);
  });
}

if (btnSettingsOpenLMS) {
  btnSettingsOpenLMS.addEventListener('click', async () => {
    await window.bbbApi.openLMSBrowser(currentSettings.lmsPortalUrl || '');
    setTimeout(updateLMSStatus, 3000);
    setTimeout(updateLMSStatus, 8000);
  });
}

if (btnClearLMSSession) {
  btnClearLMSSession.addEventListener('click', async () => {
    if (confirm('Clear saved LMS portal session and stored authentication cookies?')) {
      await window.bbbApi.clearLMSSession();
      await updateLMSStatus();
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

function escapeQuotes(str) {
  return str ? str.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';
}

// Start
initApp();
