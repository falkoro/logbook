// Fills an empty LOGBOOK_DATA (default ./data) with a made-up coffee roaster, so `bun run demo` has something to show.
// The human is dev@localhost, the DEV_AUTH login, so its inbox holds the open decisions.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureActor } from "../src/auth/auth";
import { disk } from "../src/blobs/disk";
import type { Actor } from "../src/core/ctx";
import { OPS } from "../src/core/ops";
import { runOp } from "../src/core/registry";
import { first, q } from "../src/db/db";
import { sqlite } from "../src/db/sqlite";

const data = resolve(process.env.LOGBOOK_DATA ?? "data");
mkdirSync(join(data, "files"), { recursive: true });
const db = sqlite(join(data, "logbook.sqlite"));
const blobs = disk(join(data, "files"));
if (await first(db, q("SELECT 1 FROM teams"))) {
  console.log(`${data} already has a workspace; leaving it alone`);
  process.exit(0);
}

// Every write lands half an hour after the previous one, starting 17 hours ago, so the log reads like a real day.
let clock = Date.now() - 17 * 3_600_000;
const as = (actor: Actor) => (name: string, input: unknown = {}) => {
  clock += 30 * 60_000;
  return runOp(OPS, name, { db, blobs, actor, now: new Date(clock).toISOString() }, input) as Promise<any>;
};
const you = as(await ensureActor(db, "human", "dev", "dev@localhost"));
const claude = as(await ensureActor(db, "agent", "claude", null));
const codex = as(await ensureActor(db, "agent", "codex", null));

await you("save_team", { key: "SHOP", name: "Webshop" });
await you("save_team", { key: "APP", name: "Order app" });
await you("save_team", { key: "WEB", name: "Website" });
for (const [name, color] of [["Bug", "#eb5757"], ["Feature", "#bb87fc"], ["Improvement", "#4ea7fc"]]) await you("save_issue_label", { name, color });

// Shipped: a release goes live and closes what it carries.
await claude("save_issue", { team: "SHOP", title: "Pause a subscription for one delivery", labels: ["Feature"], priority: 2, assignee: "claude", release: "2.3.0" });
await claude("save_issue", { team: "SHOP", title: "Show the roast date on product pages", labels: ["Improvement"], priority: 3, assignee: "claude", release: "2.3.0" });
await claude("save_issue", { team: "SHOP", title: "Cart count stays at 1 after removing the last item", labels: ["Bug"], priority: 2, assignee: "claude", release: "2.3.0" });
await codex("save_issue", { team: "APP", title: "Loyalty stamps on the home screen", labels: ["Feature"], priority: 2, assignee: "codex", release: "1.8.0" });
await codex("save_issue", { team: "APP", title: "Dark mode", labels: ["Feature"], priority: 3, assignee: "codex", release: "1.8.0" });
await claude("set_release_status", { release: "2.3.0", team: "SHOP", status: "live" });
await codex("set_release_status", { release: "1.8.0", team: "APP", status: "live" });

// In flight.
const coupon = await claude("save_issue", {
  team: "SHOP",
  title: "Checkout applies a discount code twice",
  description: "Applying the same code again takes the percentage off the already discounted subtotal.",
  labels: ["Bug"],
  priority: 1,
  state: "In Progress",
  assignee: "claude",
});
await claude("save_comment", {
  issueId: coupon.id,
  body: "Reproduced. The second apply runs on the discounted subtotal instead of refusing the code. Fixing it in the cart service, with a test for stacked codes.",
});
await claude("link_pr", { issue: coupon.id, provider: "github", repo: "example/shop", number: 142, url: "https://github.com/example/shop/pull/142", title: "Refuse a discount code that is already applied", state: "open" });
await claude("save_issue", { id: coupon.id, state: "In Review", release: "2.3.1" });
await claude("set_release_status", { release: "2.3.1", team: "SHOP", status: "staging" });
const gift = await claude("save_issue", { team: "SHOP", title: "Gift cards", labels: ["Feature"], priority: 3, release: "2.4.0" });
await claude("save_issue", { team: "SHOP", title: "Ship to a pickup point", labels: ["Feature"], priority: 4, release: "2.4.0" });

const slots = await codex("save_issue", { team: "APP", title: "Order ahead: pick a pickup time", labels: ["Feature"], priority: 2, state: "In Progress", assignee: "codex" });
await codex("save_comment", { issueId: slots.id, body: "Slots come from the opening hours, every 15 minutes, and close 10 minutes before each slot. The staging build has it." });
await codex("save_issue", { team: "APP", title: "Notify when the order is ready", labels: ["Feature"], priority: 3, state: "Todo" });
await codex("save_issue", { team: "APP", title: "Crash on Android 15 when the camera permission is denied", labels: ["Bug"], priority: 1, state: "Triage" });

const hours = await claude("save_issue", { team: "WEB", title: "Opening hours come from one place", labels: ["Improvement"], priority: 3, state: "Todo" });
await claude("save_issue", { team: "WEB", title: "Menu page scores 72 on Lighthouse", labels: ["Improvement"], priority: 4, state: "Backlog" });

// Waiting on you.
const menu = await claude("ask_decision", { issue: hours.id, question: "Keep the menu as a PDF download next to the HTML page?", options: ["Keep the PDF", "HTML only"], recommendation: "HTML only: the PDF is always a week behind." });
await you("answer_decision", { id: menu.id, answer: "HTML only." });
await claude("ask_decision", {
  issue: gift.id,
  question: "Sell gift cards as a product with fixed amounts, or as a separate page where the buyer picks any amount?",
  options: ["Product with €25, €50 and €100", "Separate page, any amount"],
  recommendation: "Fixed amounts: it reuses the cart and checkout, and almost every gift card sold in a shop like this is one of those three.",
});
await codex("ask_decision", { issue: slots.id, kind: "review", question: "The pickup-time picker is on the staging build. Does a 15-minute grid feel right?" });

console.log(`demo workspace written to ${data}`);
