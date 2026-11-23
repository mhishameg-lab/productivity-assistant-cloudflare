import { mkdir, writeFile } from "node:fs/promises";

const output = new URL("../preview/", import.meta.url);
await mkdir(output, { recursive: true });

const name = "Mohamed";
const text = [
  `Your week, ${name}`,
  "Nov 16 – Nov 22, 2026",
  "",
  "You completed 8 tasks and kept 4 of 5 planned days on plan.",
  "Completed: 8",
  "Open: 12",
  "Overdue: 3",
  "Postponed: 2"
].join("\n");
const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head><body style="margin:0;background:#f5f7fa;color:#1f2933;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><table role="presentation" width="600" style="max-width:600px;width:100%;margin:auto"><tr><td style="padding:24px;background:#edf3ff"><h1>Your week, ${name}</h1><p>Nov 16 – Nov 22, 2026</p></td></tr><tr><td style="padding:16px"><p>You completed 8 tasks and kept 4 of 5 planned days on plan.</p><table role="presentation" width="100%" cellpadding="8"><tr><td align="center">Completed<br><b>8</b></td><td align="center">Open<br><b>12</b></td><td align="center">Overdue<br><b>3</b></td><td align="center">Postponed<br><b>2</b></td></tr></table><h2>Wins</h2><ul><li>Completed two HVAC study sessions</li></ul><h2>Needs attention</h2><ul><li>One repeated postponement</li></ul><h2>Next week</h2><ul><li>Finish the portfolio outline · suggestions, not Calendar bookings</li></ul></td></tr></table></body></html>`;

await Promise.all([
  writeFile(new URL("weekly.txt", output), text),
  writeFile(new URL("weekly.html", output), html)
]);
console.log("Wrote fake email previews to cloudflare/preview/");
