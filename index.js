const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MAX_SIZE_BYTES = 512 * 1024 * 1024; // 512MB

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

  const headerValue = 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return headerValue;
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
    headers: {
      Authorization: oauthHeader,
      'Content-Type': 'application/json',
    },
  });

  return res.data;
}

// Extract a single frame from video at given timestamp
async function extractFrame(videoPath, timestampSec, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -ss ${timestampSec} -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}" -y`;
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve(outputPath);
    });
  });
}

// Send a Discord message with optional image attachment
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
      headers: {
        ...form.getHeaders(),
        Authorization: `Bot ${botToken}`,
      },
      timeout: 30000,
    }
  );
  return res.data;
}

// ─── /extract-screenshots ─────────────────────────────────────────────────────
// Body: {
//   driveFileId, threadData (JSON string), channelId,
//   botToken, fileName, discordBotUrl, sanitizedDraft
// }
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
    thread = typeof threadData === 'string' ? JSON.parse(threadData) : threadData;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid threadData JSON' });
  }

  // Respond immediately so n8n doesn't timeout
  res.json({ success: true, message: 'Processing started' });

  const tmpVideo = path.join('/tmp', `video_${Date.now()}.mp4`);
  const tmpFrames = [];

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

    // Send hook as first message
    console.log('[screenshots] Sending hook to Discord...');
    await sendDiscordMessage(
      channelId,
      `<@366635705964953601> 🎬 **New Thread Draft — Review before approving**\n\n📁 Source: \`${fileName || 'Unknown'}\`\n\n**HOOK TWEET:**\n${thread.hook}`,
      null,
      botToken
    );

    await new Promise(r => setTimeout(r, 500));

    // Extract screenshot for each section and send to Discord
    for (const section of thread.sections || []) {
      const framePath = path.join('/tmp', `frame_${Date.now()}_${section.number}.png`);
      tmpFrames.push(framePath);

      console.log(`[screenshots] Extracting frame at ${section.timestamp_sec}s for section ${section.number}...`);

      let frameExtracted = false;
      try {
        await extractFrame(tmpVideo, section.timestamp_sec, framePath);
        frameExtracted = fs.existsSync(framePath);
        console.log(`[screenshots] Frame extracted: ${framePath}`);
      } catch (err) {
        console.error(`[screenshots] Frame extraction failed for section ${section.number}:`, err.message);
      }

      await sendDiscordMessage(
        channelId,
        section.content,
        frameExtracted ? framePath : null,
        botToken
      );

      await new Promise(r => setTimeout(r, 500));
    }

    // Send CTA
    await sendDiscordMessage(channelId, thread.cta, null, botToken);
    await new Promise(r => setTimeout(r, 500));

    // Send approve/reject buttons via ClickUp bot /send-draft
    if (discordBotUrl && sanitizedDraft) {
      console.log('[screenshots] Sending approval buttons via bot...');
      await axios.post(`${discordBotUrl}/send-draft`, {
        channelId,
        fileName: fileName || 'Unknown',
        draft: sanitizedDraft,
        driveFileId,
        threadData: typeof threadData === 'string' ? threadData : JSON.stringify(threadData),
      });
      console.log('[screenshots] Approval buttons sent');
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
      const newSize = fs.statSync(tmpOutput).size;
      console.log(`Compressed to: ${(newSize / 1024 / 1024).toFixed(1)}MB`);
    }

    console.log('Uploading to Twitter...');
    const mediaId = await uploadToTwitter(uploadPath, credentials);
    console.log(`Media uploaded: ${mediaId}`);

    console.log('Posting reply tweet...');
    const tweet = await postQuoteTweet(replyText || '', mediaId, replyToTweetId, credentials);
    console.log('Reply posted:', tweet);

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
