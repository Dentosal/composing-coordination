// End-to-end smoke test: two browsers play a 2-round game, with a round voted down and played again.
// Run: deno run -A tests/e2e/smoke.ts [baseUrl]   (server must be running; CHROME_PATH may point at a Chrome binary)
// Screenshots go to $SHOTS (default /tmp).
import { chromium } from "npm:playwright@1.56.1";

const base = Deno.args[0] ?? "http://localhost:3055";
const shots = Deno.env.get("SHOTS") ?? "/tmp";
const browser = await chromium.launch({ executablePath: Deno.env.get("CHROME_PATH"), args: ["--autoplay-policy=no-user-gesture-required"] });
const log = (m: string) => console.log("•", m);
const fail = (m: string): never => { throw new Error(m); };

async function page() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  p.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE", m.text()); });
  return p;
}

// The header's main button: Ready / Unready while writing, Vote (n / m) during a vote.
const mainButton = (p: any) => p.locator(".topbar button.primary").filter({ hasText: /^(Ready|Unready|Vote|Rendering|You join)/ });

// ---- create, join, start
const host = await page();
await host.goto(base);
await host.fill("input[name=nick]", "Host");
await host.fill("input[name=rounds]", "2");
await host.fill("input[name=attempts]", "1"); // round 1 gets one more: a vote after round 1, none after round 2
await host.click("text=Create session");
await host.waitForSelector("text=Lobby");
const invite = await host.inputValue(".invite input");
log("invite " + invite);

const guest = await page();
await guest.goto(invite);
await guest.fill("input[name=nick]", "Guest");
await guest.click("text=Take a seat");
await guest.waitForSelector("text=Lobby");
await host.waitForFunction(() => document.querySelector(".lobby strong")?.textContent === "2");
const names = await host.locator(".lobby .player-list li").allInnerTexts();
if (!names.some((n) => n.includes("Guest"))) fail("the lobby does not list the guest: " + names.join(", "));
await host.click("text=Start session");

// ---- round 1: both write something and get ready
async function write(p: any, name: string, preset: string, notes: string[]) {
  await p.waitForSelector("text=Round 1");
  await p.click('.roll-label[data-lane="0"] strong'); // selects track 1; its patch is shown in the instrument panel
  await p.click("text=Load preset");
  await p.click(`.preset-item >> text=${preset}`); // labels are capitalised; text= matches case-insensitively
  await p.click('.roll-label[data-lane="0"] strong');
  for (const k of notes) await p.keyboard.press(k);
  await p.screenshot({ path: `${shots}/${name}-editing.png` });
}
async function ready(p: any) {
  await mainButton(p).click();
  await p.waitForFunction(() => [...document.querySelectorAll(".topbar button.primary")].some((b) => b.textContent === "Unready")
    || !!document.querySelector("dialog.round-dialog"));
}
await Promise.all([
  write(host, "host", "kick", ["z", "z", "z", "z"]),
  write(guest, "guest", "bass", ["z", "1", "x", "1"]),
]);
await Promise.all([ready(host), ready(guest)]);
log("both ready");

// ---- the round dialog: the song so far and the vote
async function vote(p: any, keep: boolean) {
  const dlg = p.locator("dialog.round-dialog");
  await dlg.locator(".vote-buttons").waitFor({ timeout: 60000 });
  await dlg.getByRole("button", { name: keep ? /Keep it/ : /Play it again/ }).click();
}
async function closeDialog(p: any) {
  await p.locator("dialog.round-dialog .round-close button").click();
}
await host.locator("dialog.round-dialog h2", { hasText: "Round 1 done (attempt 1 of 2)" }).waitFor({ timeout: 60000 });
await host.locator("dialog.round-dialog .song-play").click(); // the song so far streams in the browser
await host.waitForTimeout(1500);
const time = await host.locator("dialog.round-dialog .song-time").innerText();
if (time.startsWith("0:00 /")) fail("the song so far does not play: " + time);
await host.locator("dialog.round-dialog .song-play").click();
await vote(host, false); // voted down: round 1 again
await vote(guest, true);
await host.locator("dialog.round-dialog .vote-result", { hasText: "round 1 again" }).waitFor({ timeout: 15000 });
await Promise.all([closeDialog(host), closeDialog(guest)]);
await host.waitForSelector("text=Round 1 / 2 · attempt 2 / 2");
log("round 1 voted down, attempt 2 open");

// ---- round 1 again: its last attempt, kept without a vote
await Promise.all([ready(host), ready(guest)]);
await host.locator("dialog.round-dialog .round-vote", { hasText: "last attempt" }).waitFor({ timeout: 60000 });
await guest.locator("dialog.round-dialog h2", { hasText: "attempt 2 of 2" }).waitFor({ timeout: 60000 });
await Promise.all([closeDialog(host), closeDialog(guest)]);
await host.waitForSelector("text=Round 2 / 2");
log("round 1 kept, round 2 open");

// ---- round 2: the band plays under the draft
await host.locator(".listen-mode button.active", { hasText: "Band + my part" }).waitFor({ timeout: 30000 });
await host.click(".bottombar button.primary"); // Play
await host.waitForTimeout(1500);
const lit = await host.locator(".roll-cell.play").count(); // one lit cell per track in the playing column
if (lit < 1) fail("playhead not shown: " + lit);
await host.screenshot({ path: `${shots}/host-round2.png` });
await host.click(".bottombar button.primary"); // Stop

// ---- the last round has one attempt: no vote, the game ends
await Promise.all([ready(host), ready(guest)]);
await host.locator("dialog.round-dialog h2", { hasText: "Game over" }).waitFor({ timeout: 60000 });
const song = host.locator("dialog.round-dialog .round-downloads button", { hasText: "Song (.wav)" });
await song.waitFor({ timeout: 120000 });
await host.waitForFunction(() => [...document.querySelectorAll("dialog.round-dialog .round-downloads button")]
  .some((b) => b.textContent?.includes("Song (.wav)") && !(b as HTMLButtonElement).disabled), null, { timeout: 120000 });
const [download] = await Promise.all([host.waitForEvent("download"), host.locator("dialog.round-dialog .round-downloads button", { hasText: "Scene file" }).click()]);
const scene = JSON.parse(await Deno.readTextFile(await download.path()));
if (scene.config.bars !== 8) fail("the game's scene is not two rounds of 4 bars: " + scene.config.bars);
await host.screenshot({ path: `${shots}/host-game-over.png` });
await closeDialog(host);
await host.waitForSelector("text=Session ended");
await host.waitForSelector("audio");
log("game over, song and scene ready; OK");
await browser.close();
