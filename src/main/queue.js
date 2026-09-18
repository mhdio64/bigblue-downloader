const os = require('os');
const path = require('path');
const fs = require('fs');
const { setMaxListeners } = require('events');
const { getMeetingMetadata } = require('./metadata');
const { downloadMeetingMedia } = require('./media-downloader');
const { exportMeetingChat } = require('./chat');
const { stitchMediaStreams } = require('./muxer');
const { sendDesktopNotification } = require('./notifications');
const { getLMSCookies } = require('./lms-browser');
const {
  fetchSlideTimeline,
  fetchDeskshareTimeline,
  downloadPresentationSlides,
  generateSlidesConcat
} = require('./presentation');
const { generateSlidePdf } = require('./pdf');
const { recordMeetingPlayer } = require('./player-recorder');

class QueueManager {
  /**
   * @param {Electron.BrowserWindow} mainWindow Reference to main UI window for IPC events
   */
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.jobs = new Map();
    this.activeJobId = null;
    this.abortControllers = new Map();

    const homeDir = os.homedir();
    this.settings = {
      outputDirectory: path.join(homeDir, 'Downloads', 'BigBlueButton'),
      enableNotification: true,
      saveChat: true,
      generateSlidePdf: true, // Automatically generate slide booklet PDF
      muteSpeakerRecording: true, // Mute local speakers during live player recording
      includeWebcamVideo: false, // Default: main screen presentation and teacher audio only
      lmsPortalUrl: '' // University portal or LMS URL
    };

    // Ensure output directory exists
    if (!fs.existsSync(this.settings.outputDirectory)) {
      try {
        fs.mkdirSync(this.settings.outputDirectory, { recursive: true });
      } catch (err) {
        console.error('Failed to create default output directory:', err);
      }
    }
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  sendToUI(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    if (!fs.existsSync(this.settings.outputDirectory)) {
      try {
        fs.mkdirSync(this.settings.outputDirectory, { recursive: true });
      } catch (e) {
        console.error('Failed to create output directory:', e);
      }
    }
    return this.settings;
  }

  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  /**
   * Adds a new BBB URL to the download queue
   * @param {string} rawUrl 
   * @param {object} [options]
   */
  async addJob(rawUrl, options = {}) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const mode = options.mode || 'direct';
    const muteSpeaker = typeof options.muteSpeaker === 'boolean' 
      ? options.muteSpeaker 
      : (this.settings.muteSpeakerRecording !== false);

    // If cookies were not explicitly provided, attempt to pull any stored LMS session cookies
    let cookies = options.cookies || '';
    if (!cookies) {
      try {
        cookies = await getLMSCookies(rawUrl);
      } catch (e) {
        console.warn('Could not auto-fetch LMS cookies:', e.message);
      }
    }

    const job = {
      id: jobId,
      url: rawUrl,
      mode: mode,
      muteSpeaker: muteSpeaker,
      meetingId: '',
      title: mode === 'record' ? 'Player Recording...' : 'Fetching meeting metadata...',
      date: new Date().toISOString().split('T')[0],
      durationSeconds: 0,
      status: 'fetching',
      cookies: cookies,
      progress: {
        percent: 0,
        stage: 'metadata',
        stageLabel: 'Fetching metadata...',
        speed: '',
        etaSeconds: 0
      },
      createdAt: Date.now()
    };

    this.jobs.set(jobId, job);
    this.sendToUI('bbb:job-added', job);

