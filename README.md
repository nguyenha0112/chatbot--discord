# Bot chat Discord

Bot nay se doc tin nhan trong kenh Discord ma bot co quyen xem, in tin nhan ra terminal, va ho tro vai lenh co ban.

## 1. Cai Node.js

Can Node.js 18 tro len. Kiem tra bang:

```bash
node -v
```

Neu chua co, tai Node.js tai https://nodejs.org/

## 2. Tao bot tren Discord Developer Portal

1. Vao https://discord.com/developers/applications
2. Bam **New Application** va dat ten bot.
3. Vao tab **Bot**, bam **Add Bot** neu chua co.
4. Trong tab **Bot**, bat cac muc sau:
   - **Message Content Intent**
   - **Server Members Intent** khong bat cung duoc neu bot chi doc tin nhan.
5. Bam **Reset Token** hoac **Copy Token** de lay token.

Khong chia se token cho ai. Token giong mat khau cua bot.

## 3. Cau hinh project

Trong thu muc project, cai thu vien:

```bash
npm install
```

Copy file mau thanh `.env`:

```bash
copy .env.example .env
```

Mo file `.env` va dien token:

```env
DISCORD_TOKEN=token_bot_cua_ban
DISCORD_CLIENT_ID=id_may_khach_client_id_cua_bot
BOT_PREFIX=!
```

`DISCORD_CLIENT_ID` nam trong Developer Portal, muc **OAuth2** -> **ID May khach**.

## 4. Moi bot vao server

1. Trong Developer Portal, vao **OAuth2** -> **URL Generator**.
2. Chon scopes:
   - `bot`
3. Chon bot permissions:
   - **View Channels**
   - **Read Message History**
   - **Send Messages**
   - **Connect**
   - **Speak**
4. Copy URL duoc tao ra, mo tren trinh duyet va moi bot vao server cua ban.

Neu bot khong doc duoc tin nhan trong mot room, hay kiem tra quyen cua bot trong channel do.

## 5. Chay bot

```bash
npm start
```

Khi bot online, terminal se hien:

```text
Bot da dang nhap: TenBot#0000
```

Moi tin nhan trong cac kenh bot co quyen xem se duoc in ra terminal.

## 6. Thu lenh trong Discord

Gui trong channel:

```text
!ping
```

Bot se tra loi:

```text
pong
```

Cac lenh co san:

- `!ping` - kiem tra bot co dang chay khong.
- `!say noi dung` - bot gui lai noi dung.
- `!help` - xem danh sach lenh.
- `/join` - bot vao voice channel ban dang ngoi va doc tin nhan trong kenh text noi ban go lenh.
- `/leave` - bot roi khoi voice channel.

## Loi thuong gap

- Bot online nhung khong doc noi dung tin nhan: chua bat **Message Content Intent** trong Developer Portal.
- Bot khong thay tin nhan trong room: bot chua co quyen **View Channels** trong room do.
- Loi `DISCORD_TOKEN` bi thieu: chua tao file `.env` hoac chua dien token.
- Loi khi cai thu vien: kiem tra Node.js da du phien ban 18 tro len.
