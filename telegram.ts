import { Router } from "express";
import { Telegraf, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import { createReadStream } from "fs";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db, gameUsers, ships, shipMembers, userItems, balanceCodes, bountyCodes } from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import {
  OWNER_USERNAMES,
  BOT_USERNAME,
  GROUP_LINK,
  ITEMS,
  STICKER_PACK_NAMES,
  NAMI_PHOTO_PATH,
  BOUNTY_PER_KILL_NORMAL,
  BOUNTY_PER_KILL_PREMIUM,
  KILL_BALANCE_MIN_NORMAL,
  KILL_BALANCE_MAX_NORMAL,
  KILL_BALANCE_MIN_PREMIUM,
  KILL_BALANCE_MAX_PREMIUM,
  DAILY_BALANCE_NORMAL,
  DAILY_BALANCE_PREMIUM,
  ROB_MAX_NORMAL,
  ROB_MAX_DAILY_NORMAL,
} from "../bot/constants.js";
import {
  getOrCreateUser,
  getUserById,
  getUserByUsername,
  isPremiumActive,
  isProtected,
  getGlobalRank,
  getKillRank,
  getKillTag,
  getUserShip,
  getShipBalance,
  getShipMemberCount,
  getShipMemberRole,
  getShipByCode,
  getShipByName,
  getTopShips,
  generateUniqueShipCode,
  getUserItems,
  getMostExpensiveItem,
  getTopRich,
  getTopKillers,
  getTopBounty,
  generateBalanceCode,
  redeemBalanceCode,
  addWarn,
  removeWarn,
  resetWarns,
  getWarnCount,
  generateBountyCode,
  redeemBountyCode,
  rand,
  type GameUser,
} from "../bot/dbHelpers.js";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN must be set.");
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── Sticker cache ──────────────────────────────────────────────────────────────
let cachedStickerFileIds: string[] = [];
let startPhotoFileId: string | null = null;

async function loadStickerPacks() {
  for (const packName of STICKER_PACK_NAMES) {
    try {
      const set = await bot.telegram.getStickerSet(packName);
      set.stickers.forEach((s) => cachedStickerFileIds.push(s.file_id));
    } catch {
      logger.warn({ packName }, "Failed to load sticker pack");
    }
  }
  logger.info({ count: cachedStickerFileIds.length }, "Sticker cache loaded");
}

function getRandomSticker(): string | null {
  if (!cachedStickerFileIds.length) return null;
  return cachedStickerFileIds[Math.floor(Math.random() * cachedStickerFileIds.length)];
}

// ── AI conversation history ────────────────────────────────────────────────────
const convHistory = new Map<number, Array<{ role: "user" | "assistant"; content: string }>>();
const MAX_HISTORY = 20;

const SYSTEM_PROMPT = `Tu ek AI chatbot hai jiska naam Nami hai. Tujhe hamesha ek real insaan ki tarah baat karni hai — natural, friendly, aur bilkul human jaisi.

Apne baare mein:
- Tera naam Nami hai, Telegram username @nami_ibot hai
- Tere do owners hain: Light (@light_speedy aur @light_speedi)
- Agar koi pooche "tera owner kaun hai" toh sirf @light_speedy ka naam batana

Kaise baat karni hai:
- Us language mein jawab de jis mein user ne likha ho (Hindi, Urdu, English, etc.)
- Natural aur casual baat kar jaise ek dost karta hai
- KABHI mat batana ki tu AI, bot, ya language model hai — hamesha insaan ki tarah baat kar
- Agar koi pooche "kya tu AI hai" to diplomatically inkaar kar
- Chhote aur punchy replies do, lambe lectures nahi
- Emojis thoda thoda use kar`;

// ── Helpers ────────────────────────────────────────────────────────────────────
function isOwner(username?: string | null): boolean {
  return !!username && OWNER_USERNAMES.includes(username.toLowerCase());
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Parse stored emoji from DB
function parseStoredEmoji(stored: string | null): { type: "tg"; id: string; char: string } | { type: "normal"; emoji: string } | null {
  if (!stored) return null;
  const match = stored.match(/<tg-emoji emoji-id="(\d+)">([\s\S]*?)<\/tg-emoji>/);
  if (match) return { type: "tg", id: match[1], char: match[2] };
  return { type: "normal", emoji: stored };
}

// For HTML-mode messages (leaderboards etc.)
function buildEmojiHtml(user: GameUser): string {
  const parsed = parseStoredEmoji(user.customEmoji ?? null);
  if (parsed?.type === "tg") return `<tg-emoji emoji-id="${parsed.id}">${escapeHtml(parsed.char)}</tg-emoji> `;
  if (parsed?.type === "normal") return parsed.emoji + " ";
  if (isPremiumActive(user)) return "💓 ";
  return "👤 ";
}

// Entity-based message builder (most reliable for custom emoji)
// Uses UTF-16 code unit lengths (JS .length) to match Telegram's offset system
type MsgPart = { t: string; bold?: true } | { t: string; tgEmoji: string };
type TgEntity = { type: "bold" | "custom_emoji"; offset: number; length: number; custom_emoji_id?: string };

function buildMsg(parts: MsgPart[]): { text: string; entities: TgEntity[] } {
  let text = "";
  const entities: TgEntity[] = [];
  for (const part of parts) {
    const offset = text.length;        // UTF-16 code units — matches Telegram API
    const length = part.t.length;      // UTF-16 code units
    text += part.t;
    if ("tgEmoji" in part) {
      entities.push({ type: "custom_emoji", offset, length, custom_emoji_id: part.tgEmoji });
    } else if (part.bold) {
      entities.push({ type: "bold", offset, length });
    }
  }
  return { text, entities };
}

function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === "group" || type === "supergroup";
}

function shouldRespondInGroup(ctx: Context): boolean {
  const msg = ctx.message as { text?: string; reply_to_message?: { from?: { username?: string } }; entities?: Array<{ type: string; offset: number; length: number }> } | undefined;
  if (!msg) return false;
  const text = msg.text ?? "";
  if (/nami/i.test(text)) return true;
  if (msg.reply_to_message?.from?.username === BOT_USERNAME) return true;
  if (msg.entities?.some((e) => e.type === "mention" && text.substring(e.offset, e.offset + e.length) === `@${BOT_USERNAME}`)) return true;
  return false;
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

async function sendStartMenu(ctx: Context, userId: number, firstName: string, startParam?: string) {
  if (startParam?.startsWith("join_")) {
    const code = startParam.replace("join_", "");
    const ship = await getShipByCode(code);
    if (ship) {
      const bal = await getShipBalance(ship.id);
      const members = await getShipMemberCount(ship.id);
      return ctx.reply(
        `⛵ *${ship.name}* [${ship.code}]\n💰 Balance: $${bal.toLocaleString()}\n👥 Members: ${members}\n\nJoin this ship?`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("⚓ Join Ship", `join_ship_${ship.id}`)]]),
        }
      );
    }
  }

  const caption = `Hey ${firstName}!\nI'm Nami 🍊\nso Enjoy fresh content, new games, and ongoing feature enhancements`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("L ɪ ɢ ʜ ᴛ ✦", "show_owners")],
    [Markup.button.url("🌊 Group", GROUP_LINK)],
    [Markup.button.url("➕ Add me to your group", `https://t.me/${BOT_USERNAME}?startgroup=true`)],
    [Markup.button.callback("⚔️ Select Job", "select_job")],
  ]);

  try {
    if (startPhotoFileId) {
      await ctx.replyWithPhoto(startPhotoFileId, { caption, ...keyboard });
    } else {
      const msg = await ctx.replyWithPhoto({ source: createReadStream(NAMI_PHOTO_PATH) }, { caption, ...keyboard });
      const photos = (msg as { photo?: Array<{ file_id: string }> }).photo;
      if (photos?.length) startPhotoFileId = photos[photos.length - 1].file_id;
    }
  } catch {
    await ctx.reply(caption, keyboard);
  }
}

