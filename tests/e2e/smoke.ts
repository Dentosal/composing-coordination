// End-to-end smoke test: two browsers play a 2-round session.
// Run: deno run -A tests/e2e/smoke.ts [baseUrl]   (server must be running)
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

const host = await page();
await host.goto(base);
await host.fill('input[name=rounds]', "2");
await host.click("text=Create session");
await host.waitForSelector("text=Lobby");
const invite = await host.inputValue(".invite input");
log("invite " + invite);

const guest = await page();
await guest.goto(invite);
await guest.click("text=Take a seat");
await guest.waitForSelector("text=Lobby");
await host.waitForFunction(() => document.querySelector(".lobby strong")?.textContent === "2");
await host.click("text=Start session");

async function play(p: any, name: string, preset: string, notes: string[]) {
  await p.waitForSelector("text=Round 1");
  await p.click(".cell >> nth=0"); // selects track 1; its patch is shown in the instrument panel
  await p.click("text=Load preset");
  await p.click(`.preset-item >> text=${preset}`); // labels are capitalised; text= matches case-insensitively
  await p.click(".cell >> nth=0");
  for (const k of notes) await p.keyboard.press(k);
  await p.screenshot({ path: `${shots}/${name}-editing.png` });
  await p.click("text=Commit & ready");
  await p.waitForSelector("text=Ready.");
}
await Promise.all([
  play(host, "host", "kick", ["z", "z", "z", "z"]),
  play(guest, "guest", "bass", ["z", "1", "x", "1"]),
]);
log("both committed");
await host.waitForSelector("text=Round 2", { timeout: 60000 });
await host.waitForFunction(() => document.body.innerText.includes("round 1"), null, { timeout: 30000 });
log("round 2 open, mix 1 loaded");
await host.click("text=Play mix");
await host.waitForTimeout(1500);
const row = await host.locator(".grid-row.play").count();
if (row !== 1) fail("playhead not shown: " + row);
await host.screenshot({ path: `${shots}/host-round2.png` });

await Promise.all([host.click("text=Commit & ready"), guest.click("text=Commit & ready")]);
await host.waitForSelector("text=Session ended", { timeout: 60000 });
await host.waitForSelector("audio", { timeout: 120000 });
await host.screenshot({ path: `${shots}/host-end.png` });
log("song ready; OK");
await browser.close();
