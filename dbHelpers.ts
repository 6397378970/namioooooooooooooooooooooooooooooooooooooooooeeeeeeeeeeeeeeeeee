import { db, gameUsers, ships, shipMembers, userItems, balanceCodes, bountyCodes, groupWarns } from "@workspace/db";
import { eq, desc, sql, and, not, inArray } from "drizzle-orm";
import { ITEMS } from "./constants.js";

export type GameUser = typeof gameUsers.$inferSelect;
export type Ship = typeof ships.$inferSelect;
export type ShipMember = typeof shipMembers.$inferSelect;

export async function getOrCreateUser(
  telegramId: number,
  firstName: string,
  username?: string | null
): Promise<GameUser> {
  const existing = await db
    .select()
    .from(gameUsers)
    .where(eq(gameUsers.telegramId, telegramId))
    .limit(1);

  if (existing[0]) {
    const isOwnerUser = username ? ["light_speedy", "light_speedi"].includes(username.toLowerCase()) : false;
    const needsPremiumUpgrade = isOwnerUser && !existing[0].premium;
    const updates: Partial<typeof existing[0]> = {};
    if (existing[0].firstName !== firstName) updates.firstName = firstName;
    if (existing[0].username !== (username ?? null)) updates.username = username ?? null;
    if (needsPremiumUpgrade) { updates.premium = true; updates.premiumExpires = null; }
    if (Object.keys(updates).length > 0) {
      await db.update(gameUsers).set(updates).where(eq(gameUsers.telegramId, telegramId));
      return { ...existing[0], ...updates };
    }
    return existing[0];
  }

  const isOwner = username ? ["light_speedy", "light_speedi"].includes(username.toLowerCase()) : false;

  await db.insert(gameUsers).values({
    telegramId,
    firstName,
    username: username ?? null,
    balance: 1000,
    kills: 0,
    bountyAmount: 0,
    premium: isOwner,
    premiumExpires: null,
  });

  const [user] = await db
    .select()
    .from(gameUsers)
    .where(eq(gameUsers.telegramId, telegramId))
    .limit(1);
  return user;
}

export async function getUserById(telegramId: number): Promise<GameUser | null> {
  const [user] = await db
    .select()
    .from(gameUsers)
    .where(eq(gameUsers.telegramId, telegramId))
    .limit(1);
  return user ?? null;
}

export async function getUserByUsername(username: string): Promise<GameUser | null> {
  const [user] = await db
    .select()
    .from(gameUsers)
    .where(eq(gameUsers.username, username.replace("@", "")))
    .limit(1);
  return user ?? null;
}

export function isPremiumActive(user: GameUser): boolean {
  if (!user.premium) return false;
  if (!user.premiumExpires) return true;
  return user.premiumExpires > new Date();
}

export function isProtected(user: GameUser): boolean {
  if (!user.protectionUntil) return false;
  return user.protectionUntil > new Date();
}

export async function getGlobalRank(telegramId: number, balance: number): Promise<number> {
  const result = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(gameUsers)
    .where(sql`${gameUsers.balance} > ${balance}`);
  return Number(result[0]?.cnt ?? 0) + 1;
}

export async function getKillRank(telegramId: number): Promise<number> {
  const user = await getUserById(telegramId);
  if (!user) return 9999;
  const result = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(gameUsers)
    .where(sql`${gameUsers.kills} > ${user.kills}`);
  return Number(result[0]?.cnt ?? 0) + 1;
}

export function getKillTag(kills: number, killRank: number): string {
  if (kills >= 200 && killRank <= 7) return " [𝗪𝗮𝗿𝗹𝗼𝗿𝗱 𝗼𝗳 𝗦𝗲𝗮]";
  if (kills >= 100 && kills < 200 && killRank <= 30) return " [𝗦𝘄𝗼𝗿𝗱𝘀𝗺𝗮𝗻]";
  return "";
}

export async function getUserShip(shipId: number | null): Promise<Ship | null> {
  if (!shipId) return null;
  const [ship] = await db.select().from(ships).where(eq(ships.id, shipId)).limit(1);
  return ship ?? null;
}

export async function getShipBalance(shipId: number): Promise<number> {
  const result = await db
    .select({ total: sql<number>`coalesce(sum(${gameUsers.balance}), 0)` })
    .from(shipMembers)
    .innerJoin(gameUsers, eq(shipMembers.userId, gameUsers.telegramId))
    .where(eq(shipMembers.shipId, shipId));
  return Number(result[0]?.total ?? 0);
}

export async function getShipMemberCount(shipId: number): Promise<number> {
  const result = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(shipMembers)
    .where(eq(shipMembers.shipId, shipId));
  return Number(result[0]?.cnt ?? 0);
}

export async function getShipMemberRole(shipId: number, userId: number): Promise<string | null> {
  const [member] = await db
    .select()
    .from(shipMembers)
    .where(and(eq(shipMembers.shipId, shipId), eq(shipMembers.userId, userId)))
    .limit(1);
  return member?.role ?? null;
}

