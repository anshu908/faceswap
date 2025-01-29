const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Initialize Express server to serve static files
const app = express();
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.listen(process.env.PORT || 3000);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userStates = new Map();

// Create public directory if not exists
const publicDir = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

async function downloadImage(fileUrl, userId, type) {
  const timestamp = Date.now();
  const filename = `${userId}-${type}-${timestamp}.jpg`;
  const filePath = path.join(publicDir, filename);
  
  const response = await axios({
    method: 'GET',
    url: fileUrl,
    responseType: 'stream',
  });

  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);
  
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return `${process.env.SERVER_URL}/images/${filename}`;
}

bot.start((ctx) => {
  ctx.reply('🌟 Welcome to Face Swap Bot!\n\nPlease send the TARGET image (the main photo where we\'ll swap the face)');
  userStates.set(ctx.from.id, { state: 'awaiting_target' });
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);

  if (!state) {
    return ctx.reply('Please send /start to begin');
  }

  try {
    const fileId = ctx.message.photo[0].file_id;
    const file = await ctx.telegram.getFile(fileId);
    const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    if (state.state === 'awaiting_target') {
      const publicUrl = await downloadImage(telegramFileUrl, userId, 'target');
      userStates.set(userId, {
        state: 'awaiting_face',
        targetUrl: publicUrl
      });
      ctx.reply('✅ Target image received! Now please send the FACE image you want to swap');
    } 
    else if (state.state === 'awaiting_face') {
      const publicUrl = await downloadImage(telegramFileUrl, userId, 'face');
      userStates.set(userId, {
        ...state,
        state: 'processing',
        faceUrl: publicUrl
      });

      ctx.reply('🔄 Processing your images...');

      // Create face swap task
      const createTaskUrl = new URL('https://face-swap.hazex.workers.dev/');
      createTaskUrl.searchParams.append('function', 'create_task');
      createTaskUrl.searchParams.append('target_img', state.targetUrl);
      createTaskUrl.searchParams.append('face_img', publicUrl);

      const { data } = await axios.get(createTaskUrl.toString());
      
      if (!data.task_id) {
        throw new Error('Failed to create task');
      }

      // Check task status periodically
      let resultUrl;
      let attempts = 0;
      while (attempts < 10) { // Max 20 seconds wait
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const checkUrl = new URL('https://face-swap.hazex.workers.dev/');
        checkUrl.searchParams.append('function', 'check_task');
        checkUrl.searchParams.append('task_id', data.task_id);
        
        const checkRes = await axios.get(checkUrl.toString());
        
        if (checkRes.data.result) {
          resultUrl = checkRes.data.result;
          break;
        }
        
        attempts++;
      }

      if (resultUrl) {
        await ctx.replyWithPhoto(resultUrl);
      } else {
        ctx.reply('❌ Failed to process images. Please try again.');
      }

      // Cleanup
      userStates.delete(userId);
      [state.targetUrl, publicUrl].forEach(url => {
        const filename = path.basename(new URL(url).pathname);
        fs.unlink(path.join(publicDir, filename), () => {});
      });
    }
  } catch (error) {
    console.error(error);
    ctx.reply('❌ An error occurred. Please try again.');
    userStates.delete(userId);
  }
});

// Handle non-photo messages
bot.on('message', (ctx) => {
  if (userStates.has(ctx.from.id)) {
    ctx.reply('Please send an image as specified');
  } else {
    ctx.reply('Send /start to begin');
  }
});

// Start bot
bot.launch().then(() => {
  console.log('Bot started');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
