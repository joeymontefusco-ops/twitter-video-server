const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const FormData = require('form-data');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MAX_SIZE_BYTES = 512 * 1024 * 1024;

const crypto = require('crypto');

// In-memory JWT storage
let hypefuryToken = process.env.HF_JWT_TOKEN || null;
let tokenExpiry = hypefuryToken ? Date.now() + 50 * 60 * 1000 : null;

async function refreshHypefuryToken() {
  try {
    console.log('[token] Refreshing JWT via Firebase...');
    const res = await axios.post(
      `https://securetoken.googleapis.com/v1/token?key=${process.env.HF_API_KEY}`,
      {
        grant_type: 'refresh_token',
        refresh_token: process.env.HF_REFRESH_TOKEN,
      }
    );
    hypefuryToken = res.data.id_token;
    tokenExpiry = Date.now() + 50 * 60 * 1000;
    console.log('[token] JWT refreshed successfully');
    return hypefuryToken;
  } catch (err) {
    console.error('[token] Failed to refresh JWT:', err.response?.data || err.message);
    return null;
  }
}

function generateOAuthHeader(method, url, params, credentials) {
  const oauthParams = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...params, ...oauthParams };
  const sortedParams = Object.keys(allParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');

  const signingKey = `${encodeURIComponent(credentials.consumerSecret)}&${encodeURIComponent(credentials.accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  return 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');
}

async function uploadToTwitter(filePath, credentials) {
  const fileSize = fs.statSync(filePath).size;
  const fileBuffer = fs.readFileSync(filePath);

  const initUrl = 'https://upload.twitter.com/1.1/media/upload.json';
  const initParams = {
    command: 'INIT',
    total_bytes: fileSize.toString(),
    media_type: 'video/mp4',
    media_category: 'tweet_video',
  };

  const initOAuth = generateOAuthHeader('POST', initUrl, initParams, credentials);
  const initForm = new FormData();
  Object.entries(initParams).forEach(([k, v]) => initForm.append(k, v));

  const initRes = await axios.post(initUrl, initForm, {
    headers: { ...initForm.getHeaders(), Authorization: initOAuth },
  });
  const mediaId = initRes.data.media_id_string;

  const CHUNK_SIZE = 5 * 1024 * 1024;
  let segmentIndex = 0;
  let offset = 0;

  while (offset < fileSize) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    const appendOAuth = generateOAuthHeader('POST', initUrl, {}, credentials);
    const appendForm = new FormData();
    appendForm.append('command', 'APPEND');
    appendForm.append('media_id', mediaId);
    appendForm.append('segment_index', segmentIndex.toString());
    appendForm.append('media', chunk, { filename: 'video.mp4', contentType: 'video/mp4' });

    await axios.post(initUrl, appendForm, {
      headers: { ...appendForm.getHeaders(), Authorization: appendOAuth },
    });

    offset += CHUNK_SIZE;
    segmentIndex++;
  }

  const finalParams = { command: 'FINALIZE', media_id: mediaId };
  const finalOAuth = generateOAuthHeader('POST', initUrl, finalParams, credentials);
  const finalForm = new FormData();
  Object.entries(finalParams).forEach(([k, v]) => finalForm.append(k, v));

  const finalRes = await axios.post(initUrl, finalForm, {
    headers: { ...finalForm.getHeaders(), Authorization: finalOAuth },
  });

  let processingInfo = finalRes.data.processing_info;
  while (processingInfo && processingInfo.state !== 'succeeded') {
    if (processingInfo.state === 'failed') throw new Error('Twitter video processing failed');
    const waitSecs = processingInfo.check_after_secs || 5;
    await new Promise(r => setTimeout(r, waitSecs * 1000));

    const statusOAuth = generateOAuthHeader('GET', initUrl, {}, credentials);
    const statusRes = await axios.get(`${initUrl}?command=STATUS&media_id=${mediaId}`, {
      headers: { Authorization: statusOAuth },
    });
    processingInfo = statusRes.data.processing_info;
  }

  return mediaId;
}

async function postQuoteTweet(text, mediaId, quoteTweetId, credentials) {
  const url = 'https://api.twitter.com/2/tweets';
  const body = {
    text,
    quote_tweet_id: quoteTweetId,
    ...(mediaId && { media: { media_ids: [mediaId] } }),
  };

  const oauthHeader = generateOAuthHeader('POST', url, {}, credentials);
  const res = await axios.post(url, body, {
    headers: { Authorization: oauthHeader, 'Content-Type': 'application/json' },
  });

  return res.data;
}

// ─── Extract a single frame at full resolution (accurate seek) ────────────
async function extractFrame(videoPath, timestampSec, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -ss ${timestampSec} -vframes 1 -vf scale=1920:-1 "${outputPath}" -y`;
    exec(cmd, { timeout: 30000 }, (err) => {
      if (err) reject(err);
      else resolve(outputPath);
    });
  });
}