    try {
      let meta = null;
      try {
        meta = await getMeetingMetadata(rawUrl, { cookies: job.cookies });
      } catch (metaErr) {
        if (mode === 'record') {
          console.warn('Metadata fetch failed, fallback for player recorder:', metaErr.message);
          meta = {
            meetingId: 'recording',
            title: 'BigBlueButton Live Recording',
            date: new Date().toISOString().split('T')[0],
            durationSeconds: 0,
            baseUrl: rawUrl,
            playbackUrl: rawUrl
          };
        } else {
          throw metaErr;
        }
      }

      job.meetingId = meta.meetingId;
      job.title = meta.title;
      job.date = meta.date;
      job.durationSeconds = meta.durationSeconds;
      job.baseUrl = meta.baseUrl;
      job.playbackUrl = meta.playbackUrl;
      job.status = 'queued';
      job.progress.stage = 'queued';
      job.progress.stageLabel = mode === 'record' ? 'Queued for live player recording...' : 'Waiting in queue...';

      this.sendToUI('bbb:job-updated', job);
      this.processNext();
      return job;
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || 'Failed to fetch meeting metadata.';
      this.sendToUI('bbb:job-failed', { jobId, error: job.error });
      throw err;
    }
  }

  /**
   * Cancels a job and cleans up resources
   * @param {string} jobId 
   */
  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (this.activeJobId === jobId) {
      const controller = this.abortControllers.get(jobId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(jobId);
      }
    }

    job.status = 'cancelled';
    this.cleanupTempDir(jobId);

    if (this.activeJobId === jobId) {
      this.activeJobId = null;
    }

    this.sendToUI('bbb:job-cancelled', { jobId });
    this.processNext();
  }

  /**
   * Pauses an active or queued job while preserving downloaded partial files
   * @param {string} jobId 
   */
  async pauseJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'paused';
    job.progress.stageLabel = 'Paused';
    job.progress.speed = '';

    if (this.activeJobId === jobId) {
      const controller = this.abortControllers.get(jobId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(jobId);
      }
      this.activeJobId = null;
    }

    this.sendToUI('bbb:job-updated', job);
    this.processNext();
  }

  /**
   * Resumes a paused or failed job
   * @param {string} jobId 
   */
  async resumeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'queued';
    job.progress.stage = 'queued';
    job.progress.stageLabel = 'Waiting in queue...';
    job.error = null;

    this.sendToUI('bbb:job-updated', job);
    this.processNext();
  }

  /**
   * Processes the next queued job sequentially
   */
  async processNext() {
    if (this.activeJobId) {
      return; // Busy
    }

    const nextJob = Array.from(this.jobs.values()).find(j => j.status === 'queued');
    if (!nextJob) {
      return; // Done
    }

    this.activeJobId = nextJob.id;
    const jobId = nextJob.id;
    const controller = new AbortController();
    try {
      setMaxListeners(50, controller.signal);
    } catch {}
    this.abortControllers.set(jobId, controller);

    const tempDir = path.join(os.tmpdir(), `bbb_${jobId}`);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (err) {
      console.error('Failed to create temp directory:', err);
    }

    try {
      // Handle In-App Player Recorder Mode
      if (nextJob.mode === 'record') {
        nextJob.status = 'recording';
        nextJob.progress.stage = 'player_recording';
        nextJob.progress.stageLabel = 'Recording live player in background...';
        this.sendToUI('bbb:job-progress', {
          jobId,
          stage: 'player_recording',
          stageLabel: 'Recording live player in background...',
          percent: 5,
          speed: '1x'
        });

        const safeBaseName = `${nextJob.date} - ${nextJob.title} - ${nextJob.meetingId ? nextJob.meetingId.substring(0, 6) : 'rec'}`;
        const finalMp4Path = path.join(this.settings.outputDirectory, `${safeBaseName}.mp4`);

        await recordMeetingPlayer(nextJob.playbackUrl || nextJob.url, {
          outputPath: finalMp4Path,
          tempDir,
          cookies: nextJob.cookies,
          muteSpeaker: nextJob.muteSpeaker !== false,
          signal: controller.signal,
          onProgress: (p) => {
            this.sendToUI('bbb:job-progress', {
              jobId,
              stage: p.stage,
              stageLabel: p.stageLabel,
              percent: p.percent,
              speed: p.speed || '1x'
            });
          }
        });

        // Optional Chat & Slides export if metadata/base url is present
        let finalChatPath = null;
        let finalPdfPath = null;
        try {
          if (this.settings.saveChat && nextJob.baseUrl) {
            const tempChatPath = path.join(tempDir, 'chat.txt');
            const chatSaved = await exportMeetingChat(nextJob.baseUrl, tempChatPath, { cookies: nextJob.cookies });
            if (chatSaved && fs.existsSync(chatSaved)) {
              finalChatPath = path.join(this.settings.outputDirectory, `${safeBaseName} - Chat.txt`);
              fs.copyFileSync(chatSaved, finalChatPath);
            }
          }
        } catch {}

        try {
          if (this.settings.generateSlidePdf && nextJob.baseUrl) {
            const slideTimeline = await fetchSlideTimeline(nextJob.baseUrl, { cookies: nextJob.cookies });
            if (slideTimeline && slideTimeline.hasSlides) {
              const downloadedSlides = await downloadPresentationSlides(slideTimeline.slides, tempDir, { cookies: nextJob.cookies });
              const uniqueSlidePaths = [];
              const savedUrls = new Set();
              for (const s of downloadedSlides) {
                if (!savedUrls.has(s.fullUrl) && s.localPath && fs.existsSync(s.localPath)) {
                  savedUrls.add(s.fullUrl);
                  uniqueSlidePaths.push(s.localPath);
                }
              }
              if (uniqueSlidePaths.length > 0) {
                const targetPdfPath = path.join(this.settings.outputDirectory, `${safeBaseName} - Slides.pdf`);
                finalPdfPath = await generateSlidePdf(uniqueSlidePaths, {
                  title: nextJob.title,
                  date: nextJob.date,
                  durationFormatted: formatTime(nextJob.durationSeconds)
                }, targetPdfPath, tempDir);
              }
            }
          }
        } catch {}

        this.cleanupTempDir(jobId);

        nextJob.status = 'completed';
        nextJob.progress.percent = 100;
        nextJob.progress.stage = 'finalizing';
        nextJob.progress.stageLabel = 'Completed';
        nextJob.outputPath = finalMp4Path;
        nextJob.chatPath = finalChatPath;
        nextJob.pdfPath = finalPdfPath;

        this.sendToUI('bbb:job-completed', {
          jobId,
          outputPath: finalMp4Path,
          chatPath: finalChatPath,
          pdfPath: finalPdfPath
        });

        if (this.settings.enableNotification) {
          sendDesktopNotification(
            'BigBlueButton Recording Complete',
            `Recording "${nextJob.title}" has been captured and saved successfully.`
          );
        }

        this.activeJobId = null;
        this.processNext();
        return;
      }

      // 1. Export Chat if enabled
      let chatSavedPath = null;
      if (this.settings.saveChat) {
        nextJob.status = 'recording'; // Processing
        nextJob.progress.stage = 'chat_export';
        nextJob.progress.stageLabel = 'Exporting public chat log...';
        this.sendToUI('bbb:job-progress', {
          jobId,
          stage: 'chat_export',
          stageLabel: 'Exporting public chat log...',
          percent: 5,
          speed: ''
        });

        const tempChatPath = path.join(tempDir, 'chat.txt');
        try {
          chatSavedPath = await exportMeetingChat(nextJob.baseUrl, tempChatPath, {
            cookies: nextJob.cookies
          });
        } catch (e) {
          console.warn('Chat export skipped:', e.message);
        }
      }

      // 2. Extract Presentation Slides if available
      let downloadedSlides = [];

      try {
        const slideTimeline = await fetchSlideTimeline(nextJob.baseUrl, {
          cookies: nextJob.cookies
        });

        if (slideTimeline.hasSlides) {
          nextJob.progress.stage = 'downloading_slides';
          nextJob.progress.stageLabel = 'Downloading presentation slides...';
          this.sendToUI('bbb:job-progress', {
            jobId,
            stage: 'downloading_slides',
            stageLabel: 'Downloading presentation slides...',
            percent: 10,
            speed: ''
          });

          downloadedSlides = await downloadPresentationSlides(slideTimeline.slides, tempDir, {
            cookies: nextJob.cookies,
            signal: controller.signal,
            onProgress: (p) => {
              this.sendToUI('bbb:job-progress', {
                jobId,
                stage: 'downloading_slides',
                stageLabel: `Downloading slide ${p.completed}/${p.total}`,
                percent: 10 + Math.round((p.percent / 100) * 10), // 10% to 20%
                speed: ''
              });
            }
          });
        }
      } catch (err) {
        console.warn('Slide extraction skipped:', err.message);
      }

      // 3. Directly download media streams (Deskshare, Webcam, Audio)
      nextJob.progress.stage = 'downloading_media';
      nextJob.progress.stageLabel = 'Downloading media streams...';
      this.sendToUI('bbb:job-progress', {
        jobId,
        stage: 'downloading_media',
        stageLabel: 'Downloading media streams...',
        percent: 20,
        speed: ''
      });

      const mediaPaths = await downloadMeetingMedia(nextJob.baseUrl, tempDir, {
        cookies: nextJob.cookies,
        signal: controller.signal,
        onProgress: (info) => {
          // info.percent is 0-100 across download tasks
          const scaledPercent = 20 + Math.round(info.percent * 0.55); // 20% to 75%
          this.sendToUI('bbb:job-progress', {
            jobId,
            stage: 'downloading_media',
            stageLabel: info.label,
            percent: scaledPercent,
            speed: info.speedStr
          });
        }
      });

      // 4. Stitch downloaded files with FFmpeg
      nextJob.progress.stage = 'muxing';
      nextJob.progress.stageLabel = 'Composing video and audio with FFmpeg...';
      this.sendToUI('bbb:job-progress', {
        jobId,
        stage: 'muxing',
        stageLabel: 'Composing video and audio with FFmpeg...',
        percent: 78,
        speed: 'Processing'
      });

      const safeBaseName = `${nextJob.date} - ${nextJob.title} - ${nextJob.meetingId.substring(0, 6)}`;
      const finalMp4Path = path.join(this.settings.outputDirectory, `${safeBaseName}.mp4`);

      // If slides exist, export them to a high-resolution companion folder and generate PDF booklet
      let slidesConcatPath = null;
      let finalPdfPath = null;
      if (downloadedSlides && downloadedSlides.length > 0) {
        const uniqueSlidePaths = [];
        try {
          const outputSlidesDir = path.join(this.settings.outputDirectory, `${safeBaseName} - Slides`);
          if (!fs.existsSync(outputSlidesDir)) {
            fs.mkdirSync(outputSlidesDir, { recursive: true });
          }
          const savedUrls = new Set();
          let slideNum = 1;
          for (const s of downloadedSlides) {
            if (!savedUrls.has(s.fullUrl) && s.localPath && fs.existsSync(s.localPath)) {
              savedUrls.add(s.fullUrl);
              uniqueSlidePaths.push(s.localPath);
              const ext = path.extname(s.localPath) || '.png';
              const destFile = path.join(outputSlidesDir, `Slide_${String(slideNum++).padStart(2, '0')}${ext}`);
              fs.copyFileSync(s.localPath, destFile);
            }
          }
        } catch (e) {
          console.warn('Could not export slides folder:', e.message);
        }

        // Generate high-resolution PDF booklet from presentation slides
        if (this.settings.generateSlidePdf !== false && uniqueSlidePaths.length > 0) {
          try {
            const targetPdfPath = path.join(this.settings.outputDirectory, `${safeBaseName} - Slides.pdf`);
            finalPdfPath = await generateSlidePdf(uniqueSlidePaths, {
              title: nextJob.title,
              date: nextJob.date,
              durationFormatted: formatTime(nextJob.durationSeconds)
            }, targetPdfPath, tempDir);
          } catch (pdfErr) {
            console.warn('Failed to generate slide PDF booklet:', pdfErr.message);
          }
        }

        // If no screenshare video was recorded for this session, compose the video from slides
        if (!mediaPaths.desksharePath) {
          slidesConcatPath = generateSlidesConcat(downloadedSlides, nextJob.durationSeconds, tempDir);
        }
      }

      await stitchMediaStreams({
        desksharePath: mediaPaths.desksharePath,
        webcamPath: mediaPaths.webcamPath,
        audioPath: mediaPaths.audioPath,
        slidesConcatPath,
        outputPath: finalMp4Path
      }, {
        includeWebcamVideo: !!this.settings.includeWebcamVideo,
        totalDuration: nextJob.durationSeconds,
        signal: controller.signal,
        onProgress: (percent) => {
          const scaledPercent = 78 + Math.round(percent * 0.21); // 78% to 99%
          this.sendToUI('bbb:job-progress', {
            jobId,
            stage: 'muxing',
            stageLabel: `Composing media tracks (${percent}%)...`,
            percent: scaledPercent,
            speed: 'FFmpeg'
          });
        }
      });

      // 4. Save chat file if exported
      let finalChatPath = null;
      if (chatSavedPath && fs.existsSync(chatSavedPath)) {
        finalChatPath = path.join(this.settings.outputDirectory, `${safeBaseName} - Chat.txt`);
        fs.copyFileSync(chatSavedPath, finalChatPath);
      }

      // 5. Cleanup temporary folder
      this.cleanupTempDir(jobId);

      // 6. Mark Completed
      nextJob.status = 'completed';
      nextJob.progress.percent = 100;
      nextJob.progress.stage = 'finalizing';
      nextJob.progress.stageLabel = 'Completed';
      nextJob.outputPath = finalMp4Path;
      nextJob.chatPath = finalChatPath;
      nextJob.pdfPath = finalPdfPath;

      this.sendToUI('bbb:job-completed', {
        jobId,
        outputPath: finalMp4Path,
        chatPath: finalChatPath,
        pdfPath: finalPdfPath
      });

      // 7. Desktop notification
      if (this.settings.enableNotification) {
        sendDesktopNotification(
          'BigBlueButton Download Complete',
          `Recording "${nextJob.title}" has been saved successfully.`
        );
      }
    } catch (err) {
      if (nextJob.status === 'paused') {
        // Paused intentionally: retain downloaded chunks for seamless resume!
        this.sendToUI('bbb:job-updated', nextJob);
      } else if (controller.signal.aborted) {
        nextJob.status = 'cancelled';
        this.cleanupTempDir(jobId);
        this.sendToUI('bbb:job-cancelled', { jobId });
      } else {
        nextJob.status = 'failed';
        nextJob.error = err.message || 'Error processing and downloading media files.';
        this.sendToUI('bbb:job-failed', { jobId, error: nextJob.error });
        // Preserve temp dir on network failure so user can click Resume!
      }
    } finally {
      this.abortControllers.delete(jobId);
      this.activeJobId = null;
      this.processNext();
    }
  }

  cleanupTempDir(jobId) {
    const tempDir = path.join(os.tmpdir(), `bbb_${jobId}`);
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`Failed to remove temp dir ${tempDir}:`, e.message);
    }
  }
}

module.exports = QueueManager;
