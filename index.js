const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const FormData = require('form-data');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MAX_SIZE_BYTES = 512 * 1024 * 1024;

const crypto = require('crypto');

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

// ─── /post-thread — Puppeteer posts thread to Hypefury ────────────────────────
app.post('/post-thread', async (req, res) => {
  const { threadData, category } = req.body;

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

  const tweets = [
    thread.hook,
    ...(thread.sections || []).map(s => s.content),
    thread.cta,
  ].filter(Boolean);

  if (tweets.length === 0) {
    return res.status(400).json({ error: 'No tweets to post' });
  }

  res.json({ success: true, message: 'Posting thread to Hypefury...' });

  let browser;
  try {
    console.log('[puppeteer] Launching browser...');
    browser = await puppeteer.launch({
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

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Load all captured session cookies
    console.log('[puppeteer] Setting session cookies...');
    const sessionCookies = [
      { name: 'amp_2c8edf', value: '2Iw3QDZIeyI102f9fgUQOe.cEx2bVV0R0JEdmhvYWlRUlJrV1Z5MjlRd01yMQ==..1jp55fk50.1jp55fnc3.3.3.6', domain: '.hypefury.com', path: '/' },
      { name: '_ga', value: 'GA1.1.651649844.1779363689', domain: '.hypefury.com', path: '/' },
      { name: '_twpid', value: 'tw.1779363689395.548906543416187118', domain: '.hypefury.com', path: '/', secure: true, sameSite: 'Strict' },
      { name: 'crisp-client%2Fsocket%2Fe6bae4c0-595e-4dc5-b6a7-bba6202f9c6f', value: '1', domain: 'app.hypefury.com', path: '/' },
      { name: 'crisp-client%2Fsession%2Fe6bae4c0-595e-4dc5-b6a7-bba6202f9c6f', value: 'session_8acafa2b-a787-4b73-bbfa-a6531695ba16', domain: '.hypefury.com', path: '/' },
      { name: '_clsk', value: '6t32d3%5E1779363732251%5E2%5E1%5Ev.clarity.ms%2Fcollect', domain: '.hypefury.com', path: '/' },
      { name: '_ga_WTDVJEY7MV', value: 'GS2.1.s1779363689$o1$g1$t1779363732$j17$l0$h0', domain: '.hypefury.com', path: '/' },
      { name: 'crisp-client%2Fsession%2Fe6bae4c0-595e-4dc5-b6a7-bba6202f9c6f%2FpLvmUtGBDvhoaiQRRkWVy29QwMr1', value: 'session_8acafa2b-a787-4b73-bbfa-a6531695ba16', domain: '.hypefury.com', path: '/' },
      { name: '_fbp', value: 'fb.1.1779363689455.703885903854238863', domain: '.hypefury.com', path: '/' },
      { name: '_gcl_au', value: '1.1.1692320563.1779363689', domain: '.hypefury.com', path: '/' },
      { name: '__sl-fingerprint', value: '016651ea2b534fb903537fbcbc98ee5f', domain: 'app.hypefury.com', path: '/' },
      { name: '_cioanonid', value: 'ffb166a5-70e8-5936-bb2d-6301b115a168', domain: '.hypefury.com', path: '/' },
      { name: '_clck', value: '1wb4sc1%5E2%5Eg68%5E0%5E2332', domain: '.hypefury.com', path: '/' },
      { name: '_cioid', value: 'pLvmUtGBDvhoaiQRRkWVy29QwMr1', domain: '.hypefury.com', path: '/' },
      { name: '_ga_GL3B0YNRQQ', value: 'GS2.1.s1779363689$o1$g1$t1779363732$j17$l0$h0', domain: '.hypefury.com', path: '/' },
      { name: 'twitterUserId', value: '1425510781408485376', domain: 'app.hypefury.com', path: '/' },
    ];

    await page.setCookie(...sessionCookies);

    // Navigate directly to Hypefury
    console.log('[puppeteer] Navigating to Hypefury...');
    await page.goto('https://app.hypefury.com/queue', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Check if logged in
    const url = page.url();
    console.log('[puppeteer] Current URL:', url);

    if (url.includes('login') || url.includes('auth')) {
      throw new Error('Not logged in — cookies may have expired');
    }

    // Click Create button
    console.log('[puppeteer] Clicking Create...');
    await page.waitForSelector('[data-cy="sidebar-create-button"]', { timeout: 10000 });
    await page.click('[data-cy="sidebar-create-button"]');
    await new Promise(r => setTimeout(r, 2000));

    // Type first tweet (hook)
    console.log('[puppeteer] Typing hook tweet...');
    await page.waitForSelector('[data-cy="composer-input"]', { timeout: 10000 });
    await page.click('[data-cy="composer-input"]');
    await page.type('[data-cy="composer-input"]', tweets[0], { delay: 10 });
    await new Promise(r => setTimeout(r, 500));

    // Add remaining tweets
    for (let i = 1; i < tweets.length; i++) {
      console.log(`[puppeteer] Adding tweet ${i + 1}...`);
      await page.waitForSelector('[data-cy="compose-add-tweet"]', { timeout: 5000 });
      await page.click('[data-cy="compose-add-tweet"]');
      await new Promise(r => setTimeout(r, 1000));

      const textareas = await page.$$('[data-cy="composer-input"]');
      const lastTextarea = textareas[textareas.length - 1];
      await lastTextarea.click();
      await lastTextarea.type(tweets[i], { delay: 10 });
      await new Promise(r => setTimeout(r, 500));
    }

    // Add category if provided
    if (category) {
      console.log(`[puppeteer] Adding category: ${category}`);
      await page.waitForSelector('[data-cy="composer-categories-icon"]', { timeout: 5000 });
      await page.click('[data-cy="composer-categories-icon"]');
      await new Promise(r => setTimeout(r, 1500));

      const categoryItems = await page.$$('.popper li, .dropdown-item, [role="option"]');
      for (const item of categoryItems) {
        const text = await item.evaluate(el => el.textContent.trim());
        if (text.toLowerCase().includes(category.toLowerCase())) {
          await item.click();
          console.log(`[puppeteer] Category selected: ${text}`);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Click Queue button
    console.log('[puppeteer] Clicking Queue button...');
    await page.waitForSelector('[data-cy="compose-left-button"]', { timeout: 5000 });
    await page.click('[data-cy="compose-left-button"]');
    await new Promise(r => setTimeout(r, 2000));

    console.log('[puppeteer] Thread posted to Hypefury successfully!');

  } catch (err) {
    console.error('[puppeteer] Error:', err.message);
  } finally {
    if (browser) await browser.close();
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

  try {
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

    await sendDiscordMessage(
      channelId,
      `<@366635705964953601> 🎬 **New Thread Draft — Review before approving**\n\n📁 Source: \`${fileName || 'Unknown'}\`\n\n**HOOK TWEET:**\n${thread.hook}`,
      null,
      botToken
    );

    await new Promise(r => setTimeout(r, 500));

    for (const section of thread.sections || []) {
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

    await sendDiscordMessage(channelId, thread.cta, null, botToken);
    await new Promise(r => setTimeout(r, 500));

    if (discordBotUrl && sanitizedDraft) {
      await axios.post(`${discordBotUrl}/send-draft`, {
        channelId,
        fileName: fileName || 'Unknown',
        draft: sanitizedDraft,
        driveFileId,
        threadData: typeof threadData === 'string' ? threadData : JSON.stringify(threadData),
      });
    }

    console.log('[screenshots] Thread preview complete');

  } catch (err) {
    console.error('[screenshots] Error:', err.message);
    try {
      await sendDiscordMessage(channelId, `❌ Failed to generate thread preview: ${err.message}`, null, botToken);
    } catch (e) {}
  } finally {
    [tmpVideo, ...tmpFrames].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Twitter video server running on port ${PORT}`));