// ─── Sample frames sequentially across entire video ───────────────────────
// Sequential (not parallel) to avoid crashing Railway container
async function sampleFramesFromVideo(videoPath, intervalSecs = 3) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      async (err, stdout) => {
        if (err) return reject(err);

        const duration = parseFloat(stdout.trim());
        if (!duration || isNaN(duration)) return reject(new Error('Could not determine video duration'));

        console.log(`[sampler] Video duration: ${duration.toFixed(1)}s`);

        // Skip first 10s (usually intro) and last 10s
        const start = 10;
        const end = Math.max(start + intervalSecs, duration - 10);
        const timestamps = [];
        for (let t = start; t <= end; t += intervalSecs) {
          timestamps.push(Math.floor(t));
        }

        console.log(`[sampler] Extracting ${timestamps.length} frames at ${intervalSecs}s intervals (sequential)...`);

        const frames = [];

        // Sequential — one FFmpeg process at a time
        for (const t of timestamps) {
          const framePath = path.join('/tmp', `sample_${t}.png`);
          try {
            await new Promise((res, rej) => {
              const cmd = `ffmpeg -ss ${t} -i "${videoPath}" -vframes 1 -vf scale=960:-1 "${framePath}" -y 2>/dev/null`;
              exec(cmd, { timeout: 15000 }, (e) => (e ? rej(e) : res()));
            });
            if (fs.existsSync(framePath)) {
              frames.push({ timestamp: t, path: framePath });
            }
          } catch (e) {
            console.error(`[sampler] Frame at ${t}s failed:`, e.message);
          }

          // Log progress every 20 frames
          if (frames.length > 0 && frames.length % 20 === 0) {
            console.log(`[sampler] Progress: ${frames.length}/${timestamps.length} frames extracted`);
          }
        }

        console.log(`[sampler] Done: ${frames.length} frames extracted`);
        resolve(frames);
      }
    );
  });
}

