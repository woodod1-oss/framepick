const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

const resolveUnpackedPath = (binaryPath) => (
  binaryPath ? binaryPath.replace('app.asar', 'app.asar.unpacked') : binaryPath
);

// ffmpeg / ffprobe 바이너리 경로 설정
ffmpeg.setFfmpegPath(resolveUnpackedPath(ffmpegStatic));
ffmpeg.setFfprobePath(resolveUnpackedPath(ffprobeInstaller.path));

// API 키 등 설정 저장소 (암호화 없이 로컬 저장)
const store = new Store();

// 임시 파일 안전 삭제 헬퍼 (FFmpeg 임시 jpg/mp4 정리)
const safeCleanup = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    // 삭제 실패는 무시 (임시 파일이라 OS가 결국 정리)
    console.warn('safeCleanup 실패:', filePath, e.message);
  }
};

const isManagedTempFile = (filePath) => {
  if (!filePath || typeof filePath !== 'string') return false;
  const tempDir = path.resolve(app.getPath('temp'));
  const targetPath = path.resolve(filePath);
  return targetPath.startsWith(`${tempDir}${path.sep}`) && path.basename(targetPath).startsWith('twb_');
};

const cleanupStaleTempFiles = () => {
  try {
    const tempDir = app.getPath('temp');
    for (const entry of fs.readdirSync(tempDir)) {
      if (!entry.startsWith('twb_')) continue;
      const filePath = path.join(tempDir, entry);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) safeCleanup(filePath);
    }
  } catch (e) {
    console.warn('stale temp cleanup 실패:', e.message);
  }
};

const isSafeExternalUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    titleBarStyle: 'hiddenInset', // macOS 네이티브 스타일
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 보안: renderer와 Node.js 격리
      nodeIntegration: false,   // 보안: renderer에서 Node.js 직접 접근 차단
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url === currentUrl) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  // 개발 시 DevTools 열기 (주석 해제해서 사용)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  cleanupStaleTempFiles();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC 핸들러: renderer ↔ main 통신 ────────────────────────────────────

// API 키 저장 / 불러오기
ipcMain.handle('store-get', (_, key) => store.get(key));
ipcMain.handle('store-set', (_, key, value) => store.set(key, value));

// 파일 열기 다이얼로그
ipcMain.handle('dialog-open-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '영상 파일 선택',
    filters: [{ name: '영상', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// 저장 다이얼로그 (썸네일 이미지 저장)
ipcMain.handle('dialog-save-image', async (_, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '썸네일 저장',
    defaultPath: defaultName || 'thumbnail.jpg',
    filters: [{ name: '이미지', extensions: ['jpg', 'png'] }],
  });
  if (result.canceled) return null;
  return result.filePath;
});

// Base64 이미지를 파일로 저장
ipcMain.handle('save-image-file', async (_, filePath, base64Data) => {
  try {
    const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    fs.writeFileSync(filePath, buffer);
    return true;
  } catch (e) {
    console.error('save-image-file 실패:', e.message);
    return false;
  }
});

// ─── FFmpeg 프레임 추출 (핵심 성능 개선) ────────────────────────────────

// 단일 타임스탬프에서 프레임 추출 → base64 반환
ipcMain.handle('ffmpeg-extract-frame', async (_, videoPath, timestamp) => {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(app.getPath('temp'), `twb_frame_${Date.now()}.jpg`);
    ffmpeg(videoPath)
      .seekInput(timestamp)
      .frames(1)
      .size('1280x?')           // 너비 1280 고정, 비율 유지
      .outputOptions(['-q:v 2']) // JPEG 품질 (2=고품질)
      .output(tmpPath)
      .on('end', () => {
        try {
          const data = fs.readFileSync(tmpPath);
          const base64 = `data:image/jpeg;base64,${data.toString('base64')}`;
          safeCleanup(tmpPath);
          resolve(base64);
        } catch (e) {
          safeCleanup(tmpPath);
          reject(e);
        }
      })
      .on('error', (err) => { safeCleanup(tmpPath); reject(err); })
      .run();
  });
});

// 씬 감지로 컷 밀도 분석 → 적응형 샘플링 간격 반환
ipcMain.handle('ffmpeg-detect-cuts', async (_, videoPath) => {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return resolve({ interval: 0.7, label: '중간 (기본값)', avgCutDuration: null, cutCount: 0 });
      const duration = metadata.format.duration || 60;
      const cutTimestamps = [];
      const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';

      ffmpeg(videoPath)
        .outputOptions([
          '-vf', 'select=gt(scene\\,0.35),showinfo',
          '-vsync', 'vfr',
          '-an',
          '-f', 'null',
        ])
        .output(nullOut)
        .on('stderr', (line) => {
          const match = line.match(/pts_time:([\d.]+)/);
          if (match) cutTimestamps.push(parseFloat(match[1]));
        })
        .on('end', () => {
          const cutCount = cutTimestamps.length;
          const avgCutDuration = cutCount > 0 ? duration / (cutCount + 1) : duration;
          let interval, label;
          if (avgCutDuration < 3)       { interval = 0.5; label = '빠른 편집'; }
          else if (avgCutDuration < 8)  { interval = 1.5; label = '중간'; }
          else                          { interval = 3.0; label = '롱테이크'; }
          resolve({
            interval,
            label,
            avgCutDuration: Math.round(avgCutDuration * 10) / 10,
            cutCount,
            duration,
          });
        })
        .on('error', (e) => {
          console.error('컷 감지 실패:', e.message);
          resolve({ interval: 0.7, label: '중간 (감지 실패)', avgCutDuration: null, cutCount: 0 });
        })
        .run();
    });
  });
});

