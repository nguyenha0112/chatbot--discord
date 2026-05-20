# Discord Vietnamese TTS Bot

Bot vao voice channel va doc tin nhan trong kenh text bang giong TTS tieng Viet.

## Yeu cau

- Node.js 22 LTS tro len
- Bot Discord da bat **Message Content Intent**
- Bot co quyen **View Channel**, **Send Messages**, **Read Message History**, **Connect**, **Speak**

## Cai dat

```bash
npm i
```

Tao file `.env`:

```env
DISCORD_TOKEN=token_bot_cua_ban
DISCORD_CLIENT_ID=client_id_cua_bot
```

Chay bot:

```bash
npm start
```

## Su dung

1. Vao voice channel.
2. Trong kenh text muon bot doc, go:

```text
/join
```

3. Nhan tin trong dung kenh text do. Bot se doc ra voice.
4. Muon bot roi voice:

```text
/leave
```

Neu `/join` bao voice khong Ready, hay cap nhat Node len 22 LTS va thu doi Region voice channel sang Singapore, Hong Kong hoac Japan.

## Deploy Render Free

Render Free Web Service se ngu neu khong co request. Bot da co health endpoint `/` de ban ping giu thuc.

Tren Render dat environment variables:

```env
DISCORD_TOKEN=token_bot_cua_ban
DISCORD_CLIENT_ID=client_id_cua_bot
NODE_VERSION=22.12.0
```

Start command:

```bash
npm start
```

Sau khi deploy, dung UptimeRobot hoac cron-job.org ping URL Render moi 5 phut.
