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

async function extractFrame(videoPath, timestampSec, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -ss ${timestampSec} -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}" -y`;
    exec(cmd, (err) => {
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

  // Upload main image
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

  // Upload thumbnail (same image)
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

// ─── Upload video to Gemini Files API ─────────────────────────────────────
async function uploadVideoToGemini(videoPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const fileSize = fs.statSync(videoPath).size;
  const mimeType = 'video/mp4';
  const displayName = path.basename(videoPath);

  console.log('[gemini] Initiating resumable upload to Files API...');

  // Step 1: Initiate resumable upload
  const initRes = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
    { file: { display_name: displayName } },
    {
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
    }
  );

  const uploadUrl = initRes.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('No upload URL from Gemini Files API');

  console.log(`[gemini] Uploading ${(fileSize / 1024 / 1024).toFixed(1)}MB to Gemini...`);

  // Step 2: Upload file in one shot (for files under 200MB) or chunked
  const fileBuffer = fs.readFileSync(videoPath);
  const uploadRes = await axios.post(uploadUrl, fileBuffer, {
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 300000,
  });

  const fileUri = uploadRes.data?.file?.uri;
  const fileName = uploadRes.data?.file?.name;
  if (!fileUri) throw new Error('No file URI returned from Gemini upload');

  console.log(`[gemini] Upload complete. File URI: ${fileUri}`);

  // Step 3: Wait for file to be processed
  let state = uploadRes.data?.file?.state;
  let attempts = 0;
  while (state === 'PROCESSING' && attempts < 30) {
    console.log('[gemini] Waiting for file processing...');
    await new Promise(r => setTimeout(r, 10000));
    const statusRes = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    state = statusRes.data?.state;
    attempts++;
  }

  if (state !== 'ACTIVE') throw new Error(`Gemini file processing failed: state=${state}`);

  console.log('[gemini] File is ACTIVE and ready for analysis');
  return { fileUri, fileName };
}

// ─── Get best timestamps from Gemini ──────────────────────────────────────
async function getGeminiTimestamps(fileUri, sections) {
  const apiKey = process.env.GEMINI_API_KEY;

  const sectionDescriptions = sections
    .map(s => `${s.number}. ${s.title}: ${s.content}`)
    .join('\n\n');

  const prompt = `You are a video frame extraction system for The Madden Academy's Twitter thread automation pipeline.

For each section below, find the timestamp where the screen shows pre-snap play art or player route assignments.

WHAT YOU MUST SEE IN THE FRAME (ANY ONE of these is enough to accept a frame):
- Colored route lines drawn on the field (yellow, red, pink, blue, purple curved/straight arrows extending from receivers across the field)
- Player route icons floating above receivers (△ ○ □ X markers) WITH at least one route line also visible on the field
- Audible animation cycling on a player icon (glowing/spinning ring around △ ○ □ X) WITH route lines visible
- SHOW PLAY panel open on the right side of the screen WITH route lines visible on the field
- Playbook screen showing an actual PLAY DIAGRAM with drawn route lines inside the diagram (NOT a formation list)

IMMEDIATELY REJECT any frame that looks like this:
- Players standing at the line with NO route lines drawn anywhere on the field
- Post-snap live action where ball is already in the air or players are running after snap
- Face cam only with no gameplay visible
- Menus, scoreboards, loading screens, replays after the play ends
- Players running mid-play with no pre-snap overlays
- Formation/playbook SELECTOR screens showing a list of formation names (Nickel, Dime, 5-2, Goal Line, Normal, etc.)
- SELECT RECEIVER menu showing a popup panel with player names and button icons (R. Moss, P. Paul, J. Wilson, etc.)
- Any popup menu open on screen BUT no route lines drawn on the field yet
- SHOW PLAY panel open BUT no route lines visible on the field

SCANNING INSTRUCTIONS per section:
1. Listen for when Manu first mentions the section keyword or concept verbally
2. For sections 1-2: scan from [verbal mention - 3s] to [verbal mention + 20s]
3. For sections 3 and beyond: scan from [verbal mention + 5s] to [verbal mention + 35s]
   — Manu explains the concept FIRST then shows the play, so start scanning AFTER he speaks
4. Look for the FIRST frame where ANY of the accepted criteria above are visible
5. If nothing found in that window → expand to ±45s around verbal mention and keep scanning
6. NEVER settle for a frame with players standing and zero route lines on the field
7. Every section MUST get a timestamp — never skip

PRIORITY ORDER (pick highest available):
1. SHOW PLAY panel open + route lines visible simultaneously
2. Route lines drawn on field with player route icons above receivers
3. Player route icons (△ ○ □ X) floating above receivers with audible animation cycling
4. Player route icons floating above receivers without animation
5. SHOW PLAY panel open alone
6. Playbook or formation screen with play diagram
7. Pre-snap with any single route line visible (absolute last resort)

Return ONLY a raw JSON array. No explanation, no markdown, no code blocks. Start with [ and end with ].
Format: [{"number": 1, "timestamp_sec": 45}, {"number": 2, "timestamp_sec": 112}]
IMPORTANT: timestamp_sec must be a plain integer in SECONDS only. Never use MM:SS format. Convert all times to total seconds (e.g. 1:50 = 110, 3:27 = 207).

SECTIONS:
${sectionDescriptions}`;

  console.log('[gemini] Requesting timestamp analysis...');

  const models = [
    'gemini-2.5-flash',
    'gemini-3.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.5-flash-lite',
  ];

  let res;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      console.log(`[gemini] Trying model ${model}...`);
      res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          contents: [
            {
              parts: [
                { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        },
        { timeout: 120000 }
      );
      console.log(`[gemini] Success with model ${model}`);
      break;
    } catch (modelErr) {
      console.error(`[gemini] Model ${model} failed:`, modelErr.message);
      if (i === models.length - 1) throw modelErr;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[gemini] Raw response:', rawText);

  // Parse JSON from response
  // Convert MM:SS format to seconds if needed
  const normalized = rawText.replace(/```json|```/g, '').trim().replace(/"(\d+):(\d+)"/g, (match, m, s) => `${parseInt(m) * 60 + parseInt(s)}`);
  const timestamps = JSON.parse(normalized);
  console.log('[gemini] Timestamps:', timestamps);
  return timestamps;
}

// ─── Delete Gemini file after use ─────────────────────────────────────────
async function deleteGeminiFile(fileName) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    await axios.delete(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    console.log('[gemini] File deleted from Files API');
  } catch (err) {
    console.error('[gemini] Failed to delete file:', err.message);
  }
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

    // Download video and extract frames if driveFileId provided
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

    const tweets = tweetTexts.map((text, index) => {
      const section = thread.sections ? thread.sections[index - 1] : null;
      const media = section && sectionMediaMap[section.number] ? [sectionMediaMap[section.number]] : [];
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

// ─── /extract-screenshots ─────────────────────────────────────────────────────
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
  const tmpFrames = [];
  let geminiFileName = null;

  try {
    // Download video from Google Drive
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
    console.log(`[screenshots] Downloaded: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

    // Upload to Gemini and get smart timestamps
    let sections = thread.sections || [];
    if (process.env.GEMINI_API_KEY && sections.length > 0) {
      try {
        const { fileUri, fileName: gFileName } = await uploadVideoToGemini(tmpVideo);
        geminiFileName = gFileName;

        const timestamps = await getGeminiTimestamps(fileUri, sections);

        // Update sections with Gemini timestamps
        sections = sections.map(section => {
          const match = timestamps.find(t => t.number === section.number);
          if (match) {
            console.log(`[gemini] Section ${section.number}: timestamp updated to ${match.timestamp_sec}s`);
            return { ...section, timestamp_sec: match.timestamp_sec };
          }
          return section;
        });

      } catch (geminiErr) {
        console.error('[gemini] Analysis failed, falling back to existing timestamps:', geminiErr.message);
        // Fall back to existing timestamps silently
      }
    }

    // Send hook to Discord
    await sendDiscordMessage(
      channelId,
      `<@366635705964953601> 🎬 **New Thread Draft — Review before approving**\n\n📁 Source: \`${fileName || 'Unknown'}\`\n\n**HOOK TWEET:**\n${thread.hook}`,
      null,
      botToken
    );

    await new Promise(r => setTimeout(r, 500));

    // Extract screenshot for each section and send to Discord
    for (const section of sections) {
      const framePath = path.join('/tmp', `frame_${Date.now()}_${section.number}.png`);
      tmpFrames.push(framePath);

      console.log(`[screenshots] Extracting frame at ${section.timestamp_sec}s for section ${section.number}...`);

      let frameExtracted = false;
      try {
        await extractFrame(tmpVideo, section.timestamp_sec, framePath);
        frameExtracted = fs.existsSync(framePath);
      } catch (err) {
        console.error(`[screenshots] Frame extraction failed for section ${section.number}:`, err.message);
      }

      await sendDiscordMessage(channelId, section.content, frameExtracted ? framePath : null, botToken);
      await new Promise(r => setTimeout(r, 500));
    }

    // Send CTA
    await sendDiscordMessage(channelId, thread.cta, null, botToken);
    await new Promise(r => setTimeout(r, 500));

    // Send approval buttons via ClickUp bot
    if (discordBotUrl && sanitizedDraft) {
  const updatedThreadData = JSON.stringify({
    hook: thread.hook,
    sections: sections,
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
    // Cleanup local files
    [tmpVideo, ...tmpFrames].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });
    // Delete from Gemini Files API
    if (geminiFileName) {
      await deleteGeminiFile(geminiFileName);
    }
  }
});

// ─── /upload-and-reply (unchanged) ───────────────────────────────────────────
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
