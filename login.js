const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

async function main() {
  const apiId = Number(await input.text('API ID'));
  const apiHash = await input.password('API Hash');
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw new Error('API bilgileri geçersiz.');
  }
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3
  });
  client.setLogLevel('none');
  try {
    await client.start({
      phoneNumber: () => input.text('Telefon numarası (+90...)'),
      phoneCode: () => input.password('Telegram giriş kodu'),
      password: () => input.password('İki adımlı doğrulama parolası'),
      onError: () => { throw new Error('Oturum açma başarısız.'); }
    });
    console.log('Aşağıdaki oturum değerini hosting ortam değişkenine koy. Paylaşma.');
    console.log(client.session.save());
  } finally {
    await client.disconnect();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
