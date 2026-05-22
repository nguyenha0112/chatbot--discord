require("dotenv").config();
require("node:dns").setDefaultResultOrder("ipv4first");

const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
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

// Global states
const sessions = new Map(); 
const globalActiveVoiceChannels = new Set(); // Stores voiceChannel.id to prevent collision

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Vao voice channel va doc tin nhan trong kenh hien tai bang tieng Viet."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Roi khoi voice channel."),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Xem cac bot dang doc o voice channel nao."),
  new SlashCommandBuilder()
    .setName("leaveall")
    .setDescription("Cho tat ca bot roi khoi voice channel trong server nay.")
].map((command) => command.toJSON());

function getTokens() {
  const tokens = [];
  // Scan for DISCORD_TOKEN_1, DISCORD_TOKEN_2...
  for (const key in process.env) {
    if (key.startsWith("DISCORD_TOKEN_")) {
      tokens.push({
        token: process.env[key],
        clientId: process.env[`DISCORD_CLIENT_ID_${key.split('_').pop()}`] || ""
      });
    }
  }
  
  // Support legacy DISCORD_TOKEN if no new ones found
  if (tokens.length === 0 && process.env.DISCORD_TOKEN) {
    tokens.push({
      token: process.env.DISCORD_TOKEN,
      clientId: process.env.DISCORD_CLIENT_ID || ""
    });
  }
  
  return tokens;
}

const botTokens = getTokens();

if (botTokens.length === 0) {
  console.error("Thieu DISCORD_TOKEN_... trong file .env");
  process.exit(1);
}

function resetIdleTimeout(session) {
  if (session.idleTimeout) {
    clearTimeout(session.idleTimeout);
  }
  
  session.idleTimeout = setTimeout(() => {
    console.log(`[${session.clientTag}] Roi phong ${session.voiceChannelName} do khong hoat dong 30 phut.`);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
    sessions.delete(session.sessionKey);
    globalActiveVoiceChannels.delete(session.voiceChannelId);
  }, 30 * 60 * 1000); // 30 minutes
}

function clearSession(session) {
  if (session) {
    if (session.idleTimeout) {
      clearTimeout(session.idleTimeout);
    }
    globalActiveVoiceChannels.delete(session.voiceChannelId);
    sessions.delete(session.sessionKey);
  }
}

function getSessionKey(guildId, clientId) {
  return `${guildId}_${clientId}`;
}

function getGuildSessions(guildId) {
  return [...sessions.values()].filter((session) => session.guildId === guildId);
}

function hasManageServerPermission(member) {
  return new PermissionsBitField(member.permissions).has(PermissionsBitField.Flags.ManageGuild);
}