export async function getShipByCode(code: string): Promise<Ship | null> {
  const [ship] = await db.select().from(ships).where(eq(ships.code, code)).limit(1);
  return ship ?? null;
}

export async function getShipByName(name: string): Promise<Ship | null> {
  const [ship] = await db
    .select()
    .from(ships)
    .where(sql`lower(${ships.name}) = lower(${name})`)
    .limit(1);
  return ship ?? null;
}

export async function getTopShips(limit = 30): Promise<Array<Ship & { shipBalance: number; memberCount: number }>> {
  const allShips = await db.select().from(ships);
  const withBalances = await Promise.all(
    allShips.map(async (ship) => ({
      ...ship,
      shipBalance: await getShipBalance(ship.id),
      memberCount: await getShipMemberCount(ship.id),
    }))
  );
  return withBalances.sort((a, b) => b.shipBalance - a.shipBalance).slice(0, limit);
}

export async function generateUniqueShipCode(): Promise<string> {
  while (true) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const existing = await getShipByCode(code);
    if (!existing) return code;
  }
}

export async function getUserItems(userId: number): Promise<string[]> {
  const rows = await db
    .select({ itemName: userItems.itemName })
    .from(userItems)
    .where(eq(userItems.userId, userId));
  return rows.map((r) => r.itemName);
}

export async function getMostExpensiveItem(userId: number): Promise<string | null> {
  const ownedItems = await getUserItems(userId);
  if (!ownedItems.length) return null;
  const sorted = ITEMS.filter((i) => ownedItems.includes(i.name)).sort((a, b) => b.price - a.price);
  return sorted[0]
    ? `${sorted[0].emoji} ${sorted[0].name} ($${sorted[0].price.toLocaleString()})`
    : null;
}

export async function getTopRich(limit = 10): Promise<GameUser[]> {
  return db.select().from(gameUsers).orderBy(desc(gameUsers.balance)).limit(limit);
}

export async function getTopKillers(limit = 10): Promise<GameUser[]> {
  return db.select().from(gameUsers).orderBy(desc(gameUsers.kills)).limit(limit);
}

export async function getTopBounty(limit = 10): Promise<GameUser[]> {
  return db.select().from(gameUsers).orderBy(desc(gameUsers.bountyAmount)).limit(limit);
}

export async function generateBalanceCode(amount: number): Promise<string> {
  const code = "BAL-" + Math.random().toString(36).substring(2, 10).toUpperCase();
  await db.insert(balanceCodes).values({ code, amount, redeemed: false });
  return code;
}

export async function redeemBalanceCode(code: string): Promise<number | null> {
  const [row] = await db.select().from(balanceCodes).where(eq(balanceCodes.code, code)).limit(1);
  if (!row || row.redeemed) return null;
  await db.update(balanceCodes).set({ redeemed: true }).where(eq(balanceCodes.code, code));
  return row.amount;
}

export async function generateBountyCode(amount: number): Promise<string> {
  const code = "BNT-" + Math.random().toString(36).substring(2, 10).toUpperCase();
  await db.insert(bountyCodes).values({ code, amount, redeemed: false });
  return code;
}

export async function redeemBountyCode(code: string): Promise<number | null> {
  const [row] = await db.select().from(bountyCodes).where(eq(bountyCodes.code, code)).limit(1);
  if (!row || row.redeemed) return null;
  await db.update(bountyCodes).set({ redeemed: true }).where(eq(bountyCodes.code, code));
  return row.amount;
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function getWarnCount(groupId: number, userId: number): Promise<number> {
  const [row] = await db.select().from(groupWarns)
    .where(and(eq(groupWarns.groupId, groupId), eq(groupWarns.userId, userId))).limit(1);
  return row?.warnCount ?? 0;
}

export async function addWarn(groupId: number, userId: number): Promise<number> {
  const [existing] = await db.select().from(groupWarns)
    .where(and(eq(groupWarns.groupId, groupId), eq(groupWarns.userId, userId))).limit(1);
  if (existing) {
    const newCount = existing.warnCount + 1;
    await db.update(groupWarns).set({ warnCount: newCount })
      .where(and(eq(groupWarns.groupId, groupId), eq(groupWarns.userId, userId)));
    return newCount;
  }
  await db.insert(groupWarns).values({ groupId, userId, warnCount: 1 });
  return 1;
}

export async function removeWarn(groupId: number, userId: number): Promise<number> {
  const [existing] = await db.select().from(groupWarns)
    .where(and(eq(groupWarns.groupId, groupId), eq(groupWarns.userId, userId))).limit(1);
  if (!existing || existing.warnCount <= 0) return 0;
  const newCount = Math.max(0, existing.warnCount - 1);
  await db.update(groupWarns).set({ warnCount: newCount })
    .where(and(eq(groupWarns.groupId, groupId), eq(groupWarns.userId, userId)));
  return newCount;
}

export async function resetWarns(groupId: number, userId: number): Promise<void> {
  await db.delete(groupWarns)
    .where(and(eq(groupWarns.groupId, groupId), eq(groupWarns.userId, userId)));
}
