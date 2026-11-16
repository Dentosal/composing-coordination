import { chromium } from "npm:playwright@1.56.1";
const b = await chromium.launch({ executablePath: Deno.env.get("CHROME_PATH") });
const p = await (await b.newContext()).newPage();
p.on("pageerror", (e) => console.error("PAGEERROR", e.message));
await p.goto(Deno.args[0]);
await p.waitForFunction(() => document.getElementById("out")!.textContent!.includes("done"), null, { timeout: 90000 });
console.log(await p.textContent("#out"));
await b.close();
