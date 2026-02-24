const { Client, GatewayIntentBits, Events, ActivityType } = require("discord.js");

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BASE44_AUTH_TOKEN = process.env.BASE44_AUTH_TOKEN;
const APP_ID = "687ed6bea54c832b17eb40bc";
const API_URL = `https://base44.app/api/apps/${APP_ID}/integration-endpoints/Core/InvokeLLM`;

const HEADERS = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  authorization: `Bearer ${BASE44_AUTH_TOKEN}`,
  "content-type": "application/json",
  origin: "https://schoolace.org",
  referer: "https://schoolace.org/",
  "x-app-id": APP_ID,
  "x-origin-url": "https://schoolace.org/AIPersonalAgent",
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          label: { type: "string" },
          target: { type: "string", minLength: 1 },
          params: { type: "object" },
          auto_execute: { type: "boolean" },
        },
        required: ["type", "label", "target"],
      },
    },
  },
  required: ["content"],
};

// --- State ---
// Map of channel_id -> { history: [], active: bool }
const channelState = new Map();
const blacklistedUsers = new Set();

function getChannelState(channelId) {
  if (!channelState.has(channelId)) {
    channelState.set(channelId, { history: [], active: false });
  }
  return channelState.get(channelId);
}

// --- API ---
async function sendToBase44(channelId, userMessage) {
  const state = getChannelState(channelId);

  // Append user message to history
  state.history.push({ role: "user", content: userMessage });

  const payload = {
    prompt: JSON.stringify(state.history),
    response_json_schema: RESPONSE_SCHEMA,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  const result = await res.json();

  let assistantResponse = result.response ?? result;

  if (typeof assistantResponse === "string") {
    try {
      assistantResponse = JSON.parse(assistantResponse);
    } catch {
      assistantResponse = { content: assistantResponse };
    }
  }

  // Append assistant response to history
  state.history.push({
    role: "assistant",
    content:
      typeof assistantResponse === "object"
        ? JSON.stringify(assistantResponse)
        : assistantResponse,
  });

  return assistantResponse;
}

// --- Actions ---
async function executeActions(message, actions) {
  if (!Array.isArray(actions)) return;

  for (const action of actions) {
    if (!action.auto_execute) continue;

    const { type, target, params = {}, label } = action;

    try {
      if (type === "send_message") {
        const channel = message.client.channels.cache.get(target) ?? message.channel;
        await channel.send(params.content ?? label);
      } else if (type === "reply") {
        await message.reply(params.content ?? label);
      } else if (type === "react") {
        await message.react(target);
      } else if (type === "delete_message") {
        await message.delete();
      }
    } catch (err) {
      console.error(`Action '${type}' failed:`, err.message);
    }
  }
}

// --- Bot ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  client.user.setPresence({
    activities: [{ name: "thinking about cats", type: ActivityType.Custom, emoji: { name: "🐱" }}],
    status: "online",
  });
});



client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const channelId = message.channel.id;
  const userId = message.author.id;

  // --- Commands ---
  if (content === "ai~start") {
    if (!message.member?.permissions.has("ManageChannels")) {
      return message.reply("Insufficient permissions.");
    }
    getChannelState(channelId).active = true;
    return message.reply(`Bot active in <#${channelId}>.`);
  }

  if (content === "ai~stop") {
    if (!message.member?.permissions.has("ManageChannels")) {
      return message.reply("Insufficient permissions.");
    }
    getChannelState(channelId).active = false;
    return message.reply(`Bot stopped in <#${channelId}>.`);
  }

  if (content.startsWith("ai~blacklist ")) {
    if (!message.member?.permissions.has("ManageGuild")) {
      return message.reply("Insufficient permissions.");
    }
    const targetId = content.split(" ")[1]?.trim();
    if (!targetId) return message.reply("Usage: `ai~blacklist <user_id>`");
    blacklistedUsers.add(targetId);
    return message.reply(`User \`${targetId}\` blacklisted.`);
  }

  if (content.startsWith("ai~whitelist ")) {
    if (!message.member?.permissions.has("ManageGuild")) {
      return message.reply("Insufficient permissions.");
    }
    const targetId = content.split(" ")[1]?.trim();
    if (!targetId) return message.reply("Usage: `ai~whitelist <user_id>`");
    blacklistedUsers.delete(targetId);
    return message.reply(`User \`${targetId}\` whitelisted.`);
  }

  // Ignore other ai~ commands
  if (content.startsWith("ai~")) return;

  // --- Message handling ---
  const state = getChannelState(channelId);
  if (!state.active) return;
  if (blacklistedUsers.has(userId)) return;

  try {
    const response = await sendToBase44(channelId, content);

    if (response.content) {
      await message.reply(response.content);
    }

    if (response.actions?.length) {
      await executeActions(message, response.actions);
    }
  } catch (err) {
    console.error("API error:", err.message);
    await message.reply(`Error: ${err.message}`);
  }
});

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN not set.");
if (!BASE44_AUTH_TOKEN) throw new Error("BASE44_AUTH_TOKEN not set.");

client.login(DISCORD_TOKEN);