function startBot(botConfig, botIndex) {
  const { token, clientId } = botConfig;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent
    ]
  });

  client.once(Events.ClientReady, async () => {
    console.log(`[Bot ${botIndex}] Da dang nhap: ${client.user.tag}`);

    try {
      if (clientId) {
        const rest = new REST({ version: "10" }).setToken(token);
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
      } else {
        await Promise.all(client.guilds.cache.map((guild) => guild.commands.set(commands)));
      }
      console.log(`[${client.user.tag}] Da dang ky slash commands: /join, /leave`);
    } catch (error) {
      console.error(`[${client.user.tag}] Khong dang ky duoc slash commands:`, error);
    }
  });

  client.on("error", (error) => {
    console.error(`[${client.user?.tag || "Bot"}] Client error:`, error);
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

      const sessionKey = getSessionKey(interaction.guild.id, client.user.id);
      const voiceGroup = client.user.id;
      const oldSession = sessions.get(sessionKey);

      // Check collision: if another bot is already in this channel, prevent joining
      if (!oldSession && globalActiveVoiceChannels.has(voiceChannel.id)) {
        await interaction.editReply("Da co mot bot khac dang o trong phong nay, vui long chon phong khac de tranh dinh am thanh!");
        return;
      }

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
        resetIdleTimeout(oldSession);
        enqueue(oldSession, "Bot da chuyen sang doc kenh nay.", interaction.user.tag);
        return;
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        group: voiceGroup,
        selfDeaf: false,
        selfMute: false
      });

      // Mark this channel as occupied globally
      globalActiveVoiceChannels.add(voiceChannel.id);

      connection.on("stateChange", (_oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Destroyed) {
            const currentSession = sessions.get(sessionKey);
            clearSession(currentSession);
        }
      });

      connection.on("error", (error) => {
        console.error(`[${client.user.tag}] Voice error:`, error);
        const currentSession = sessions.get(sessionKey);
        clearSession(currentSession);
      });

      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play
        }
      });

      player.on("error", (error) => {
        console.error(`[${client.user.tag}] Audio error:`, error);
        const session = sessions.get(sessionKey);
        if (session) {
          session.playing = false;
          void playNext(session);
        }
      });

      connection.subscribe(player);

      const session = {
        connection,
        player,
        guildId: interaction.guild.id,
        voiceChannelId: voiceChannel.id,
        voiceChannelName: voiceChannel.name,
        textChannelId: interaction.channelId,
        queue: [],
        playing: false,
        clientTag: client.user.tag,
        sessionKey,
        voiceGroup,
        idleTimeout: null
      };

      sessions.set(sessionKey, session);
      resetIdleTimeout(session);

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
      } catch (error) {
        clearSession(session);
        connection.destroy();
        console.error(`[${client.user.tag}] Voice khong vao Ready:`, error);
        await interaction.editReply(
          "Bot da vao voice nhung ket noi am thanh khong Ready. Hay kiem tra lai."
        );
        return;
      }

      await interaction.editReply(
        `Da vao **${voiceChannel.name}**. Mình sẽ đọc tin nhắn kênh này.`
      );
      enqueue(session, "Bot dễ thương cu te đã sẵn sàng đọc tin nhắn.", interaction.user.tag);
    }

    if (interaction.commandName === "leave") {
      try {
        await interaction.deferReply();
      } catch (e) {
        console.error("Loi deferReply:", e.message);
        return;
      }

      const sessionKey = getSessionKey(interaction.guild.id, client.user.id);
      const voiceGroup = client.user.id;
      const session = sessions.get(sessionKey);
      const connection = session?.connection || getVoiceConnection(interaction.guild.id, voiceGroup);

      if (!connection) {
        await interaction.editReply("Bot dang khong o channel nao.");
        return;
      }

      clearSession(session);
      connection.destroy();
      await interaction.editReply("Da roi khoi voice channel.");
    }

    if (interaction.commandName === "status") {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (e) {
        console.error("Loi deferReply:", e.message);
        return;
      }

      const guildSessions = getGuildSessions(interaction.guild.id);
      if (guildSessions.length === 0) {
        await interaction.editReply("Hien khong co bot nao dang o voice channel.");
        return;
      }

      const statusText = guildSessions
        .map((session) => {
          const state = session.connection.state.status;
          const queueCount = session.queue.length;
          return `- ${session.clientTag}: **${session.voiceChannelName}** | voice: ${state} | hang doi: ${queueCount}`;
        })
        .join("\n");

      await interaction.editReply(statusText);
    }

    if (interaction.commandName === "leaveall") {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (e) {
        console.error("Loi deferReply:", e.message);
        return;
      }

      if (!hasManageServerPermission(interaction.member)) {
        await interaction.editReply("Ban can quyen Manage Server de dung `/leaveall`.");
        return;
      }

      const guildSessions = getGuildSessions(interaction.guild.id);
      if (guildSessions.length === 0) {
        await interaction.editReply("Khong co bot nao dang o voice channel.");
        return;
      }

      for (const session of guildSessions) {
        clearSession(session);
        if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          session.connection.destroy();
        }
      }

      await interaction.editReply(`Đã cho ${guildSessions.length} bot rời khoi voice channel.`);
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (oldState.member?.id !== client.user.id) return;

    const sessionKey = getSessionKey(oldState.guild.id, client.user.id);
    const session = sessions.get(sessionKey);
    if (!session) return;

    if (!newState.channelId) {
      console.log(`[${client.user.tag}] Bi dua/kick khoi voice, don session.`);
      clearSession(session);
      if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        session.connection.destroy();
      }
      return;
    }

    if (newState.channelId !== session.voiceChannelId) {
      globalActiveVoiceChannels.delete(session.voiceChannelId);
      session.voiceChannelId = newState.channelId;
      session.voiceChannelName = newState.channel?.name || "unknown";
      globalActiveVoiceChannels.add(session.voiceChannelId);
      console.log(`[${client.user.tag}] Bi chuyen sang voice channel ${session.voiceChannelName}.`);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (!message.guild || message.author.bot) return;

    const sessionKey = getSessionKey(message.guild.id, client.user.id);
    const session = sessions.get(sessionKey);

    if (!session) return;
    if (message.channel.id !== session.textChannelId) return;
    if (!message.content.trim()) return;
    if (session.connection.state.status === VoiceConnectionStatus.Destroyed) {
      clearSession(session);
      return;
    }

    enqueue(session, message.content, message.author.tag);
  });

  client.login(token);
}

