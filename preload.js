/**
 * preload.js — 보안 브릿지
 *
 * contextIsolation: true 환경에서 renderer(웹페이지)가
 * Node.js / Electron API를 안전하게 사용할 수 있도록
 * 허용된 함수만 window.electronAPI 로 노출합니다.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── 설정 저장소 ──────────────────────────────
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),

  // ── 파일 다이얼로그 ───────────────────────────
  openVideoDialog: () => ipcRenderer.invoke('dialog-open-video'),
  saveImageDialog: (defaultName) => ipcRenderer.invoke('dialog-save-image', defaultName),
  saveImageFile: (filePath, base64Data) => ipcRenderer.invoke('save-image-file', filePath, base64Data),

  // ── FFmpeg ───────────────────────────────────
  ffprobeVideo: (videoPath) => ipcRenderer.invoke('ffmpeg-probe', videoPath),
  detectCuts: (videoPath) => ipcRenderer.invoke('ffmpeg-detect-cuts', videoPath),
  extractFrame: (videoPath, timestamp) => ipcRenderer.invoke('ffmpeg-extract-frame', videoPath, timestamp),
  extractFramesBatch: (videoPath, timestamps) => ipcRenderer.invoke('ffmpeg-extract-frames-batch', videoPath, timestamps),
  compressVideoForUpload: (videoPath) => ipcRenderer.invoke('ffmpeg-compress-video', videoPath),
  deleteTempFile: (filePath) => ipcRenderer.invoke('ffmpeg-delete-temp', filePath),

  // ── 진행률 이벤트 수신 ─────────────────────────
  onBatchProgress: (callback) => {
    ipcRenderer.on('ffmpeg-batch-progress', (_, data) => callback(data));
  },
  offBatchProgress: () => {
    ipcRenderer.removeAllListeners('ffmpeg-batch-progress');
  },
  onCompressProgress: (callback) => {
    ipcRenderer.on('ffmpeg-compress-progress', (_, data) => callback(data));
  },
  offCompressProgress: () => {
    ipcRenderer.removeAllListeners('ffmpeg-compress-progress');
  },

  // ── 앱 경로 ──────────────────────────────────
  getAppDir: () => ipcRenderer.invoke('get-app-dir'),

  // ── 플랫폼 정보 ───────────────────────────────
  platform: process.platform,
});