// ─── Score a single frame with Gemini Vision (with model fallback) ─────────
async function scoreFrameWithGemini(framePath, apiKey) {
  const imageBuffer = fs.readFileSync(framePath);
  const base64Image = imageBuffer.toString('base64');

  const prompt = `You are analyzing a Madden NFL gameplay screenshot to determine if it shows OFFENSIVE pre-snap route art with drawn lines.

SCORE THIS FRAME:
- Return 1 if: colored route lines are drawn on the field (yellow, red, pink, blue arrows extending from receivers) OR the SHOW PLAY panel is open with route lines visible
- Return 0 if: no route lines drawn, defensive coverage zones shown, live action, menus, face cam only, players standing with no lines

Respond with ONLY a single digit: 0 or 1. Nothing else.`;

  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash',
    'gemini-2.5-flash-lite',
  ];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          contents: [
            {
              parts: [
                { inline_data: { mime_type: 'image/png', data: base64Image } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 8 },
        },
        { timeout: 15000 }
      );
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '0';
      return parseInt(text) === 1;
    } catch (err) {
      console.error(`[vision] Model ${model} failed for ${path.basename(framePath)}:`, err.message);
      if (i === models.length - 1) return false;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

// ─── Filter frames: find ones with route lines drawn ──────────────────────
async function filterFramesWithRouteLines(frames, apiKey) {
  console.log(`[vision] Scoring ${frames.length} frames for route line detection...`);

  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < frames.length; i += CONCURRENCY) {
    const batch = frames.slice(i, i + CONCURRENCY);
    const scores = await Promise.all(
      batch.map(async (frame) => {
        const hasRoutes = await scoreFrameWithGemini(frame.path, apiKey);
        return { ...frame, hasRoutes };
      })
    );
    results.push(...scores);

    const found = results.filter(f => f.hasRoutes).length;
    console.log(`[vision] Batch ${Math.floor(i / CONCURRENCY) + 1}: ${found} qualifying frames so far`);

    if (i + CONCURRENCY < frames.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const qualifying = results.filter(f => f.hasRoutes);
  console.log(`[vision] Final: ${qualifying.length}/${frames.length} frames have route lines`);
  return qualifying;
}

// ─── Assign best frame per section spread across video timeline ───────────
function assignFramesToSections(qualifyingFrames, sections) {
  if (qualifyingFrames.length === 0) return sections.map(s => ({ ...s, bestFramePath: null }));

  const totalDuration = qualifyingFrames[qualifyingFrames.length - 1].timestamp;
  const sectionCount = sections.length;

  return sections.map((section, index) => {
    const zoneStart = (totalDuration / sectionCount) * index;
    const zoneEnd = (totalDuration / sectionCount) * (index + 1);

    const zoneFrames = qualifyingFrames.filter(
      f => f.timestamp >= zoneStart && f.timestamp < zoneEnd
    );

    const candidates = zoneFrames.length > 0 ? zoneFrames : qualifyingFrames;
    const pick = candidates[Math.floor(candidates.length / 2)];

    console.log(`[assign] Section ${section.number}: frame at ${pick.timestamp}s (zone ${Math.floor(zoneStart)}-${Math.floor(zoneEnd)}s)`);

    return { ...section, bestFramePath: pick.path, timestamp_sec: pick.timestamp };
  });
}

// ─── Re-extract chosen frame at full 1080p quality ────────────────────────
async function upscaleFrame(videoPath, timestampSec, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -ss ${timestampSec} -vframes 1 -vf scale=1920:-1 -q:v 1 "${outputPath}" -y`;
    exec(cmd, { timeout: 30000 }, (err) => {
      if (err) reject(err);
      else resolve(outputPath);
    });
  });
}

async function sendDiscordMessage(channelId, content, imagePath, botToken) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content }));
  if (imagePath && fs.existsSync(imagePath)) {
    form.append('files[0]', fs.createReadStream(imagePath), {
      filename: path.basename(imagePath),
      contentType: 'image/png',
    });
  }

  const res = await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bot ${botToken}` },
      timeout: 30000,
    }
  );
  return res.data;
}

