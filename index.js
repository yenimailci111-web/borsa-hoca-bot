const { TelegramClient, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { setTimeout: sleep } = require('node:timers/promises');
const http = require('node:http');

const env = process.env;
const questions = [
  'Hocam, THYAO’nun son tamamlanan seanstaki işlem hacmi nasıl?',
  'Hocam, ASTOR’un son önemli KAP açıklaması ne anlatıyor?',
  'Hocam, BIST 100 son tamamlanan seansı nasıl kapattı?',
  'Hocam, ASELS’in en son yayımlanan finansal sonuçlarında ne öne çıktı?',
  'Hocam, TUPRS’ın son KAP açıklamalarında hangi gelişmeler var?',
  'Hocam, SISE’nin son açıklanan bilançosunda öne çıkan kalemler neler?'
];
const settings = {
  token: env.BOT_TOKEN,
  geminiKey: env.GEMINI_API_KEY,
  model: env.GEMINI_MODEL || 'gemini-2.5-flash',
  owner: env.OWNER_ID,
  group: env.GROUP_ID,
  apiId: Number(env.API_ID),
  apiHash: env.API_HASH
};
let active = null;
let ready = false;
let closing = false;
let accountCache;
let questionIndex = 0;
let day = '';
let requestsToday = 0;

async function telegram(method, body, timeout = 10000) {
  const response = await fetch('https://api.telegram.org/bot' + settings.token + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const result = await response.json();
  if (!result.ok) throw new Error('TELEGRAM_' + (result.error_code || response.status));
  return result.result;
}

async function research(question, signal) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  if (date !== day) {
    day = date;
    requestsToday = 0;
  }
  if (requestsToday >= 10) return { stop: true };
  requestsToday++;
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(settings.model) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey },
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
      body: JSON.stringify({
        tools: [{ google_search: {} }],
        contents: [{ parts: [{ text:
          'Türkiye tarihi: ' + date + '. BIST için Türkçe, en fazla 110 kelimelik kaynaklı araştırma yaz. ' +
          'Şirket açıklamalarında KAP ve şirket yatırımcı ilişkilerine öncelik ver. ' +
          'Fiyat ve hacim için seansın tarihini ve varsa veri saatini belirt. ' +
          'Canlı veri doğrulanamıyorsa bunu yaz. Sayı uydurma. Al/sat tavsiyesi, hedef fiyat ve garanti verme.\n' +
          'Soru: ' + question
        }] }]
      })
    }
  );
  if (response.status === 429) return { stop: true };
  if (!response.ok) throw new Error('GEMINI_' + response.status);
  const candidate = (await response.json()).candidates?.[0];
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Set(chunks.map(c => c.web?.uri).filter(uri => /^https:\/\//.test(uri || '')))].slice(0, 3);
  const answer = candidate?.content?.parts?.filter(part => !part.thought)
    .map(part => part.text || '').join('').trim();
  if (!answer || !sources.length) return { text: 'Bu soru için doğrulanabilir güncel kaynak bulamadım.' };
  return { text: answer.slice(0, 2200) + '\n\nKaynaklar\n' + sources.join('\n') };
}

async function account(session) {
  const client = new TelegramClient(new StringSession(session), settings.apiId, settings.apiHash, {
    connectionRetries: 2
  });
  client.setLogLevel('none');
  try {
    await client.connect();
    if (!await client.isUserAuthorized()) throw new Error('OTURUM_GECERSIZ');
    for await (const dialog of client.iterDialogs({ limit: 200 })) {
      if (String(utils.getPeerId(dialog.entity)) === settings.group) {
        return { client, peer: dialog.inputEntity };
      }
    }
    throw new Error('HESAP_TEST_GRUBUNU_BULAMADI');
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

async function accounts() {
  if (accountCache) return accountCache;
  if (!env.HOCA_SESSION || !env.KATILIMCI_SESSIONS ||
      !settings.apiHash || !Number.isSafeInteger(settings.apiId) || settings.apiId <= 0) {
    throw new Error('API_ID, API_HASH, HOCA_SESSION ve KATILIMCI_SESSIONS ayarlanmalı.');
  }
  const sessions = JSON.parse(env.KATILIMCI_SESSIONS);
  if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 5 ||
      sessions.some(session => typeof session !== 'string' || !session.trim()) ||
      new Set([env.HOCA_SESSION, ...sessions]).size !== sessions.length + 1) {
    throw new Error('1–5 ayrı katılımcı oturumu gerekli.');
  }
  const connected = [];
  try {
    for (const session of [env.HOCA_SESSION, ...sessions]) connected.push(await account(session));
    const identities = await Promise.all(connected.map(item => item.client.getMe()));
    if (new Set(identities.map(user => String(user.id))).size !== connected.length) {
      throw new Error('Hoca ve katılımcılar farklı Telegram hesapları olmalı.');
    }
    accountCache = { hoca: connected[0], participants: connected.slice(1) };
    return accountCache;
  } catch (error) {
    await Promise.allSettled(connected.map(item => item.client.disconnect()));
    throw error;
  }
}

async function cycle(signal, test) {
  const { hoca, participants } = await accounts();
  do {
    signal.throwIfAborted();
    const index = questionIndex++;
    const asker = participants[index % participants.length];
    const question = questions[index % questions.length];
    const answer = await research(question, signal);
    signal.throwIfAborted();
    if (answer.stop) {
      await telegram('sendMessage', {
        chat_id: settings.group,
        text: 'Araştırma kotasına ulaşıldı. Döngü durduruldu.'
      });
      return;
    }
    const message = await asker.client.sendMessage(asker.peer, {
      message: '[Otomatik BIST sorusu]\n' + question
    });
    signal.throwIfAborted();
    await hoca.client.sendMessage(hoca.peer, {
      message: '[Borsa Hoca · Yapay zekâ araştırması]\n' + answer.text,
      replyTo: message.id,
      linkPreview: false
    });
    if (!test) await sleep((180 + Math.floor(Math.random() * 241)) * 1000, undefined, { signal });
  } while (!test);
}

async function handle(message, username) {
  const match = /^\/(start|grup|baslat|durdur|test)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(message?.text || '');
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return;
  const command = match[1].toLowerCase();
  const chatId = String(message.chat.id);
  const sender = String(message.from?.id);
  const say = text => telegram('sendMessage', { chat_id: chatId, text });
  if (command === 'start' || command === 'grup') {
    await say('Telegram kullanıcı ID: ' + sender + '\nSohbet ID: ' + chatId +
      '\nKomutlar: /grup, /test, /baslat, /durdur.');
    return;
  }
  if (sender !== settings.owner || chatId !== settings.group ||
      !['group', 'supergroup'].includes(message.chat.type)) return;
  if (command === 'durdur') {
    active?.abort();
    await say('Döngü durduruldu.');
    return;
  }
  if (active) {
    await say('Bir işlem zaten çalışıyor.');
    return;
  }
  const controller = new AbortController();
  active = controller;
  try {
    await say(command === 'test' ? 'Bir soru ve yanıt deneniyor.' : 'Soru döngüsü başlatıldı.');
  } catch (error) {
    active = null;
    throw error;
  }
  void cycle(controller.signal, command === 'test').catch(async error => {
    if (controller.signal.aborted) return;
    const detail = /^(GEMINI_\d+|OTURUM_GECERSIZ|HESAP_TEST_GRUBUNU_BULAMADI)$/.test(error.message)
      ? error.message : 'Hesap ve hosting ayarlarını kontrol et.';
    await say('Döngü durdu. ' + detail).catch(() => {});
    console.error('DONGU_HATASI', detail);
  }).finally(() => { if (active === controller) active = null; });
}

async function main() {
  if (!settings.token || !settings.geminiKey) throw new Error('BOT_TOKEN ve GEMINI_API_KEY gerekli.');
  const me = await telegram('getMe', {});
  const server = http.createServer((_req, res) => {
    res.writeHead(ready ? 200 : 503);
    res.end(ready ? 'ok' : 'starting');
  });
  server.listen(Number(env.PORT || 3000), '0.0.0.0');
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => {
    closing = true;
    active?.abort();
    server.close();
    const connected = accountCache ? [accountCache.hoca, ...accountCache.participants] : [];
    await Promise.allSettled(connected.map(item => item.client.disconnect()));
    process.exit(0);
  });
  console.log('Yonetim botu hazir:', me.username);
  let offset;
  while (!closing) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 32000);
      ready = true;
      for (const update of updates) {
        offset = update.update_id + 1;
        await handle(update.message, me.username);
      }
    } catch {
      ready = false;
      console.error('Telegram bağlantısı tekrar denenecek.');
      await sleep(5000);
    }
  }
}

main().catch(() => {
  console.error('Bot başlatılamadı. BOT_TOKEN, GEMINI_API_KEY ve hosting ayarlarını kontrol et.');
  process.exitCode = 1;
});
