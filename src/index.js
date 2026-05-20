require("dotenv").config();

const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  getVoiceConnection,
  joinVoiceChannel
} = require("@discordjs/voice");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const ttsDir = path.join(os.tmpdir(), "bot-chat-discord-tts");

if (!token) {
  console.error("Thieu DISCORD_TOKEN trong file .env.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

const sessions = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bot vao voice channel cua ban va doc tin nhan trong kenh nay."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Bot roi khoi voice channel.")
].map((command) => command.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`Bot da dang nhap: ${client.user.tag}`);
  console.log(generateDependencyReport());

  const rest = new REST({ version: "10" }).setToken(token);

  if (clientId) {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  } else {
    await Promise.all(client.guilds.cache.map((guild) => guild.commands.set(commands)));
  }

  console.log("Da dang ky slash commands: /join, /leave");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === "join") {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      await interaction.editReply("Ban can vao voice channel truoc, roi go `/join`.");
      return;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    connection.on("stateChange", (oldState, newState) => {
      console.log(`Voice: ${oldState.status} -> ${newState.status}`);
    });

    connection.on("error", (error) => {
      console.error("Voice connection error:", error);
    });

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });

    player.on("stateChange", (oldState, newState) => {
      console.log(`Audio: ${oldState.status} -> ${newState.status}`);
    });

    player.on("error", (error) => {
      console.error("Audio player error:", error);
      const session = sessions.get(interaction.guild.id);
      if (session) {
        session.playing = false;
        void playNext(session);
      }
    });

    connection.subscribe(player);

    const session = {
      connection,
      player,
      textChannelId: interaction.channelId,
      queue: [],
      playing: false
    };

    sessions.set(interaction.guild.id, session);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
    } catch (error) {
      connection.destroy();
      sessions.delete(interaction.guild.id);
      console.error("Voice khong vao Ready:", error);
      await interaction.editReply(
        "Bot vao voice nhung khong mo duoc ket noi am thanh. Cap nhat Node.js len 22 LTS hoac doi Region voice channel sang Singapore/Hong Kong/Japan roi thu lai."
      );
      return;
    }

    await interaction.editReply(
      `Da vao **${voiceChannel.name}**. Minh se doc tin nhan trong kenh nay.`
    );
    enqueue(session, "Bot da san sang doc tin nhan.");
  }

  if (interaction.commandName === "leave") {
    await interaction.deferReply();

    const session = sessions.get(interaction.guild.id);
    const connection = session?.connection || getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.editReply("Bot dang khong o voice channel nao.");
      return;
    }

    connection.destroy();
    sessions.delete(interaction.guild.id);
    await interaction.editReply("Da roi khoi voice channel.");
  }
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.author.bot) return;

  console.log(`[${message.guild.name} #${message.channel.name}] ${message.author.tag}: ${message.content}`);

  const session = sessions.get(message.guild.id);
  if (!session) return;
  if (session.textChannelId !== message.channel.id) return;
  if (!message.content.trim()) return;

  enqueue(
    session,
    `${message.member?.displayName || message.author.username} noi: ${message.content}`
  );
});

function enqueue(session, text) {
  const cleanText = text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/<@!?(\d+)>/g, "ai do")
    .replace(/<#(\d+)>/g, "mot kenh")
    .replace(/<a?:\w+:\d+>/g, "emoji")
    .slice(0, 250);

  session.queue.push(cleanText);
  void playNext(session);
}

async function playNext(session) {
  if (session.playing || session.queue.length === 0) return;

  if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
    console.error("Khong phat audio vi voice chua Ready:", session.connection.state.status);
    return;
  }

  session.playing = true;

  const text = session.queue.shift();
  let wavPath;

  try {
    wavPath = await createSpeechFile(text);
    console.log("Doc:", text);

    const resource = createAudioResource(wavPath, {
      inlineVolume: true
    });
    resource.volume?.setVolume(1.5);

    session.player.play(resource);

    await entersState(session.player, AudioPlayerStatus.Idle, 30_000);
  } catch (error) {
    console.error("Loi phat TTS:", error);
  } finally {
    if (wavPath) fs.rm(wavPath, { force: true }, () => {});
    session.playing = false;
    void playNext(session);
  }
}

function createSpeechFile(text) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(ttsDir, { recursive: true });

    const wavPath = path.join(
      ttsDir,
      `${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
    );
    const encodedText = Buffer.from(text, "utf8").toString("base64");

    const script = [
      "Add-Type -AssemblyName System.Speech;",
      "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOT_TTS_TEXT));",
      "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      "$speaker.Rate = 0;",
      "$speaker.Volume = 100;",
      "$speaker.SetOutputToWaveFile($env:BOT_TTS_FILE);",
      "$speaker.Speak($text);",
      "$speaker.Dispose();"
    ].join(" ");

    let errorText = "";
    const powershell = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], {
      env: {
        ...process.env,
        BOT_TTS_TEXT: encodedText,
        BOT_TTS_FILE: wavPath
      }
    });

    powershell.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });

    powershell.once("error", reject);

    powershell.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(errorText || `PowerShell thoat voi ma ${code}`));
        return;
      }

      resolve(wavPath);
    });
  });
}

client.login(token);