function enqueue(session, text, authorTag = "Unknown user") {
  // RAM Protection: Limit queue length
  if (session.queue.length >= 10) {
    console.log(`[${session.clientTag}] Hang doi da day (>10), bo qua tin nhan de tranh qua tai RAM.`);
    return;
  }
  
  // Reset idle timeout since bot is active
  resetIdleTimeout(session);

  const cleanText = text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/<@!?(\d+)>/g, "ai do")
    .replace(/<#(\d+)>/g, "mot kenh")
    .replace(/<a?:\w+:\d+>/g, "emoji")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  if (!cleanText) return;

  session.queue.push({ text: cleanText, authorTag });
  void playNext(session);
}

async function playNext(session) {
  if (session.playing || session.queue.length === 0) return;

  if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
    try {
      await entersState(session.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      console.error(`[${session.clientTag}] Voice chưa Ready sau khi doi reconnect, bỏ qua hàng đợi doc.`);
      session.queue.length = 0;
      return;
    }
  }

  session.playing = true;
  const item = session.queue.shift();
  const text = item.text;
  const authorTag = item.authorTag;

  try {
    console.log(`[${authorTag}] Doc: ${text}`);

    const base64Audio = await googleTTS.getAudioBase64(text, {
      lang: "vi",
      slow: false,
      host: "https://translate.google.com"
    });
    
    const audioBuffer = Buffer.from(base64Audio, "base64");

    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i", "pipe:0",
      "-af", "atempo=1.2",
      "-c:a", "libopus",
      "-b:a", "48k",
      "-ac", "2",
      "-ar", "48000",
      "-f", "opus",
      "pipe:1"
    ]);

    ffmpeg.stdin.write(audioBuffer);
    ffmpeg.stdin.end();

    ffmpeg.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[${authorTag}] FFmpeg stderr:`, text);
    });

    ffmpeg.on("error", (err) => {
      console.error(`[${authorTag}] FFmpeg spawn error:`, err);
    });

    ffmpeg.on("close", (code, signal) => {
      if (code !== 0) console.error(`[${authorTag}] FFmpeg exited with code ${code}, signal ${signal}`);
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
    });

    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Idle, 30_000);
  } catch (error) {
    console.error(`[${authorTag}] Lỗi đọc TTS:`, error);
  } finally {
    session.playing = false;
    void playNext(session);
  }
}

// Start all bots
botTokens.forEach((botConfig, i) => startBot(botConfig, i + 1));

// Shared health server
const port = process.env.PORT || 3000;
http
  .createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Discord Vietnamese TTS bot is running. Multi-bot mode: ${botTokens.length} bots active.`);
  })
  .listen(port, () => {
    console.log(`Health server listening on port ${port}`);
  });