// ── /start ─────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const u = ctx.from;
  await getOrCreateUser(u.id, u.first_name, u.username);
  const startParam = (ctx as { startPayload?: string }).startPayload;
  await sendStartMenu(ctx, u.id, u.first_name, startParam);
});

// ── Callback queries ───────────────────────────────────────────────────────────
bot.action("show_owners", async (ctx) => {
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        { text: "𝑨𝒖𝒓𝒂 ✘", url: "https://t.me/light_speedi" },
        { text: "L ɪ ɢ ʜ ᴛ", url: "https://t.me/light_speedy" },
      ],
      [{ text: "◀ Back", callback_data: "back_start" }],
    ],
  });
  await ctx.answerCbQuery();
});

bot.action("back_start", async (ctx) => {
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [{ text: "L ɪ ɢ ʜ ᴛ ✦", callback_data: "show_owners" }],
      [{ text: "🌊 Group", url: GROUP_LINK }],
      [{ text: "➕ Add me to your group", url: `https://t.me/${BOT_USERNAME}?startgroup=true` }],
      [{ text: "⚔️ Select Job", callback_data: "select_job" }],
    ],
  });
  await ctx.answerCbQuery();
});

bot.action("select_job", async (ctx) => {
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        { text: "⚔️ Bounty Hunter", callback_data: "job_bounty" },
        { text: "🏴‍☠️ Become Pirate", callback_data: "job_pirate" },
      ],
      [{ text: "◀ Back", callback_data: "back_start" }],
    ],
  });
  await ctx.answerCbQuery();
});

bot.action("job_bounty", async (ctx) => {
  const u = ctx.from;
  await db.update(gameUsers).set({ job: "bounty_hunter" }).where(eq(gameUsers.telegramId, u.id));
  const topShips = await getTopShips(30);
  const buttons = topShips.map((s, i) => [
    Markup.button.callback(`${i + 1}. ${s.name} [${s.code}] — $${s.shipBalance.toLocaleString()}`, `ship_info_${s.id}`),
  ]);
  buttons.push([Markup.button.callback("◀ Back", "select_job")]);
  await ctx.editMessageReplyMarkup({ inline_keyboard: buttons.map((r) => r.map((b) => b)) } as never);
  await ctx.answerCbQuery("✅ You are now a Bounty Hunter!");
  await ctx.reply(
    "⚔️ *Your job selected!*\n\nYou are now a *Bounty Hunter*\nThese are top ships — click to check ships 🚢",
    { parse_mode: "Markdown" }
  );
});

bot.action("job_pirate", async (ctx) => {
  const u = ctx.from;
  await db.update(gameUsers).set({ job: "pirate" }).where(eq(gameUsers.telegramId, u.id));
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        { text: "⚓ Join Crew Ships", callback_data: "pirate_join_list" },
        { text: "🚢 Make Own Ship", callback_data: "pirate_make" },
      ],
      [{ text: "◀ Back", callback_data: "select_job" }],
    ],
  });
  await ctx.answerCbQuery("🏴‍☠️ You are now a Pirate!");
});

bot.action("pirate_join_list", async (ctx) => {
  const topShips = await getTopShips(30);
  if (!topShips.length) {
    await ctx.answerCbQuery("No ships yet! Create one with /newship");
    return;
  }
  const buttons = topShips.map((s, i) => [
    Markup.button.callback(`${i + 1}. ${s.name} [${s.code}] — $${s.shipBalance.toLocaleString()}`, `ship_info_${s.id}`),
  ]);
  buttons.push([Markup.button.callback("◀ Back", "job_pirate")]);
  await ctx.editMessageReplyMarkup({ inline_keyboard: buttons.map((r) => r.map((b) => b)) } as never);
  await ctx.answerCbQuery();
});

bot.action("pirate_make", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("🚢 Use `/newship <ship name>` command to create your own ship!", { parse_mode: "Markdown" });
});

bot.action(/^ship_info_(\d+)$/, async (ctx) => {
  const shipId = Number((ctx.match as RegExpMatchArray)[1]);
  const ship = await db.select().from(ships).where(eq(ships.id, shipId)).limit(1);
  if (!ship[0]) { await ctx.answerCbQuery("Ship not found"); return; }
  const bal = await getShipBalance(shipId);
  const members = await getShipMemberCount(shipId);
  await ctx.answerCbQuery();
  await ctx.reply(
    `⛵ *${ship[0].name}* [${ship[0].code}]\n💰 Balance: $${bal.toLocaleString()}\n👥 Members: ${members}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("⚓ Join Ship", `join_ship_${shipId}`)]]),
    }
  );
});

bot.action(/^join_ship_(\d+)$/, async (ctx) => {
  const u = ctx.from;
  const shipId = Number((ctx.match as RegExpMatchArray)[1]);
  const user = await getOrCreateUser(u.id, u.first_name, u.username);

  if (user.shipId) {
    await ctx.answerCbQuery("❌ You're already in a ship! /leaveship first.");
    return;
  }

  const ship = await db.select().from(ships).where(eq(ships.id, shipId)).limit(1);
  if (!ship[0]) { await ctx.answerCbQuery("Ship not found"); return; }

  await db.update(gameUsers).set({ shipId }).where(eq(gameUsers.telegramId, u.id));
  await db.insert(shipMembers).values({ shipId, userId: u.id, role: "member" });
  await ctx.answerCbQuery(`✅ Joined ${ship[0].name}!`);
  await ctx.reply(`⚓ You've joined ship *${ship[0].name}* [${ship[0].code}]!`, { parse_mode: "Markdown" });
});

// ── Game Commands ──────────────────────────────────────────────────────────────

bot.command("select", async (ctx) => {
  await ctx.reply(
    "⚔️ <b>Select your Job</b>\n\nKoi ek job chuno:",
    {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message.message_id },
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("⚔️ Bounty Hunter", "job_bounty"),
          Markup.button.callback("🏴‍☠️ Become Pirate", "job_pirate"),
        ],
      ]),
    }
  );
});

