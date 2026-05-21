require("dotenv").config();
require("node:dns").setDefaultResultOrder("ipv4first");

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
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} = require("@discordjs/voice");
const googleTTS = require("google-tts-api");
const { spawn } = require("node:child_process");
const http = require("node:http");
const ffmpegPath = require("ffmpeg-static");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) {
  console.error("Thieu DISCORD_TOKEN trong file .env");
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
    .setDescription("Vao voice channel va doc tin nhan trong kenh hien tai bang tieng Viet."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Roi khoi voice channel.")
].map((command) => command.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`Bot da dang nhap: ${client.user.tag}`);

  try {
    if (clientId) {
      const rest = new REST({ version: "10" }).setToken(token);
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
    } else {
      await Promise.all(client.guilds.cache.map((guild) => guild.commands.set(commands)));
    }

    console.log("Da dang ky slash commands: /join, /leave");
  } catch (error) {
    console.error("Khong dang ky duoc slash commands:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === "join") {
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error("Loi deferReply:", e.message);
      return;
    }

    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      await interaction.editReply("Ban vao voice channel truoc roi go `/join`.");
      return;
    }

    const botMember = await interaction.guild.members.fetchMe();
    const permissions = voiceChannel.permissionsFor(botMember);

    if (!permissions?.has("Connect") || !permissions?.has("Speak")) {
      await interaction.editReply("Bot thieu quyen Connect hoac Speak trong voice channel nay.");
      return;
    }

    const oldSession = sessions.get(interaction.guild.id);

    if (
      oldSession &&
      oldSession.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      if (oldSession.voiceChannelId !== voiceChannel.id) {
        await interaction.editReply(
          `Bot dang doc o voice channel **${oldSession.voiceChannelName}**. Go \`/leave\` truoc neu muon chuyen phong.`
        );
        return;
      }

      oldSession.textChannelId = interaction.channelId;
      oldSession.queue.length = 0;
      await interaction.editReply(
        `Bot da o san **${voiceChannel.name}**. Minh se doc tin nhan trong kenh nay.`
      );
      enqueue(oldSession, "Bot da chuyen sang doc kenh nay.");
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
      console.error("Voice error:", error);
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
      console.error("Audio error:", error);
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
      voiceChannelId: voiceChannel.id,
      voiceChannelName: voiceChannel.name,
      textChannelId: interaction.channelId,
      queue: [],
      playing: false
    };

    sessions.set(interaction.guild.id, session);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
    } catch (error) {
      sessions.delete(interaction.guild.id);
      connection.destroy();
      console.error("Voice khong vao Ready:", error);
      await interaction.editReply(
        "Bot da vao voice nhung ket noi am thanh khong Ready. Hay dung Node 22 LTS va thu doi Region voice sang Singapore/Hong Kong/Japan."
      );
      return;
    }

    await interaction.editReply(
      `Da vao **${voiceChannel.name}**. Mình sẽ đọc tin nhắn kênh này.`
    );
    enqueue(session, "Bot đã sẵng sàng đọc tin nhắn.");
  }

  if (interaction.commandName === "leave") {
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error("Loi deferReply:", e.message);
      return;
    }

    const session = sessions.get(interaction.guild.id);
    const connection = session?.connection || getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.editReply("bot đang không ở chanel nào.");
      return;
    }

    connection.destroy();
    sessions.delete(interaction.guild.id);
    await interaction.editReply("Đã rời khỏi voice channel.");
  }
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.author.bot) return;

  const session = sessions.get(message.guild.id);

  console.log(`[${message.guild.name} #${message.channel.name}] ${message.author.tag}: ${message.content}`);

  if (!session) return;
  if (message.channel.id !== session.textChannelId) return;
  if (!message.content.trim()) return;
  if (session.connection.state.status === VoiceConnectionStatus.Destroyed) {
    sessions.delete(message.guild.id);
    return;
  }

  const name = message.member?.displayName || message.author.username;
  enqueue(session, `${name} nói: ${message.content}`);
});

function enqueue(session, text) {
  const cleanText = text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/<@!?(\d+)>/g, "ai đó")
    .replace(/<#(\d+)>/g, "mot kenh")
    .replace(/<a?:\w+:\d+>/g, "emoji")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  if (!cleanText) return;

  session.queue.push(cleanText);
  void playNext(session);
}

async function playNext(session) {
  if (session.playing || session.queue.length === 0) return;

  if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
    console.error("Voice chua Ready, bo qua hang doi doc.");
    session.queue.length = 0;
    return;
  }

  session.playing = true;
  const text = session.queue.shift();

  try {
    console.log("Doc:", text);

    const url = googleTTS.getAudioUrl(text, {
      lang: "vi",
      slow: false,
      host: "https://translate.google.com"
    });

    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-user_agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      "-i",
      url,
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1"
    ]);

    ffmpeg.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error("FFmpeg:", text);
    });

    ffmpeg.on("error", (err) => {
      console.error("FFmpeg spawn error:", err);
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) console.error(`FFmpeg exited with code ${code}`);
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    resource.volume?.setVolume(1.4);

    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Idle, 30_000);
  } catch (error) {
    console.error("Loi doc TTS:", error);
  } finally {
    session.playing = false;
    void playNext(session);
  }
}

const port = process.env.PORT || 3000;

http
  .createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Discord Vietnamese TTS bot is running");
  })
  .listen(port, () => {
    console.log(`Health server listening on port ${port}`);
  });

client.login(token);