// ─── Upload image to Hypefury Firebase Storage ────────────────────────────
async function uploadImageToHypefury(imagePath, jwtToken) {
  const imageId = uuidv4();
  const fileName = `${imageId}.png`;
  const thumbnailName = `thumbnail-${imageId}.png`;
  const bucket = 'hypefury-896c7.appspot.com';
  const baseUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o`;
  const fileBuffer = fs.readFileSync(imagePath);
  const fileSize = fileBuffer.length;

  const initRes = await axios.post(
    `${baseUrl}?name=${fileName}`,
    { name: fileName },
    {
      headers: {
        'Authorization': `Firebase ${jwtToken}`,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
        'X-Goog-Upload-Header-Content-Type': 'image/png',
        'Content-Type': 'application/json',
      },
    }
  );

  const uploadUrl = initRes.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('No upload URL from Firebase Storage');

  await axios.post(uploadUrl, fileBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const thumbInitRes = await axios.post(
    `${baseUrl}?name=${thumbnailName}`,
    { name: thumbnailName },
    {
      headers: {
        'Authorization': `Firebase ${jwtToken}`,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
        'X-Goog-Upload-Header-Content-Type': 'image/png',
        'Content-Type': 'application/json',
      },
    }
  );

  const thumbUploadUrl = thumbInitRes.headers['x-goog-upload-url'];
  if (thumbUploadUrl) {
    await axios.post(thumbUploadUrl, fileBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  }

  return {
    name: fileName,
    type: 'image/png',
    size: fileSize,
    altText: '',
    thumbnail: thumbnailName,
  };
}

// ─── Launch Puppeteer browser ──────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });
}

// ─── /refresh-token ───────────────────────────────────────────────────────
app.post('/refresh-token', async (req, res) => {
  const token = await refreshHypefuryToken();
  if (token) {
    res.json({ success: true, message: 'Token refreshed successfully' });
  } else {
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// ─── /post-thread ─────────────────────────────────────────────────────────
app.post('/post-thread', async (req, res) => {
  const { threadData, category, driveFileId } = req.body;

  if (!threadData) {
    return res.status(400).json({ error: 'Missing threadData' });
  }

  let thread;
  try {
    thread = typeof threadData === 'string' ? JSON.parse(threadData) : threadData;
    if (typeof thread === 'string') thread = JSON.parse(thread);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid threadData JSON: ' + e.message });
  }

  const tweetTexts = [
    thread.hook,
    ...(thread.sections || []).map(s => s.content),
    thread.cta,
  ].filter(Boolean);

  if (tweetTexts.length === 0) {
    return res.status(400).json({ error: 'No tweets to post' });
  }

  if (!hypefuryToken || Date.now() > tokenExpiry) {
    await refreshHypefuryToken();
  }
  const token = hypefuryToken;
  if (!token) {
    return res.status(401).json({ error: 'No Hypefury token available' });
  }

  res.json({ success: true, message: 'Posting thread to Hypefury...' });

  try {
    const userId = 'pLvmUtGBDvhoaiQRRkWVy29QwMr1';
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(16, 0, 0, 0);

    const tmpVideo = path.join('/tmp', `post_video_${Date.now()}.mp4`);
    const tmpFrames = [];
    let sectionMediaMap = {};

    if (driveFileId && thread.sections && thread.sections.length > 0) {
      try {
        console.log('[post-thread] Downloading video for frame extraction...');
        const driveUrl = `https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&confirm=t`;
        const dlResponse = await axios.get(driveUrl, { responseType: 'stream', timeout: 300000 });
        const writer = fs.createWriteStream(tmpVideo);
        await new Promise((resolve, reject) => {
          dlResponse.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        console.log('[post-thread] Video downloaded');

        for (const section of thread.sections) {
          const framePath = path.join('/tmp', `post_frame_${Date.now()}_${section.number}.png`);
          tmpFrames.push(framePath);
          try {
            await extractFrame(tmpVideo, section.timestamp_sec || 0, framePath);
            if (fs.existsSync(framePath)) {
              const mediaInfo = await uploadImageToHypefury(framePath, token);
              if (mediaInfo) {
                sectionMediaMap[section.number] = mediaInfo;
                console.log(`[post-thread] Section ${section.number} image uploaded: ${mediaInfo.name}`);
              }
            }
          } catch (frameErr) {
            console.error(`[post-thread] Frame/upload failed for section ${section.number}:`, frameErr.message);
          }
        }
      } catch (videoErr) {
        console.error('[post-thread] Video processing failed, posting without images:', videoErr.message);
      } finally {
        [tmpVideo, ...tmpFrames].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
      }
    }

    const allSectionMedia = Object.values(sectionMediaMap);

    const tweets = tweetTexts.map((text, index) => {
      const section = thread.sections ? thread.sections[index - 1] : null;
      const media = index === 0
        ? allSectionMedia
        : section && sectionMediaMap[section.number] ? [sectionMediaMap[section.number]] : [];
      return {
        status: text,
        count: index,
        media,
        guid: uuidv4().replace(/-/g, '').substring(0, 8) + '-' + uuidv4().replace(/-/g, '').substring(0, 4) + '-11f1-' + uuidv4().replace(/-/g, '').substring(0, 4) + '-' + uuidv4().replace(/-/g, '').substring(0, 12),
        published: false,
        quoteTweetData: null,
        ...(index > 0 ? { isTrusted: true } : {}),
      };
    });

    const payload = {
      currentUserId: userId,
      post: {
        midnight: midnight.toISOString(),
        slotType: 'post',
        time: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        scheduled: false,
        user: userId,
        publishingError: null,
        deleted: false,
        tweets,
        tweetsCount: tweets.length,
        lastAutoRTTime: null,
        isFavorite: false,
        type: 'post',
        tweetIds: null,
        conditionalRetweetsConditions: {
          delayForRetweet: '30 minutes',
          minRetweetsThreshold: null,
          minFavoritesThreshold: 1,
        },
        autoplug: {
          processed: false,
          minRetweets: 100,
          minFavorites: null,
          templateName: null,
          status: 'Get started with your free course here now: https://themaddenacademy.com/',
        },
        postNow: false,
        source: null,
        writer: null,
        growthProgram: null,
        tweetshot: null,
        shareOnInstagram: false,
        linkedIn: null,
        facebook: { text: tweetTexts.join('\n\n'), didUserEditFacebookText: false },
        delayBetweenTweets: null,
        tweetMetricsUpdatedAt: null,
        categories: category ? [category] : [],
        recurrentPostRef: null,
        replyToTweetId: null,
        replyToTweetInfo: null,
        isCancelled: false,
        instagramCaption: null,
        isCloned: false,
        isRecurrentPost: false,
        timerData: null,
        isPinned: false,
        ghostwritingRefusal: null,
        ghostwritingStatus: null,
        impressionsCountOfTheFirstTweet: null,
        tweetshotContent: null,
        instagramPublishingError: null,
        facebookPublishingError: null,
        publishedToInstagram: false,
        autoDM: null,
        hasThreadFinisherTweet: false,
        created_at: null,
        linkedInPublishingError: null,
        isRecurrentPostDisabled: false,
        instagramThreadFinisherText: null,
        lastClonePostedTime: null,
        isDeletedFromTwitter: false,
        isLongTweetshot: true,
        isLargeFontTweetshot: false,
        tweetReel: null,
        tiktok: null,
        ama: null,
        youtubeShortRef: null,
        threads: null,
        tiktokPublishingError: null,
      },
    };

    console.log(`[post-thread] Posting thread with ${tweets.length} tweets to Hypefury...`);

    const response = await axios.post(
      'https://app.hypefury.com/api/posts/save',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Origin': 'https://app.hypefury.com',
          'Referer': 'https://app.hypefury.com/queue',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        },
      }
    );

    console.log('[post-thread] Thread posted successfully:', response.data);

  } catch (err) {
    console.error('[post-thread] Error:', err.response?.data || err.message);
  }
});

// ─── /extract-screenshots ─────────────────────────────────────────────────
// Approach: sample frames every 6s → Gemini Vision filters for route lines
// → assign best frame per section → re-extract at 1080p → send to Discord
app.post('/extract-screenshots', async (req, res) => {
  const {
    driveFileId,
    threadData,
    channelId,
    botToken,
    fileName,
    discordBotUrl,
    sanitizedDraft
  } = req.body;

  if (!driveFileId || !threadData || !channelId || !botToken) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let thread;
  try {
    let parsed = threadData;
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    }
    thread = parsed;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid threadData JSON: ' + e.message });
  }

  res.json({ success: true, message: 'Processing started' });

  const tmpVideo = path.join('/tmp', `video_${Date.now()}.mp4`);
  let sampledFrames = [];
  let finalFramePaths = [];

  try {
    // ── Step 1: Download video ─────────────────────────────────────────────
    console.log(`[screenshots] Downloading video ${driveFileId}...`);
    const driveUrl = `https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&confirm=t`;
    const response = await axios.get(driveUrl, { responseType: 'stream', timeout: 300000 });
    const writer = fs.createWriteStream(tmpVideo);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const fileSize = fs.statSync(tmpVideo).size;
    if (fileSize < 1024 * 100) throw new Error(`Downloaded file too small (${fileSize} bytes) — likely a Drive auth error`);
    console.log(`[screenshots] Downloaded: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

    // ── Step 2: Sample frames every 6s (sequential) ───────────────────────
    sampledFrames = await sampleFramesFromVideo(tmpVideo, 3);
    if (sampledFrames.length === 0) throw new Error('No frames could be extracted from video');

    // ── Step 3: Gemini Vision filters frames with route lines ──────────────
    const apiKey = process.env.GEMINI_API_KEY;
    let qualifyingFrames = [];

    if (apiKey) {
      qualifyingFrames = await filterFramesWithRouteLines(sampledFrames, apiKey);
    }

    // Fallback: if Gemini found nothing, use evenly spaced frames
    if (qualifyingFrames.length === 0) {
      console.warn('[screenshots] No qualifying frames found — using evenly spaced fallback');
      qualifyingFrames = sampledFrames;
    }

    // ── Step 4: Assign one frame per section ──────────────────────────────
    const sections = thread.sections || [];
    const sectionsWithFrames = assignFramesToSections(qualifyingFrames, sections);

    // ── Step 5: Re-extract at full 1080p ──────────────────────────────────
    console.log('[screenshots] Re-extracting chosen frames at full resolution...');
    for (const section of sectionsWithFrames) {
      if (section.timestamp_sec != null) {
        const hqPath = path.join('/tmp', `hq_frame_${section.number}.png`);
        finalFramePaths.push(hqPath);
        try {
          await upscaleFrame(tmpVideo, section.timestamp_sec, hqPath);
          section.hqFramePath = fs.existsSync(hqPath) ? hqPath : section.bestFramePath;
        } catch (e) {
          console.error(`[screenshots] HQ re-extract failed for section ${section.number}:`, e.message);
          section.hqFramePath = section.bestFramePath;
        }
      }
    }

    // ── Step 6: Send hook to Discord ──────────────────────────────────────
    await sendDiscordMessage(
      channelId,
      `<@366635705964953601> 🎬 **New Thread Draft — Review before approving**\n\n📁 Source: \`${fileName || 'Unknown'}\`\n\n**HOOK TWEET:**\n${thread.hook}`,
      null,
      botToken
    );
    await new Promise(r => setTimeout(r, 500));

    // ── Step 7: Send each section + screenshot ────────────────────────────
    for (const section of sectionsWithFrames) {
      const framePath = section.hqFramePath || null;
      const hasFrame = framePath && fs.existsSync(framePath);
      console.log(`[screenshots] Sending section ${section.number} (frame: ${hasFrame ? section.timestamp_sec + 's' : 'none'})`);
      await sendDiscordMessage(channelId, section.content, hasFrame ? framePath : null, botToken);
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Step 8: Send CTA ──────────────────────────────────────────────────
    await sendDiscordMessage(channelId, thread.cta, null, botToken);
    await new Promise(r => setTimeout(r, 500));

    // ── Step 9: Send approval buttons ─────────────────────────────────────
    if (discordBotUrl && sanitizedDraft) {
      const updatedThreadData = JSON.stringify({
        hook: thread.hook,
        sections: sectionsWithFrames.map(s => ({
          number: s.number,
          title: s.title,
          content: s.content,
          timestamp_sec: s.timestamp_sec,
        })),
        cta: thread.cta,
      });
      await axios.post(`${discordBotUrl}/send-draft`, {
        channelId,
        fileName: fileName || 'Unknown',
        draft: sanitizedDraft,
        driveFileId,
        threadData: updatedThreadData,
      });
    }

    console.log('[screenshots] Thread preview complete');

  } catch (err) {
    console.error('[screenshots] Error:', err.message);
    try {
      await sendDiscordMessage(channelId, `❌ Failed to generate thread preview: ${err.message}`, null, botToken);
    } catch (e) {}
  } finally {
    const allTempFiles = [tmpVideo, ...sampledFrames.map(f => f.path), ...finalFramePaths];
    allTempFiles.forEach(f => {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });
    console.log('[screenshots] Temp files cleaned up');
  }
});

