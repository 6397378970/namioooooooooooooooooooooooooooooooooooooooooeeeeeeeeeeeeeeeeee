export const OWNER_USERNAMES = ["light_speedy", "light_speedi"];
export const BOT_USERNAME = "nami_ibot";
export const GROUP_LINK = "https://t.me/+em6PdzD7hB83Zjc1";

export const ITEMS = [
  { name: "grandline map", emoji: "🗺", price: 20000 },
  { name: "gum gum fruit", emoji: "🍈", price: 50000 },
  { name: "zoro katana", emoji: "⚔️", price: 150000 },
  { name: "ghost ship", emoji: "⛵️", price: 200000 },
  { name: "shanks hat", emoji: "👒", price: 500000 },
] as const;

export type ItemName = (typeof ITEMS)[number]["name"];

export const STICKER_PACK_NAMES = [
  "catsunicmass",
  "HANGSEED_Cat",
  "Clipze",
  "kang_6644255517video_by_Sticker_kang_robot",
  "Abstract_Amethyst_Egret_by_fStikBot",
];

export const NAMI_PHOTO_PATH = "/home/runner/workspace/artifacts/api-server/nami.jpg";

export const BOUNTY_PER_KILL_NORMAL = 200;
export const BOUNTY_PER_KILL_PREMIUM = 400;
export const KILL_BALANCE_MIN_NORMAL = 300;
export const KILL_BALANCE_MAX_NORMAL = 400;
export const KILL_BALANCE_MIN_PREMIUM = 700;
export const KILL_BALANCE_MAX_PREMIUM = 800;
export const DAILY_BALANCE_NORMAL = 2000;
export const DAILY_BALANCE_PREMIUM = 5000;
export const ROB_MAX_NORMAL = 10000;
export const ROB_MAX_DAILY_NORMAL = 200;
