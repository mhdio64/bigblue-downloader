# Technical & Functional Specifications: BigBlueButton Downloader

This document defines the functional requirements, data models, state machines, and edge cases for **BigBlueButton Downloader**.

---

## 1. Product Objectives & Quality Indicators

* **Primary Objective**: Download BigBlueButton recorded sessions into clean, high-definition MP4 videos, presentation PDF booklets, and text chat logs.
* **Visual Fidelity**: 1080p Full HD (1920x1080) for sharp legibility of small equations, diagrams, and text on slides and whiteboard.
* **Audio Fidelity**: Lossless extraction and synchronization of the original audio stream without quality-degrading re-compression.
* **Dual Capture Modes**:
  * **Direct Stream Mode**: Fast concurrent HTTP chunk downloads and FFmpeg muxing in minutes.
  * **Live In-App Player Recorder**: Headless browser recording for dynamic whiteboard/screen-share switching.

---

## 2. Data Models

### 2.1. `DownloadJob` Data Structure
```typescript
interface DownloadJob {
  id: string; // Unique job ID (UUID or timestamp-based)
  url: string; // BBB playback URL
  mode: 'direct' | 'record'; // Download mode
  meetingId: string; // Extracted meeting ID
  title: string; // Meeting title from metadata.xml
  date: string; // Meeting date (YYYY-MM-DD)
  durationSeconds: number; // Total duration in seconds
  status: JobStatus;
  progress: {
    percent: number; // 0 to 100
    stage: JobStage;
    speed: string; // Current transfer rate (e.g., "5.4 MB/s")
    etaSeconds: number; // Estimated remaining seconds
    currentTimestamp: number; // Current processing position
  };
  outputPath?: string; // Generated MP4 file path
  chatPath?: string; // Generated chat log path
  pdfPath?: string; // Generated slides PDF booklet path
  error?: string; // Error message on failure
  createdAt: number;
}

type JobStatus = 
  | 'queued'
  | 'fetching'
  | 'downloading'
  | 'recording'
  | 'muxing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

type JobStage = 
  | 'metadata' 
  | 'media_download' 
  | 'slides_synthesizing' 
  | 'pdf_generation' 
  | 'chat_export' 
  | 'muxing' 
  | 'finalizing';
```

### 2.2. Application Settings (`AppSettings`)
```typescript
interface AppSettings {
  outputDirectory: string; // Default output folder (~/Downloads/BigBlueButton)
  maxConcurrentJobs: number; // Concurrent downloads (default: 1)
  enableNotification: boolean; // OS desktop notification on complete (default: true)
  saveChat: boolean; // Save public chat log (default: true)
  generateSlidePdf: boolean; // Generate slides PDF booklet (default: true)
  muteSpeakersDuringRecording: boolean; // Mute speaker playback in live recording (default: true)
  lmsPortalUrl: string; // University portal URL for quick login
}
```

---

## 3. Job Processing State Machine

```
       [ User: Add Job ]
               │
               ▼
           ( QUEUED ) ──[ User: Cancel ]──► ( CANCELLED )
               │
      [ Worker Available ]
               │
               ▼
          ( FETCHING ) ──[ Network / Invalid Link ]──► ( FAILED )
               │
               ├─────────────────────────┐
               ▼ (Direct Mode)           ▼ (Record Mode)
        ( DOWNLOADING )           ( RECORDING )
               │                         │
               ├────────────┬────────────┘
               │            │
         [ User: Pause ]    │
               │            │
               ▼            │
           ( PAUSED )       │
               │            │
         [ User: Resume ]   │
               │            │
               ▼            ▼
                 ( MUXING )
                     │
                     ▼
                ( COMPLETED )
                     │
          [ Native OS Notification ]
```

---

## 4. File Naming Conventions

* Output Directory: `~/Downloads/BigBlueButton/`
* Video file:
  ```text
  [YYYY-MM-DD] - [Meeting Title] - [MeetingID_Short].mp4
  ```
* Chat file:
  ```text
  [YYYY-MM-DD] - [Meeting Title] - [MeetingID_Short] - Chat.txt
  ```
* PDF Booklet file:
  ```text
  [YYYY-MM-DD] - [Meeting Title] - [MeetingID_Short] - Slides.pdf
  ```
* Sanitization: Invalid filesystem characters (`/`, `\`, `?`, `*`, `:`, `|`, `"`, `<`, `>`, `0x00`) are replaced with safe characters.

---

## 5. Edge Cases & Resilience

| Scenario | Expected State | Behavior |
| :--- | :--- | :--- |
| Network disconnect | Retry with Backoff | Automatically waits and retries up to 60 seconds with exponential backoff before marking failed |
| Missing webcam stream | Normal Execution | Renders screen-share / presentation in full layout without PiP frame |
| Missing deskshare | Normal Execution | Renders slides timeline or webcam video directly |
| Missing public chat | Normal Execution | Completes video processing without throwing errors |
| User cancellation | Instant Cleanup | Terminates FFmpeg binary and deletes temporary files in `tmp/<jobId>/` |
| Application quit | Graceful Shutdown | Electron `before-quit` handler terminates child processes and cleans temporary assets |
