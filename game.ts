import {
  pgTable,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  serial,
  char,
  date,
} from "drizzle-orm/pg-core";

export const gameUsers = pgTable("game_users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name").notNull(),
  balance: integer("balance").notNull().default(1000),
  kills: integer("kills").notNull().default(0),
  bountyAmount: integer("bounty_amount").notNull().default(0),
  job: text("job"),
  premium: boolean("premium").notNull().default(false),
  premiumExpires: timestamp("premium_expires"),
  shipId: integer("ship_id"),
  protectionUntil: timestamp("protection_until"),
  customEmoji: text("custom_emoji"),
  dailyLast: timestamp("daily_last"),
  robCountToday: integer("rob_count_today").notNull().default(0),
  robDate: date("rob_date"),
});

export const ships = pgTable("ships", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  code: char("code", { length: 4 }).notNull().unique(),
  captainId: bigint("captain_id", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const shipMembers = pgTable("ship_members", {
  id: serial("id").primaryKey(),
  shipId: integer("ship_id").notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  role: text("role").notNull().default("member"),
});

export const userItems = pgTable("user_items", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  itemName: text("item_name").notNull(),
  purchasedAt: timestamp("purchased_at").notNull().defaultNow(),
});

export const balanceCodes = pgTable("balance_codes", {
  code: text("code").primaryKey(),
  amount: integer("amount").notNull(),
  redeemed: boolean("redeemed").notNull().default(false),
});

export const bountyCodes = pgTable("bounty_codes", {
  code: text("code").primaryKey(),
  amount: integer("amount").notNull(),
  redeemed: boolean("redeemed").notNull().default(false),
});

export const groupWarns = pgTable("group_warns", {
  id: serial("id").primaryKey(),
  groupId: bigint("group_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  warnCount: integer("warn_count").notNull().default(0),
});