// 영상 메타데이터 (duration, fps, 해상도) 조회
ipcMain.handle('ffmpeg-probe', async (_, videoPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const stream = metadata.streams.find((s) => s.codec_type === 'video');
      const fpsStr = stream?.r_frame_rate || '30/1';
      const [num, den] = fpsStr.split('/').map(Number);
      resolve({
        duration: metadata.format.duration,
        fps: den ? num / den : 30,
        width: stream?.width,
        height: stream?.height,
      });
    });
  });
});

// ─── Video-AI용: 업로드 전 용량 초과 영상 자동 압축 ──────────────────────────
// 2GB 제한 초과 시 720p + 1.5Mbps로 재인코딩 → 임시 파일 경로 반환
ipcMain.handle('ffmpeg-compress-video', async (event, videoPath) => {
  const stat = fs.statSync(videoPath);
  const SIZE_LIMIT = 1.8 * 1024 * 1024 * 1024; // 1.8GB (여유 마진)

  if (stat.size <= SIZE_LIMIT) {
    // 압축 불필요 → 원본 경로 그대로 반환
    return { compressed: false, path: videoPath, originalSize: stat.size };
  }

  const tmpPath = path.join(app.getPath('temp'), `twb_compressed_${Date.now()}.mp4`);

  await new Promise((resolve, reject) => {
    let lastProgress = 0;
    ffmpeg(videoPath)
      .videoCodec('libx264')
      .videoBitrate('1500k')            // 1.5Mbps → 2시간 영상도 ~1.4GB
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        '-vf', 'scale=\'min(1280,iw):-2\'',  // 최대 720p, 작은 영상은 그대로
        '-preset', 'fast',                     // 속도 우선 (ultrafast보다 약간 나은 품질)
        '-movflags', '+faststart',
      ])
      .output(tmpPath)
      .on('progress', (p) => {
        const pct = Math.round(p.percent || 0);
        if (pct !== lastProgress) {
          lastProgress = pct;
          event.sender.send('ffmpeg-compress-progress', { percent: pct });
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const compressedStat = fs.statSync(tmpPath);
  return {
    compressed: true,
    path: tmpPath,
    originalSize: stat.size,
    compressedSize: compressedStat.size,
  };
});

// 압축 임시 파일 삭제
ipcMain.handle('ffmpeg-delete-temp', async (_, filePath) => {
  if (!isManagedTempFile(filePath)) {
    console.warn('ffmpeg-delete-temp 차단:', filePath);
    return false;
  }
  safeCleanup(filePath);
  return true;
});

// 앱 디렉토리 경로 반환 (템플릿 파일 접근용)
ipcMain.handle('get-app-dir', () => __dirname);

// 여러 타임스탬프에서 프레임 배치 추출 (진행률 콜백 포함)
ipcMain.handle('ffmpeg-extract-frames-batch', async (event, videoPath, timestamps) => {
  const CONCURRENCY = 6; // 동시 FFmpeg 프로세스 수
  const results = new Array(timestamps.length);
  let completed = 0;

  const extractOne = (i) => new Promise((resolve) => {
    const tmpPath = path.join(app.getPath('temp'), `twb_batch_${Date.now()}_${i}.jpg`);
    ffmpeg(videoPath)
      .seekInput(timestamps[i])
      .frames(1)
      .size('1280x?')
      .outputOptions(['-q:v 2'])
      .output(tmpPath)
      .on('end', () => {
        try {
          const data = fs.readFileSync(tmpPath);
          results[i] = { timestamp: timestamps[i], base64: `data:image/jpeg;base64,${data.toString('base64')}`, success: true };
        } catch {
          results[i] = { timestamp: timestamps[i], base64: null, success: false };
        } finally {
          safeCleanup(tmpPath);
        }
        completed++;
        event.sender.send('ffmpeg-batch-progress', { current: completed, total: timestamps.length });
        resolve();
      })
      .on('error', () => {
        results[i] = { timestamp: timestamps[i], base64: null, success: false };
        safeCleanup(tmpPath);
        completed++;
        event.sender.send('ffmpeg-batch-progress', { current: completed, total: timestamps.length });
        resolve();
      })
      .run();
  });

  // CONCURRENCY 개씩 병렬 처리
  for (let i = 0; i < timestamps.length; i += CONCURRENCY) {
    const batch = timestamps.slice(i, i + CONCURRENCY).map((_, j) => extractOne(i + j));
    await Promise.all(batch);
  }

  return results;
});