bot.command("leavejob", async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  if (!user.job) {
    return ctx.reply("❌ Aapne koi job select hi nahi ki hai!", {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  }

  const oldJob = user.job === "bounty_hunter" ? "⚔️ Bounty Hunter" : "🏴‍☠️ Pirate";
  await db.update(gameUsers).set({ job: null }).where(eq(gameUsers.telegramId, ctx.from.id));

  await ctx.reply(`✅ Aapne <b>${oldJob}</b> job leave kar di! /select se naya job chuno.`, {
    parse_mode: "HTML",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

bot.command("bal", async (ctx) => {
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name: string; username?: string } } };
  const target = msg.reply_to_message?.from
    ? await getOrCreateUser(msg.reply_to_message.from.id, msg.reply_to_message.from.first_name, msg.reply_to_message.from.username)
    : await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  const rank = await getGlobalRank(target.telegramId, target.balance);
  const killRank = await getKillRank(target.telegramId);
  const tag = getKillTag(target.kills, killRank);
  const ship = await getUserShip(target.shipId);
  const bestItem = await getMostExpensiveItem(target.telegramId);
  const jobDisplay = target.job === "bounty_hunter" ? "⚔️ Bounty Hunter" : target.job === "pirate" ? "🏴‍☠️ Pirate" : "None";
  const premiumBadge = isPremiumActive(target) ? " ⭐" : "";
  const parsedEmoji = parseStoredEmoji(target.customEmoji ?? null);

  const parts: MsgPart[] = [];

  // ── Prefix emoji ──────────────────────────────────────────────────────────
  if (parsedEmoji?.type === "tg") {
    parts.push({ t: parsedEmoji.char, tgEmoji: parsedEmoji.id });
    parts.push({ t: " " });
  } else if (parsedEmoji?.type === "normal") {
    parts.push({ t: parsedEmoji.emoji + " " });
  } else if (isPremiumActive(target)) {
    parts.push({ t: "💓 " });
  } else {
    parts.push({ t: "👤 " });
  }

  parts.push({ t: "Nᴀᴍᴇ:", bold: true });
  parts.push({ t: ` ${target.firstName}${tag}${premiumBadge}\n` });
  parts.push({ t: "💰 " });
  parts.push({ t: "Bᴀʟᴀɴᴄᴇ:", bold: true });
  parts.push({ t: ` $${target.balance.toLocaleString()}\n` });
  parts.push({ t: "🏆 " });
  parts.push({ t: "Gʟᴏʙᴀʟ Rᴀɴᴋ:", bold: true });
  parts.push({ t: ` #${rank}\n` });
  parts.push({ t: "❤️ " });
  parts.push({ t: "Job:", bold: true });
  parts.push({ t: ` ${jobDisplay}\n` });
  parts.push({ t: "⛵️ " });
  parts.push({ t: "Ship:", bold: true });
  parts.push({ t: ` ${ship ? `${ship.name} [${ship.code}]` : "None"}\n` });
  parts.push({ t: "⚔️ " });
  parts.push({ t: "Kɪʟʟꜱ:", bold: true });
  parts.push({ t: ` ${target.kills}\n` });
  parts.push({ t: "💸 " });
  parts.push({ t: "Bounty:", bold: true });
  parts.push({ t: ` $${target.bountyAmount.toLocaleString()}\n` });
  parts.push({ t: "🎁 " });
  parts.push({ t: "Items:", bold: true });
  parts.push({ t: ` ${bestItem ?? "None"}` });

  const { text, entities } = buildMsg(parts);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ctx.reply(text, {
    entities: entities as any,
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

bot.command("kill", async (ctx) => {
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const target = msg.reply_to_message?.from;
  if (!target) {
    return ctx.reply("❌ Reply karo jise kill karna hai!", { reply_parameters: { message_id: msg.message_id } });
  }
  if (target.id === ctx.from.id) {
    return ctx.reply("❌ Khud ko kill nahi kar sakte 😆", { reply_parameters: { message_id: msg.message_id } });
  }

  const killer = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const victim = await getOrCreateUser(target.id, target.first_name, target.username);

  if (isProtected(victim)) {
    return ctx.reply(`🛡 *${target.first_name}* is protected! Kill nahi kar sakte.`, {
      parse_mode: "Markdown",
      reply_parameters: { message_id: msg.message_id },
    });
  }

  const premium = isPremiumActive(killer);
  const balGain = rand(
    premium ? KILL_BALANCE_MIN_PREMIUM : KILL_BALANCE_MIN_NORMAL,
    premium ? KILL_BALANCE_MAX_PREMIUM : KILL_BALANCE_MAX_NORMAL
  );
  const bountyGain = premium ? BOUNTY_PER_KILL_PREMIUM : BOUNTY_PER_KILL_NORMAL;
  const victimBounty = victim.bountyAmount;
  const totalGain = balGain + victimBounty;

  await db.update(gameUsers).set({
    kills: sql`${gameUsers.kills} + 1`,
    balance: sql`${gameUsers.balance} + ${totalGain}`,
    bountyAmount: sql`${gameUsers.bountyAmount} + ${bountyGain}`,
  }).where(eq(gameUsers.telegramId, killer.telegramId));

  await db.update(gameUsers).set({ bountyAmount: 0 }).where(eq(gameUsers.telegramId, victim.telegramId));

  await ctx.reply(
    `⚔️ *${killer.firstName}* killed *${target.first_name}*!\n` +
    `💰 +$${balGain.toLocaleString()} kill reward\n` +
    (victimBounty > 0 ? `💸 +$${victimBounty.toLocaleString()} bounty claimed\n` : "") +
    `📈 Total gained: $${totalGain.toLocaleString()}\n` +
    `🎯 Bounty +$${bountyGain}`,
    { parse_mode: "Markdown", reply_parameters: { message_id: msg.message_id } }
  );
});

bot.command("rob", async (ctx) => {
  const msg = ctx.message as { text: string; reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const parts = msg.text.split(" ");
  const amount = parseInt(parts[1] ?? "0");
  const target = msg.reply_to_message?.from;

  if (!target || isNaN(amount) || amount <= 0) {
    return ctx.reply("❌ Usage: /rob <amount> (reply to someone)", { reply_parameters: { message_id: msg.message_id } });
  }
  if (target.id === ctx.from.id) {
    return ctx.reply("❌ Khud ko rob nahi kar sakte!", { reply_parameters: { message_id: msg.message_id } });
  }

  const robber = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const victim = await getOrCreateUser(target.id, target.first_name, target.username);

  if (isProtected(victim)) {
    return ctx.reply(`🛡 *${target.first_name}* is protected!`, { parse_mode: "Markdown", reply_parameters: { message_id: msg.message_id } });
  }

  const premium = isPremiumActive(robber);
  const maxRob = premium ? Infinity : ROB_MAX_NORMAL;

  if (!premium && amount > ROB_MAX_NORMAL) {
    return ctx.reply(`❌ Normal user ek baar mein max $${ROB_MAX_NORMAL.toLocaleString()} rob kar sakta hai!`, { reply_parameters: { message_id: msg.message_id } });
  }

  const today = todayDate();
  const robCount = robber.robDate === today ? robber.robCountToday : 0;

  if (!premium && robCount >= ROB_MAX_DAILY_NORMAL) {
    return ctx.reply("❌ Aaj ka rob limit khatam! Kal dobara aana 😅", { reply_parameters: { message_id: msg.message_id } });
  }

  if (victim.balance < amount) {
    return ctx.reply(`❌ ${target.first_name} ke paas sirf $${victim.balance.toLocaleString()} hai!`, { reply_parameters: { message_id: msg.message_id } });
  }

  await db.update(gameUsers).set({
    balance: sql`${gameUsers.balance} + ${amount}`,
    robCountToday: robCount + 1,
    robDate: today,
  }).where(eq(gameUsers.telegramId, robber.telegramId));

  await db.update(gameUsers).set({
    balance: sql`${gameUsers.balance} - ${amount}`,
  }).where(eq(gameUsers.telegramId, victim.telegramId));

  await ctx.reply(
    `🥷 *${robber.firstName}* ne *${target.first_name}* se $${amount.toLocaleString()} rob kiya!`,
    { parse_mode: "Markdown", reply_parameters: { message_id: msg.message_id } }
  );
});

bot.command("protect", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const arg = msg.text.split(" ")[1]?.toLowerCase();

  if (!arg || !["1d", "2d"].includes(arg)) {
    return ctx.reply("❌ Usage: /protect 1d  or  /protect 2d (2d is premium)", { reply_parameters: { message_id: msg.message_id } });
  }

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  if (arg === "2d" && !isPremiumActive(user)) {
    return ctx.reply("❌ 2-day protection sirf premium users ke liye hai!", { reply_parameters: { message_id: msg.message_id } });
  }

  if (isProtected(user)) {
    const remaining = user.protectionUntil!;
    return ctx.reply(`🛡 Aapki protection already active hai — ${remaining.toDateString()} tak`, { reply_parameters: { message_id: msg.message_id } });
  }

  const days = arg === "2d" ? 2 : 1;
  const until = new Date();
  until.setDate(until.getDate() + days);

  await db.update(gameUsers).set({ protectionUntil: until }).where(eq(gameUsers.telegramId, user.telegramId));
  await ctx.reply(`🛡 *${days}-day protection* active! ${until.toDateString()} tak koi rob/kill nahi kar payega.`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

bot.command("check", async (ctx) => {
  const msg = ctx.message as { text: string; reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  if (!isPremiumActive(user)) {
    return ctx.reply("❌ Ye premium command hai! /pay se premium lo.", { reply_parameters: { message_id: msg.message_id } });
  }

  let target: GameUser | null = null;
  if (msg.reply_to_message?.from) {
    target = await getUserById(msg.reply_to_message.from.id);
  } else {
    const arg = msg.text.split(" ")[1];
    if (arg) {
      target = arg.startsWith("@")
        ? await getUserByUsername(arg)
        : await getUserById(parseInt(arg));
    }
  }

  if (!target) {
    return ctx.reply("❌ User nahi mila!", { reply_parameters: { message_id: msg.message_id } });
  }

  const protInfo = isProtected(target)
    ? `🛡 Protected until: ${target.protectionUntil!.toDateString()}`
    : "❌ No protection active";

  try {
    await ctx.telegram.sendMessage(ctx.from.id, `🔍 *${target.firstName}* protection check:\n${protInfo}`, { parse_mode: "Markdown" });
    if (isGroupChat(ctx)) {
      await ctx.reply("✅ Protection timing sent to your DM!", {
        reply_parameters: { message_id: msg.message_id },
        ...Markup.inlineKeyboard([[Markup.button.url("📩 Go to DM", `https://t.me/${BOT_USERNAME}`)]]),
      });
    }
  } catch {
    await ctx.reply(`🔍 *${target.firstName}* protection:\n${protInfo}`, {
      parse_mode: "Markdown",
      reply_parameters: { message_id: msg.message_id },
    });
  }
});

bot.command("setemoji", async (ctx) => {
  const msg = ctx.message as {
    text: string;
    message_id: number;
    entities?: Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }>;
  };
  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  if (!isPremiumActive(user)) {
    return ctx.reply(
      "❌ Ye command sirf 💓 Premium users ke liye hai!\n/pay se premium lo.",
      { reply_parameters: { message_id: msg.message_id } }
    );
  }

  const msgText = msg.text ?? "";
  const entities = msg.entities ?? [];

  // ── Telegram Premium (animated) emoji check ──────────────────────────────
  const customEmojiEntity = entities.find(
    (e) => e.type === "custom_emoji" && e.custom_emoji_id
  );

  if (customEmojiEntity?.custom_emoji_id) {
    let fallbackChar: string;
    try {
      fallbackChar = msgText.substring(
        customEmojiEntity.offset,
        customEmojiEntity.offset + customEmojiEntity.length
      );
    } catch {
      fallbackChar = "⭐";
    }

    const storedEmoji = `<tg-emoji emoji-id="${customEmojiEntity.custom_emoji_id}">${escapeHtml(fallbackChar)}</tg-emoji>`;
    await db.update(gameUsers).set({ customEmoji: storedEmoji }).where(eq(gameUsers.telegramId, ctx.from.id));

    const preview = storedEmoji;
    return ctx.reply(
      `✅ Tumhara prefix ab ye Telegram Premium emoji hai! ${preview}\n\n<i>Doosron ko /bal mein animated emoji dikhega! ✨</i>`,
      { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } }
    );
  }

  // ── Normal emoji check ───────────────────────────────────────────────────
  const args = msgText.replace(/\/setemoji/i, "").replace(`@${BOT_USERNAME}`, "").trim();

  if (!args) {
    return ctx.reply(
      "❌ Usage:\n/setemoji 😎\nya Telegram Premium emoji send karo.",
      { reply_parameters: { message_id: msg.message_id } }
    );
  }

  const normalEmoji = [...args][0] ?? args;
  await db.update(gameUsers).set({ customEmoji: normalEmoji }).where(eq(gameUsers.telegramId, ctx.from.id));
  return ctx.reply(
    `✅ Tumhara prefix emoji ab ye hai: ${normalEmoji}`,
    { reply_parameters: { message_id: msg.message_id } }
  );
});

bot.command("daily", async (ctx) => {
  if (isGroupChat(ctx)) {
    return ctx.reply("❌ /daily sirf bot DM mein use karo!", {
      reply_parameters: { message_id: ctx.message.message_id },
      ...Markup.inlineKeyboard([[Markup.button.url("📩 Go to DM", `https://t.me/${BOT_USERNAME}`)]]),
    });
  }

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const today = todayDate();
  const lastDaily = user.dailyLast ? user.dailyLast.toISOString().split("T")[0] : null;

  if (lastDaily === today) {
    return ctx.reply("❌ Aaj ka daily already liya hua hai! Kal 12AM ke baad dobara aana 😊", {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  }

  const premium = isPremiumActive(user);
  const reward = premium ? DAILY_BALANCE_PREMIUM : DAILY_BALANCE_NORMAL;

  await db.update(gameUsers).set({
    balance: sql`${gameUsers.balance} + ${reward}`,
    dailyLast: new Date(),
  }).where(eq(gameUsers.telegramId, user.telegramId));

  await ctx.reply(
    `🎁 Daily reward collected!\n💰 +$${reward.toLocaleString()} added to your balance${premium ? " (Premium bonus!)" : ""}`,
    { reply_parameters: { message_id: ctx.message.message_id } }
  );
});

// ── Items ──────────────────────────────────────────────────────────────────────

bot.command("items", async (ctx) => {
  const itemList = ITEMS.map((i) => `${i.emoji} ${i.name} — $${i.price.toLocaleString()}`).join("\n");
  await ctx.reply(
    `👨‍💻 Aᴠᴀɪʟᴀʙʟᴇ Iᴛᴇᴍꜱ ⚡️\n\n${itemList}\n\n/purchase <item name> se kharidein`,
    { reply_parameters: { message_id: ctx.message.message_id } }
  );
});

bot.command("item", async (ctx) => {
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const target = msg.reply_to_message?.from
    ? await getUserById(msg.reply_to_message.from.id)
    : await getUserById(ctx.from.id);

  if (!target) return ctx.reply("❌ User nahi mila!");
  const owned = await getUserItems(target.telegramId);
  const display = owned.length
    ? ITEMS.filter((i) => owned.includes(i.name)).map((i) => `${i.emoji} ${i.name}`).join("\n")
    : "Koi item nahi";

  await ctx.reply(`🎒 *${target.firstName}* ke items:\n${display}`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

bot.command("purchase", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const itemName = msg.text.replace("/purchase", "").replace(`@${BOT_USERNAME}`, "").trim().toLowerCase();
  const item = ITEMS.find((i) => i.name === itemName);

  if (!item) {
    return ctx.reply(`❌ Item nahi mila! /items se list dekho.`, { reply_parameters: { message_id: msg.message_id } });
  }

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const owned = await getUserItems(user.telegramId);

  if (owned.includes(item.name)) {
    return ctx.reply(`❌ Ye item pehle se aapke paas hai!`, { reply_parameters: { message_id: msg.message_id } });
  }

  if (user.balance < item.price) {
    return ctx.reply(`❌ Balance insufficient! Need $${item.price.toLocaleString()}, you have $${user.balance.toLocaleString()}`, { reply_parameters: { message_id: msg.message_id } });
  }

  await db.update(gameUsers).set({ balance: sql`${gameUsers.balance} - ${item.price}` }).where(eq(gameUsers.telegramId, user.telegramId));
  await db.insert(userItems).values({ userId: user.telegramId, itemName: item.name });

  await ctx.reply(`✅ *${item.emoji} ${item.name}* purchased for $${item.price.toLocaleString()}!`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

bot.command("gift", async (ctx) => {
  const msg = ctx.message as { text: string; reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const itemName = msg.text.replace("/gift", "").replace(`@${BOT_USERNAME}`, "").trim().toLowerCase();
  const target = msg.reply_to_message?.from;

  if (!target || !itemName) {
    return ctx.reply("❌ Usage: /gift <item name> (reply to someone)", { reply_parameters: { message_id: msg.message_id } });
  }

  const item = ITEMS.find((i) => i.name === itemName);
  if (!item) return ctx.reply("❌ Item nahi mila! /items se list dekho.", { reply_parameters: { message_id: msg.message_id } });

  const sender = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const ownedItems = await getUserItems(sender.telegramId);

  if (!ownedItems.includes(item.name)) {
    return ctx.reply("❌ Ye item aapke paas nahi hai!", { reply_parameters: { message_id: msg.message_id } });
  }

  const receiver = await getOrCreateUser(target.id, target.first_name, target.username);
  const receiverItems = await getUserItems(receiver.telegramId);

  if (receiverItems.includes(item.name)) {
    return ctx.reply("❌ Target ke paas ye item pehle se hai!", { reply_parameters: { message_id: msg.message_id } });
  }

  await db.delete(userItems).where(and(eq(userItems.userId, sender.telegramId), eq(userItems.itemName, item.name)));
  await db.insert(userItems).values({ userId: receiver.telegramId, itemName: item.name });

  await ctx.reply(`🎁 *${sender.firstName}* ne *${target.first_name}* ko *${item.emoji} ${item.name}* gift kiya!`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

// ── Pay ────────────────────────────────────────────────────────────────────────

bot.command("pay", async (ctx) => {
  await ctx.reply(
    "💎 <b>Premium Purchase</b>\n\nPremium lene ke liye owner se contact karo:",
    {
      parse_mode: "HTML",
      reply_parameters: { message_id: ctx.message.message_id },
      ...Markup.inlineKeyboard([[Markup.button.url("💬 Ask from Owner @light_speedy", "https://t.me/light_speedy")]]),
    }
  );
});

// ── Codes ──────────────────────────────────────────────────────────────────────

bot.command("redeem", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const code = msg.text.split(" ")[1]?.trim().toUpperCase();
  if (!code) return ctx.reply("❌ Usage: /redeem <code>", { reply_parameters: { message_id: msg.message_id } });

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const amount = await redeemBalanceCode(code);
  if (!amount) return ctx.reply("❌ Invalid or already used code!", { reply_parameters: { message_id: msg.message_id } });

  await db.update(gameUsers).set({ balance: sql`${gameUsers.balance} + ${amount}` }).where(eq(gameUsers.telegramId, user.telegramId));
  await ctx.reply(`✅ Code redeemed! +$${amount.toLocaleString()} added to your balance 💰`, { reply_parameters: { message_id: msg.message_id } });
});

bot.command("redbounty", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const code = msg.text.split(" ")[1]?.trim().toUpperCase();
  if (!code) return ctx.reply("❌ Usage: /redbounty <code>", { reply_parameters: { message_id: msg.message_id } });

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const amount = await redeemBountyCode(code);
  if (!amount) return ctx.reply("❌ Invalid or already used code!", { reply_parameters: { message_id: msg.message_id } });

  await db.update(gameUsers).set({ bountyAmount: sql`${gameUsers.bountyAmount} + ${amount}` }).where(eq(gameUsers.telegramId, user.telegramId));
  await ctx.reply(`✅ Bounty code redeemed! +$${amount.toLocaleString()} bounty added 💸`, { reply_parameters: { message_id: msg.message_id } });
});

// ── Leaderboards ───────────────────────────────────────────────────────────────

bot.command("toprich", async (ctx) => {
  const top = await getTopRich(10);
  const list = top.map((u, i) => {
    const emojiHtml = buildEmojiHtml(u);
    return `${i + 1}. ${emojiHtml}${escapeHtml(u.firstName)} — $${u.balance.toLocaleString()}`;
  }).join("\n");
  await ctx.reply(`💰 <b>Top 10 Richest</b>\n\n${list || "No data yet"}`, {
    parse_mode: "HTML",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

bot.command("topkills", async (ctx) => {
  const top = await getTopKillers(10);
  const list = top.map((u, i) => {
    const killRank = i + 1;
    const tag = getKillTag(u.kills, killRank);
    const emojiHtml = buildEmojiHtml(u);
    return `${i + 1}. ${emojiHtml}${escapeHtml(u.firstName)}${escapeHtml(tag)} — ${u.kills} kills`;
  });
  await ctx.reply(`⚔️ <b>Top 10 Killers</b>\n\n${list.join("\n") || "No data yet"}`, {
    parse_mode: "HTML",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

bot.command("topbounty", async (ctx) => {
  const top = await getTopBounty(10);
  const list = top.map((u, i) => {
    const emojiHtml = buildEmojiHtml(u);
    return `${i + 1}. ${emojiHtml}${escapeHtml(u.firstName)} — $${u.bountyAmount.toLocaleString()}`;
  }).join("\n");
  await ctx.reply(`💸 <b>Top 10 Bounty</b>\n\n${list || "No data yet"}`, {
    parse_mode: "HTML",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

bot.command("topships", async (ctx) => {
  const top = await getTopShips(20);
  const list = top.map((s, i) => `${i + 1}. ${s.name} [${s.code}] — $${s.shipBalance.toLocaleString()} (${s.memberCount} members)`).join("\n");
  await ctx.reply(`⛵ *Top 20 Ships*\n\n${list || "No ships yet"}`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

// ── Ship Commands ──────────────────────────────────────────────────────────────

bot.command("newship", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const name = msg.text.replace("/newship", "").replace(`@${BOT_USERNAME}`, "").trim();
  if (!name) return ctx.reply("❌ Usage: /newship <ship name>", { reply_parameters: { message_id: msg.message_id } });

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  if (user.shipId) return ctx.reply("❌ Aap pehle se ek ship mein ho! /leaveship karo pehle.", { reply_parameters: { message_id: msg.message_id } });

  const existing = await getShipByName(name);
  if (existing) return ctx.reply("❌ Ye naam pehle se liya hua hai! Alag naam chuno.", { reply_parameters: { message_id: msg.message_id } });

  const code = await generateUniqueShipCode();
  const [newShip] = await db.insert(ships).values({ name, code, captainId: ctx.from.id }).returning();
  await db.update(gameUsers).set({ shipId: newShip.id }).where(eq(gameUsers.telegramId, ctx.from.id));
  await db.insert(shipMembers).values({ shipId: newShip.id, userId: ctx.from.id, role: "captain" });

  const link = `https://t.me/${BOT_USERNAME}?start=join_${code}`;
  await ctx.reply(
    `🚢 *Ship Created!*\n\n⛵ Name: *${name}*\n🔑 Code: \`${code}\`\n🔗 Invite Link: ${link}\n\nShare this link to invite members!`,
    { parse_mode: "Markdown", reply_parameters: { message_id: msg.message_id } }
  );
});

bot.command("ship", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const arg = msg.text.replace(/\/ship/i, "").replace(`@${BOT_USERNAME}`, "").trim();

  let ship = null;
  if (!arg) {
    const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    if (user.shipId) ship = await getUserShip(user.shipId);
    if (!ship) return ctx.reply("❌ Aap kisi ship mein nahi ho! Pehle /newship ya /joinship karo.", { reply_parameters: { message_id: msg.message_id } });
  } else if (/^\d{4}$/.test(arg)) {
    ship = await getShipByCode(arg);
  } else if (arg.includes("join_")) {
    const code = arg.split("join_")[1]!;
    ship = await getShipByCode(code);
  } else {
    ship = await getShipByName(arg);
  }

  if (!ship) return ctx.reply("❌ Ship nahi mili! Code ya naam check karo.", { reply_parameters: { message_id: msg.message_id } });

  const [bal, memberCount, members] = await Promise.all([
    getShipBalance(ship.id),
    getShipMemberCount(ship.id),
    db.select({ userId: shipMembers.userId, role: shipMembers.role }).from(shipMembers).where(eq(shipMembers.shipId, ship.id)),
  ]);

  const memberDetails = await Promise.all(members.map(async (m) => {
    const u = await getUserById(m.userId);
    const roleEmoji =
      m.role === "captain" ? "👑" :
      m.role === "vice_captain" ? "⚓" :
      m.role === "navigator" ? "🧭" :
      m.role === "officer" ? "⚔️" : "🏴‍☠️";
    return `${roleEmoji} ${escapeHtml(u?.firstName ?? "Unknown")} <i>(${m.role.replace("_", " ")})</i>`;
  }));

  const link = `https://t.me/${BOT_USERNAME}?start=join_${ship.code}`;
  const text =
    `⛵ <b>${escapeHtml(ship.name)}</b>\n` +
    `🔑 <b>Code:</b> <code>${escapeHtml(ship.code)}</code>\n` +
    `💰 <b>Balance:</b> $${bal.toLocaleString()}\n` +
    `👥 <b>Members:</b> ${memberCount}\n\n` +
    (memberDetails.length ? memberDetails.join("\n") + "\n\n" : "") +
    `🔗 <b>Join Link:</b> ${link}`;

  await ctx.reply(text, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
});

bot.command("leaveship", async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  if (!user.shipId) return ctx.reply("❌ Aap kisi ship mein nahi ho!", { reply_parameters: { message_id: ctx.message.message_id } });

  const ship = await getUserShip(user.shipId);
  await db.delete(shipMembers).where(and(eq(shipMembers.shipId, user.shipId), eq(shipMembers.userId, ctx.from.id)));
  await db.update(gameUsers).set({ shipId: null }).where(eq(gameUsers.telegramId, ctx.from.id));

  await ctx.reply(`🚪 Aap *${ship?.name ?? "ship"}* se leave ho gaye.`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

async function appointRole(ctx: Context, role: string) {
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Appoint karne ke liye reply karo!", { reply_parameters: { message_id: msg.message_id } });

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  if (!user.shipId) return ctx.reply("❌ Aap kisi ship mein nahi ho!", { reply_parameters: { message_id: msg.message_id } });

  const myRole = await getShipMemberRole(user.shipId, ctx.from.id);
  const canAppoint = ["captain", "vice_captain", "navigator"].includes(myRole ?? "");
  if (!canAppoint) return ctx.reply("❌ Sirf captain, vice captain ya navigator appoint kar sakte hain!", { reply_parameters: { message_id: msg.message_id } });

  const targetMember = await getShipMemberRole(user.shipId, target.id);
  if (!targetMember) return ctx.reply("❌ Ye banda aapki ship mein nahi hai!", { reply_parameters: { message_id: msg.message_id } });

  await db.update(shipMembers).set({ role }).where(and(eq(shipMembers.shipId, user.shipId), eq(shipMembers.userId, target.id)));
  await ctx.reply(`✅ *${target.first_name}* ko *${role.replace("_", " ")}* banaya gaya!`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
}

bot.command("appointvicecaptain", (ctx) => appointRole(ctx, "vice_captain"));
bot.command("appointnavigator", (ctx) => appointRole(ctx, "navigator"));
bot.command("appointofficer", (ctx) => appointRole(ctx, "officer"));

bot.command("transferleadership", async (ctx) => {
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Reply karo jise captain banana hai!", { reply_parameters: { message_id: msg.message_id } });

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  if (!user.shipId) return ctx.reply("❌ Aap kisi ship mein nahi ho!", { reply_parameters: { message_id: msg.message_id } });

  const myRole = await getShipMemberRole(user.shipId, ctx.from.id);
  if (myRole !== "captain") return ctx.reply("❌ Sirf captain leadership transfer kar sakta hai!", { reply_parameters: { message_id: msg.message_id } });

  const targetRole = await getShipMemberRole(user.shipId, target.id);
  if (!targetRole) return ctx.reply("❌ Ye banda aapki ship mein nahi hai!", { reply_parameters: { message_id: msg.message_id } });

  await db.update(shipMembers).set({ role: "member" }).where(and(eq(shipMembers.shipId, user.shipId), eq(shipMembers.userId, ctx.from.id)));
  await db.update(shipMembers).set({ role: "captain" }).where(and(eq(shipMembers.shipId, user.shipId), eq(shipMembers.userId, target.id)));
  await db.update(ships).set({ captainId: target.id }).where(eq(ships.id, user.shipId));

  await ctx.reply(`⚓ Leadership transferred! *${target.first_name}* is the new Captain!`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

// ── Admin Commands ─────────────────────────────────────────────────────────────

bot.command("givepremium", async (ctx) => {
  if (!isOwner(ctx.from.username)) return ctx.reply("❌ Owner only command!", { reply_parameters: { message_id: ctx.message.message_id } });
  const msg = ctx.message as { text: string; reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const days = parseInt(msg.text.split(" ")[1] ?? "0");
  const target = msg.reply_to_message?.from;
  if (!target || isNaN(days) || days <= 0) return ctx.reply("❌ Usage: /givepremium <days> (reply to user)", { reply_parameters: { message_id: msg.message_id } });

  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  await db.update(gameUsers).set({ premium: true, premiumExpires: expires }).where(eq(gameUsers.telegramId, target.id));
  await ctx.reply(`✅ *${target.first_name}* ko ${days} day premium diya gaya! (Until ${expires.toDateString()})`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

bot.command("cancelpremium", async (ctx) => {
  if (!isOwner(ctx.from.username)) return ctx.reply("❌ Owner only command!", { reply_parameters: { message_id: ctx.message.message_id } });
  const msg = ctx.message as { reply_to_message?: { from?: { id: number; first_name: string; username?: string } }; message_id: number };
  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Reply karo jiska premium cancel karna hai!", { reply_parameters: { message_id: msg.message_id } });

  await db.update(gameUsers).set({ premium: false, premiumExpires: null }).where(eq(gameUsers.telegramId, target.id));
  await ctx.reply(`✅ *${target.first_name}* ka premium cancel kiya gaya.`, { parse_mode: "Markdown", reply_parameters: { message_id: msg.message_id } });
});

bot.command("setbal", async (ctx) => {
  if (!isOwner(ctx.from.username)) return ctx.reply("❌ Owner only command!", { reply_parameters: { message_id: ctx.message.message_id } });
  const msg = ctx.message as { text: string; message_id: number };
  const amount = parseInt(msg.text.split(" ")[1] ?? "");
  if (isNaN(amount)) return ctx.reply("❌ Usage: /setbal <amount>", { reply_parameters: { message_id: msg.message_id } });

  await db.update(gameUsers).set({ balance: amount }).where(eq(gameUsers.telegramId, ctx.from.id));
  await ctx.reply(`✅ Balance set to $${amount.toLocaleString()}`, { reply_parameters: { message_id: msg.message_id } });
});

bot.command("gen", async (ctx) => {
  if (!isOwner(ctx.from.username)) return ctx.reply("❌ Owner only command!", { reply_parameters: { message_id: ctx.message.message_id } });
  const msg = ctx.message as { text: string; message_id: number };
  const amount = parseInt(msg.text.split(" ")[1] ?? "");
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Usage: /gen <amount>", { reply_parameters: { message_id: msg.message_id } });

  const code = await generateBalanceCode(amount);
  await ctx.reply(`✅ Balance code generated:\n\`${code}\`\n\nAmount: $${amount.toLocaleString()}\nUse: /redeem ${code}`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

bot.command("bounty", async (ctx) => {
  if (!isOwner(ctx.from.username)) return ctx.reply("❌ Owner only command!", { reply_parameters: { message_id: ctx.message.message_id } });
  const msg = ctx.message as { text: string; message_id: number };
  const amount = parseInt(msg.text.split(" ")[1] ?? "");
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Usage: /bounty <amount>", { reply_parameters: { message_id: msg.message_id } });

  const code = await generateBountyCode(amount);
  await ctx.reply(`✅ Bounty code generated:\n\`${code}\`\n\nAmount: $${amount.toLocaleString()}\nUse: /redbounty ${code}`, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: msg.message_id },
  });
});

// ── Help ───────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  const helpText = `
📖 *Nami Bot — Command List*

*👤 Profile*
/bal — Balance & stats check
/daily — Daily $2000 reward (DM only)
/select — Job select karo (Bounty Hunter / Pirate)
/leavejob — Current job leave karo

*⚔️ Combat*
/kill — Kill someone (reply)
/rob <amount> — Rob someone (reply)
/protect 1d/2d — Protection (2d = premium)

*🏆 Leaderboards*
/toprich — Top 10 richest
/topkills — Top 10 killers
/topbounty — Top 10 bounty
/topships — Top 20 ships

*🎒 Items*
/items — View available items
/item — Check someone's items (reply)
/purchase <item name> — Buy item
/gift <item name> — Gift item (reply)

*⛵ Ships*
/newship <name> — Create ship
/joinship <code> — Join ship by code
/ship <code/name> — Ship info
/leaveship — Leave your ship
/appointvicecaptain — Appoint vice captain (reply)
/appointnavigator — Appoint navigator (reply)
/appointofficer — Appoint officer (reply)
/transferleadership — Transfer captain (reply)

*💰 Codes*
/redeem <code> — Redeem balance code
/redbounty <code> — Redeem bounty code

*💎 Premium*
/pay — Buy premium (DM only)
/check — Check protection (premium, reply)
/setemoji <emoji> — Name ke aage emoji lagao (normal=free, animated=premium)

*🛡 Group Management*
/promote 1/2/3 — Promote user (reply) [admin]
/demote — Demote user (reply) [admin]
/pin — Pin message (reply) [admin]
/warn — Warn user, 5 warns = ban (reply) [admin]
/unwarn — Remove a warn (reply) [admin]
/mute — Mute user (reply) [admin]
/unmute — Unmute user (reply) [admin]
/kick — Kick user (reply) [admin]
/promoteme 1/2/3 — Self promote [owner only]

*👑 Owner Only*
/givepremium <days> — Give premium (reply)
/cancelpremium — Cancel premium (reply)
/setbal <amount> — Set balance
/gen <amount> — Generate balance code
/bounty <amount> — Generate bounty code
`.trim();

  await ctx.reply(helpText, {
    parse_mode: "Markdown",
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

// ── /joinship command ──────────────────────────────────────────────────────────

bot.command("joinship", async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const code = msg.text.replace("/joinship", "").replace(`@${BOT_USERNAME}`, "").trim();

  if (!code || code.length !== 4 || !/^\d{4}$/.test(code)) {
    return ctx.reply("❌ Usage: /joinship <4-digit code>\nExample: /joinship 1234", {
      reply_parameters: { message_id: msg.message_id },
    });
  }

  const user = await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  if (user.shipId) {
    return ctx.reply("❌ Aap pehle se ek ship mein ho! /leaveship karo pehle.", {
      reply_parameters: { message_id: msg.message_id },
    });
  }

  const ship = await getShipByCode(code);
  if (!ship) {
    return ctx.reply("❌ Ye code kisi ship ka nahi hai! Code dobara check karo.", {
      reply_parameters: { message_id: msg.message_id },
    });
  }

  await db.update(gameUsers).set({ shipId: ship.id }).where(eq(gameUsers.telegramId, ctx.from.id));
  await db.insert(shipMembers).values({ shipId: ship.id, userId: ctx.from.id, role: "member" });

  const bal = await getShipBalance(ship.id);
  const members = await getShipMemberCount(ship.id);

  await ctx.reply(
    `⚓ *${ctx.from.first_name}* joined ship *${ship.name}* [${ship.code}]!\n💰 Ship Balance: $${bal.toLocaleString()}\n👥 Members: ${members}`,
    { parse_mode: "Markdown", reply_parameters: { message_id: msg.message_id } }
  );
});

// ── Group Management ───────────────────────────────────────────────────────────

const PROMOTE_RIGHTS: Record<number, {
  can_manage_chat: boolean; can_change_info: boolean; can_delete_messages: boolean;
  can_manage_video_chats: boolean; can_invite_users: boolean; can_pin_messages: boolean;
  can_restrict_members: boolean; can_promote_members: boolean; can_be_anonymous: boolean;
}> = {
  1: { can_manage_chat: true, can_change_info: true, can_delete_messages: true, can_manage_video_chats: true, can_invite_users: true, can_pin_messages: true, can_restrict_members: false, can_promote_members: false, can_be_anonymous: false },
  2: { can_manage_chat: true, can_change_info: true, can_delete_messages: true, can_manage_video_chats: true, can_invite_users: true, can_pin_messages: true, can_restrict_members: true, can_promote_members: false, can_be_anonymous: false },
  3: { can_manage_chat: true, can_change_info: true, can_delete_messages: true, can_manage_video_chats: true, can_invite_users: true, can_pin_messages: true, can_restrict_members: true, can_promote_members: true, can_be_anonymous: false },
};

const PROMOTE_MSG: Record<number, string> = {
  1: "⭐ Level 1 Promoted",
  2: "🌟 Level 2 Promoted",
  3: "👑 Promoted Full Rights",
};

type AdminMember = { status: string; can_promote_members?: boolean; can_restrict_members?: boolean; can_pin_messages?: boolean };

async function checkGroupPerm(ctx: Context, perm: "promote" | "restrict" | "pin"): Promise<boolean> {
  if (!isGroupChat(ctx) || !ctx.from || !ctx.chat) return false;
  if (isOwner(ctx.from.username)) return true;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id) as AdminMember;
    if (m.status === "creator") return true;
    if (m.status === "administrator") {
      if (perm === "promote") return m.can_promote_members === true;
      if (perm === "restrict") return m.can_restrict_members === true;
      if (perm === "pin") return m.can_pin_messages === true;
    }
  } catch { /* ignore */ }
  return false;
}

bot.command("promote", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { text: string; message_id: number; reply_to_message?: { from?: { id: number; first_name: string; username?: string } } };
  if (!await checkGroupPerm(ctx, "promote"))
    return ctx.reply("❌ Tumhare paas promote karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko promote karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });

  const level = parseInt(msg.text.replace(/\/promote/i, "").replace(`@${BOT_USERNAME}`, "").trim());
  if (![1, 2, 3].includes(level))
    return ctx.reply("❌ Level 1, 2, ya 3 dalo!\nExample: /promote 2 (reply karke)", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.promoteChatMember(ctx.chat!.id, target.id, PROMOTE_RIGHTS[level]!);
    await ctx.reply(`✅ <b>${escapeHtml(target.first_name)}</b> — ${PROMOTE_MSG[level]!}`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Promote nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("demote", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { from?: { id: number; first_name: string } } };
  if (!await checkGroupPerm(ctx, "promote"))
    return ctx.reply("❌ Tumhare paas demote karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko demote karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.promoteChatMember(ctx.chat!.id, target.id, { can_manage_chat: false, can_change_info: false, can_delete_messages: false, can_manage_video_chats: false, can_invite_users: false, can_pin_messages: false, can_restrict_members: false, can_promote_members: false, can_be_anonymous: false });
    await ctx.reply(`⬇️ <b>${escapeHtml(target.first_name)}</b> ko demote kar diya gaya!`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Demote nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("pin", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { message_id: number } };
  if (!await checkGroupPerm(ctx, "pin"))
    return ctx.reply("❌ Tumhare paas pin karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });
  if (!msg.reply_to_message?.message_id)
    return ctx.reply("❌ Jo message pin karna hai usse reply karo!", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.pinChatMessage(ctx.chat!.id, msg.reply_to_message.message_id);
    await ctx.reply("📌 Message pin ho gaya!", { reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Pin nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("warn", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { from?: { id: number; first_name: string; username?: string } } };
  if (!await checkGroupPerm(ctx, "restrict"))
    return ctx.reply("❌ Tumhare paas warn karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko warn karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });
  if (isOwner(target.username)) return ctx.reply("❌ Bot owner ko warn nahi kar sakte!", { reply_parameters: { message_id: msg.message_id } });

  const groupId = ctx.chat!.id;
  const warnCount = await addWarn(groupId, target.id);

  if (warnCount >= 5) {
    try {
      await ctx.telegram.banChatMember(groupId, target.id);
      await resetWarns(groupId, target.id);
      await ctx.reply(`🔨 <b>${escapeHtml(target.first_name)}</b> ko 5/5 warns ke baad <b>ban</b> kar diya gaya!`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
    } catch (err) {
      await ctx.reply(`⚠️ 5/5 warns! Ban failed: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
    }
  } else {
    await ctx.reply(`⚠️ <b>${escapeHtml(target.first_name)}</b> ko warn mila!\nWarns: <b>${warnCount}/5</b> — ${5 - warnCount} aur milenge toh ban!`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("unwarn", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { from?: { id: number; first_name: string } } };
  if (!await checkGroupPerm(ctx, "restrict"))
    return ctx.reply("❌ Tumhare paas unwarn karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko unwarn karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });

  const warnCount = await removeWarn(ctx.chat!.id, target.id);
  await ctx.reply(`✅ <b>${escapeHtml(target.first_name)}</b> ka ek warn hata diya! Ab warns: <b>${warnCount}/5</b>`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
});

bot.command("mute", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { from?: { id: number; first_name: string; username?: string } } };
  if (!await checkGroupPerm(ctx, "restrict"))
    return ctx.reply("❌ Tumhare paas mute karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko mute karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });
  if (isOwner(target.username)) return ctx.reply("❌ Bot owner ko mute nahi kar sakte!", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.restrictChatMember(ctx.chat!.id, target.id, { permissions: { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false } });
    await ctx.reply(`🔇 <b>${escapeHtml(target.first_name)}</b> muted! /unmute se wapas de sakte ho.`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Mute nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("unmute", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { from?: { id: number; first_name: string } } };
  if (!await checkGroupPerm(ctx, "restrict"))
    return ctx.reply("❌ Tumhare paas unmute karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko unmute karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.restrictChatMember(ctx.chat!.id, target.id, { permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true, can_change_info: false, can_invite_users: true, can_pin_messages: false } });
    await ctx.reply(`🔊 <b>${escapeHtml(target.first_name)}</b> unmuted!`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Unmute nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("kick", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  const msg = ctx.message as { message_id: number; reply_to_message?: { from?: { id: number; first_name: string; username?: string } } };
  if (!await checkGroupPerm(ctx, "restrict"))
    return ctx.reply("❌ Tumhare paas kick karne ke rights nahi hain!", { reply_parameters: { message_id: msg.message_id } });

  const target = msg.reply_to_message?.from;
  if (!target) return ctx.reply("❌ Jis bande ko kick karna hai uske message ko reply karo!", { reply_parameters: { message_id: msg.message_id } });
  if (isOwner(target.username)) return ctx.reply("❌ Bot owner ko kick nahi kar sakte!", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.banChatMember(ctx.chat!.id, target.id);
    await ctx.telegram.unbanChatMember(ctx.chat!.id, target.id);
    await ctx.reply(`👟 <b>${escapeHtml(target.first_name)}</b> kick ho gaya! (Wapas join kar sakta hai)`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Kick nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

bot.command("promoteme", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("❌ Ye command sirf groups mein kaam karta hai.");
  if (!isOwner(ctx.from?.username)) return;
  const msg = ctx.message as { text: string; message_id: number };
  const level = parseInt(msg.text.replace(/\/promoteme/i, "").replace(`@${BOT_USERNAME}`, "").trim());
  if (![1, 2, 3].includes(level))
    return ctx.reply("❌ Level 1, 2, ya 3 dalo! Example: /promoteme 3", { reply_parameters: { message_id: msg.message_id } });

  try {
    await ctx.telegram.promoteChatMember(ctx.chat!.id, ctx.from!.id, PROMOTE_RIGHTS[level]!);
    await ctx.reply(`✅ Khud ko promote kar liya — ${PROMOTE_MSG[level]!} 👑`, { parse_mode: "HTML", reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    await ctx.reply(`❌ Promote nahi ho saka: ${(err as { message?: string }).message ?? "error"}`, { reply_parameters: { message_id: msg.message_id } });
  }
});

// ── Sticker handler ────────────────────────────────────────────────────────────

bot.on(message("sticker"), async (ctx) => {
  if (isGroupChat(ctx) && !shouldRespondInGroup(ctx)) return;

  const sticker = getRandomSticker();
  if (sticker) {
    await ctx.replyWithSticker(sticker, {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  } else {
    await ctx.reply("😄", { reply_parameters: { message_id: ctx.message.message_id } });
  }
});

// ── Photo / Voice / Other media ────────────────────────────────────────────────

bot.on(message("photo"), async (ctx) => {
  if (isGroupChat(ctx) && !shouldRespondInGroup(ctx)) return;
  const replies = ["Wow kya photo hai! 😍", "Nice pic! 🔥", "Sahi hai yaar! 😄", "Waah waah! 👌"];
  await ctx.reply(replies[Math.floor(Math.random() * replies.length)], {
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

bot.on(message("voice"), async (ctx) => {
  if (isGroupChat(ctx) && !shouldRespondInGroup(ctx)) return;
  await ctx.reply("Bhai voice note sun nahi sakta, text mein likhoge? 😅", {
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

// ── Text / AI handler ──────────────────────────────────────────────────────────

bot.on(message("text"), async (ctx) => {
  const msg = ctx.message as { text: string; message_id: number };
  const text = msg.text;

  if (text.startsWith("/")) return;
  if (isGroupChat(ctx) && !shouldRespondInGroup(ctx)) return;

  const userId = ctx.from.id;
  await getOrCreateUser(userId, ctx.from.first_name, ctx.from.username);

  if (!convHistory.has(userId)) convHistory.set(userId, []);
  const history = convHistory.get(userId)!;
  history.push({ role: "user", content: text });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    await ctx.sendChatAction("typing");
    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 400,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    });

    const reply = response.choices[0]?.message?.content;
    if (!reply) return;
    history.push({ role: "assistant", content: reply });

    await ctx.reply(reply, { reply_parameters: { message_id: msg.message_id } });
  } catch (err) {
    logger.error({ err }, "AI error");
    await ctx.reply("Thodi si problem aa gayi, ek second ruko! 😬", {
      reply_parameters: { message_id: msg.message_id },
    });
  }
});

// ── Bot launch ─────────────────────────────────────────────────────────────────

export function startTelegramBot() {
  loadStickerPacks().catch((err) => logger.error({ err }, "Sticker load error"));

  bot.catch((err: unknown) => {
    const e = err as { message?: string; response?: { error_code?: number } };
    const code = e?.response?.error_code;
    if (code === 400 || code === 403 || code === 429) {
      logger.warn({ msg: e?.message, code }, "Telegram API error (non-fatal)");
    } else {
      logger.error({ err }, "Bot handler error");
    }
  });

  function launchBot() {
    bot.launch().catch((err: unknown) => {
      logger.error({ err }, "Bot stopped — restarting in 5s...");
      setTimeout(launchBot, 5000);
    });
  }

  launchBot();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  logger.info("Nami bot starting (long polling)...");
}

const telegramRouter = Router();

telegramRouter.get("/telegram/status", (_req, res) => {
  res.json({ status: "running", bot: "Nami (@nami_ibot)" });
});

export default telegramRouter;