// ─── /upload-and-reply ────────────────────────────────────────────────────
app.post('/upload-and-reply', async (req, res) => {
  const {
    driveUrl,
    replyToTweetId,
    replyText,
    consumerKey,
    consumerSecret,
    accessToken,
    accessTokenSecret,
  } = req.body;

  if (!driveUrl || !replyToTweetId || !consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const credentials = { consumerKey, consumerSecret, accessToken, accessTokenSecret };
  const tmpInput = path.join('/tmp', `input_${Date.now()}.mp4`);
  const tmpOutput = path.join('/tmp', `output_${Date.now()}.mp4`);

  try {
    console.log('Downloading video from Drive...');
    const response = await axios.get(driveUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(tmpInput);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const fileSize = fs.statSync(tmpInput).size;
    console.log(`Downloaded: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

    let uploadPath = tmpInput;

    if (fileSize > MAX_SIZE_BYTES) {
      console.log('File over 512MB, compressing with FFmpeg...');
      const targetBitrate = Math.floor((480 * 1024 * 1024 * 8) / 600);
      execSync(`ffmpeg -i ${tmpInput} -b:v ${targetBitrate} -maxrate ${targetBitrate} -bufsize ${targetBitrate * 2} -vcodec libx264 -acodec aac -y ${tmpOutput}`);
      uploadPath = tmpOutput;
    }

    const mediaId = await uploadToTwitter(uploadPath, credentials);
    const tweet = await postQuoteTweet(replyText || '', mediaId, replyToTweetId, credentials);

    res.json({ success: true, tweet_id: tweet.data?.id, media_id: mediaId });

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  } finally {
    [tmpInput, tmpOutput].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', tokenValid: !!hypefuryToken && Date.now() < tokenExpiry }));

app.listen(PORT, () => {
  console.log(`Twitter video server running on port ${PORT}`);
  refreshHypefuryToken();
});
