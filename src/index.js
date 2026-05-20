require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");
const {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ffmpegPath = require("ffmpeg-static");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const prefix = process.env.BOT_PREFIX || "!";
const ttsDir = path.join(os.tmpdir(), "bot-chat-discord-tts");

if (!token) {
  console.error("Thieu DISCORD_TOKEN. Hay copy .env.example thanh .env va dien token bot.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

const voiceSessions = new Map();

function voiceStatusName(status) {
  return Object.entries(VoiceConnectionStatus)
    .find(([, value]) => value === status)?.[0] || status;
}

function audioStatusName(status) {
  return Object.entries(AudioPlayerStatus)
    .find(([, value]) => value === status)?.[0] || status;
}

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Cho bot vao voice channel cua ban va doc tin nhan o kenh nay."),
  new SlashCommandBuilder()
    .setName("beep")
    .setDescription("Phat tieng bip de kiem tra am thanh voice."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Cho bot roi khoi voice channel.")
].map((command) => command.toJSON());

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot da dang nhap: ${readyClient.user.tag}`);
  console.log(generateDependencyReport());

  try {
    if (clientId) {
      const rest = new REST({ version: "10" }).setToken(token);
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("Da dang ky slash commands: /join, /beep, /leave");
      return;
    }

    await Promise.all(
      readyClient.guilds.cache.map((guild) => guild.commands.set(commands))
    );
    console.log("Da dang ky slash commands trong cac server hien tai: /join, /beep, /leave");
  } catch (error) {
    console.error("Khong dang ky duoc slash commands:", error);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  if (clientId) return;

  try {
    await guild.commands.set(commands);
    console.log(`Da dang ky slash commands trong server moi: ${guild.name}`);
  } catch (error) {
    console.error(`Khong dang ky duoc slash commands trong ${guild.name}:`, error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === "join") {
    await interaction.deferReply();

    const voiceChannel = interaction.member?.voice?.channel;
    console.log("Nhan lenh /join", {
      guild: interaction.guild.name,
      user: interaction.user.tag,
      textChannelId: interaction.channelId,
      voiceChannelId: voiceChannel?.id,
      voiceChannelName: voiceChannel?.name,
      voiceChannelType: voiceChannel?.type
    });

    if (!voiceChannel) {
      await interaction.editReply("Ban can vao voice channel truoc, roi go `/join`.");
      return;
    }

    const botMember = await interaction.guild.members.fetchMe();
    const permissions = voiceChannel.permissionsFor(botMember);
    const canView = permissions?.has("ViewChannel");
    const canConnect = permissions?.has("Connect");
    const canSpeak = permissions?.has("Speak");

    console.log("Quyen voice cua bot", {
      canView,
      canConnect,
      canSpeak,
      permissions: permissions?.toArray()
    });

    if (!canView || !canConnect || !canSpeak) {
      await interaction.editReply(
        `Bot thieu quyen trong voice channel nay: View=${canView}, Connect=${canConnect}, Speak=${canSpeak}.`
      );
      return;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    connection.on("stateChange", (oldState, newState) => {
      console.log("Voice state change", {
        from: voiceStatusName(oldState.status),
        to: voiceStatusName(newState.status),
        guild: interaction.guild.name,
        channel: voiceChannel.name
      });
    });

    connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
      console.log("Voice disconnected", {
        reason: newState.reason,
        closeCode: newState.closeCode
      });

      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch (error) {
        console.error("Voice mat ket noi qua lau, dong connection:", error);
        connection.destroy();
        voiceSessions.delete(interaction.guild.id);
      }
    });

    connection.on("error", (error) => {
      console.error("Voice connection error:", error);
    });

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });

    const session = {
      connection,
      player,
      textChannelId: interaction.channelId,
      queue: [],
      playing: false
    };

    player.on("stateChange", (oldState, newState) => {
      console.log("Audio player state change", {
        from: audioStatusName(oldState.status),
        to: audioStatusName(newState.status)
      });
    });

    player.on("error", (error) => {
      console.error("Loi audio player:", error);
      session.playing = false;
      void playNextSpeech(session);
    });

    connection.subscribe(player);
    voiceSessions.set(interaction.guild.id, session);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      console.log("Voice connection ready", {
        guild: interaction.guild.name,
        channel: voiceChannel.name
      });
    } catch (error) {
      console.error("Voice chua bao Ready kip thoi, van giu ket noi de thu phat audio:", error);
    }

    await interaction.editReply(
      `Da vao voice channel **${voiceChannel.name}**. Minh se doc tin nhan trong kenh nay.`
    );
    enqueueSpeech(session, "Bot da san sang doc tin nhan.");
  }

  if (interaction.commandName === "leave") {
    await interaction.deferReply();

    const session = voiceSessions.get(interaction.guild.id);
    const connection = session?.connection || getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.editReply("Bot dang khong o voice channel nao.");
      return;
    }

    connection.destroy();
    voiceSessions.delete(interaction.guild.id);
    await interaction.editReply("Da roi khoi voice channel.");
  }

  if (interaction.commandName === "beep") {
    await interaction.deferReply();

    const session = voiceSessions.get(interaction.guild.id);

    if (!session) {
      await interaction.editReply("Bot chua o voice channel. Go `/join` truoc.");
      return;
    }

    enqueueBeep(session);
    await interaction.editReply("Dang phat tieng bip kiem tra.");
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const serverName = message.guild?.name || "Tin nhan rieng";
  const channelName = message.channel?.name || "DM";

  console.log(
    `[${serverName} #${channelName}] ${message.author.tag}: ${message.content}`
  );

  const session = message.guild ? voiceSessions.get(message.guild.id) : null;

  if (session && session.textChannelId === message.channel.id && message.content.trim()) {
    enqueueSpeech(
      session,
      `${message.member?.displayName || message.author.username} noi: ${message.content}`
    );
  }

  if (!message.content.startsWith(prefix)) return;

  const [command, ...args] = message.content
    .slice(prefix.length)
    .trim()
    .split(/\s+/);

  if (!command) return;

  if (command === "ping") {
    await message.reply("pong");
    return;
  }

  if (command === "say") {
    const text = args.join(" ");

    if (!text) {
      await message.reply(`Dung: \`${prefix}say noi dung can noi\``);
      return;
    }

    await message.channel.send(text);
    return;
  }

  if (command === "help") {
    await message.reply(
      [
        "Cac lenh hien co:",
        `\`${prefix}ping\` - Kiem tra bot dang chay.`,
        `\`${prefix}say <noi dung>\` - Bot gui lai noi dung ban nhap.`,
        `\`${prefix}help\` - Xem danh sach lenh.`
      ].join("\n")
    );
  }
});

function enqueueSpeech(session, text) {
  const cleanText = text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/<@!?(\d+)>/g, "ai do")
    .replace(/<#(\d+)>/g, "mot kenh")
    .replace(/<a?:\w+:\d+>/g, "emoji")
    .slice(0, 250);

  session.queue.push(cleanText);
  void playNextSpeech(session);
}

function enqueueBeep(session) {
  session.queue.push({ type: "beep" });
  void playNextSpeech(session);
}

async function playNextSpeech(session) {
  if (session.playing || session.queue.length === 0) return;

  session.playing = true;
  const item = session.queue.shift();

  try {
    if (typeof item === "object" && item.type === "beep") {
      console.log("Bat dau phat beep");
      const ffmpeg = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=2",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1"
      ]);

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
      });
      resource.volume?.setVolume(2);

      session.player.play(resource);

      session.player.once(AudioPlayerStatus.Idle, () => {
        console.log("Phat beep xong");
        session.playing = false;
        void playNextSpeech(session);
      });

      ffmpeg.once("error", (error) => {
        console.error("Loi ffmpeg beep:", error);
        session.playing = false;
        void playNextSpeech(session);
      });
      return;
    }

    const text = item;
    const wavPath = await createSpeechFile(text);
    console.log("Bat dau doc TTS:", text);
    console.log("File TTS:", wavPath, fs.statSync(wavPath).size, "bytes");
    const resource = createAudioResource(wavPath, {
      inlineVolume: true
    });
    resource.volume?.setVolume(2);

    session.player.play(resource);

    session.player.once(AudioPlayerStatus.Idle, () => {
      console.log("Doc TTS xong");
      fs.rm(wavPath, { force: true }, () => {});
      session.playing = false;
      void playNextSpeech(session);
    });
  } catch (error) {
    console.error("Khong tao duoc audio TTS:", error);
    session.playing = false;
    void playNextSpeech(session);
  }
}

function createSpeechFile(text) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(ttsDir, { recursive: true });

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const wavPath = path.join(ttsDir, `${id}.wav`);
    const encodedText = Buffer.from(text, "utf8").toString("base64");

    const psCommand = [
      "Add-Type -AssemblyName System.Speech;",
      "$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOT_TTS_TEXT_B64));",
      "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      "$speaker.Rate = 0;",
      "$speaker.Volume = 100;",
      "$speaker.SetOutputToWaveFile($env:BOT_TTS_WAV_PATH);",
      "$speaker.Speak($text);",
      "$speaker.Dispose();"
    ].join(" ");

    let stderr = "";
    let stdout = "";
    const powershell = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      psCommand
    ], {
      env: {
        ...process.env,
        BOT_TTS_TEXT_B64: encodedText,
        BOT_TTS_WAV_PATH: wavPath
      }
    });

    powershell.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    powershell.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    powershell.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell TTS thoat voi ma ${code}: ${stderr || stdout || "khong co thong tin loi"}`));
        return;
      }

      resolve(wavPath);
    });

    powershell.once("error", reject);
  });
}

client.login(token);
