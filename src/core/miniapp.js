export async function validateTelegramInitData(initData, botToken, authorizedUserId) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join("\n");
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secretDigest = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
  const secretKeyFromDigest = await crypto.subtle.importKey(
    "raw",
    secretDigest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    secretKeyFromDigest,
    encoder.encode(dataCheckString)
  );
  const actual = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqual(actual, hash.toLowerCase())) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > 24 * 60 * 60) return null;
  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
  if (!user || String(user.id) !== String(authorizedUserId)) return null;
  return user;
}

export function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function miniAppResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export function planPageHtml(name) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
:root{color-scheme:light dark;--pad:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}main{padding:var(--pad);max-width:680px;margin:auto}.card{background:var(--tg-theme-secondary-bg-color,#f5f5f5);border-radius:12px;padding:14px;margin:10px 0}.card input,.card select{width:100%;min-height:44px;box-sizing:border-box}button,.chip{min-height:44px}label{display:block;margin-top:8px}.error{color:#b00020}.chips{display:flex;gap:8px}.chips button{flex:1}
</style></head><body><main><h1>Plan your day, ${escapeHtml(name)}</h1><form id="plan">
${areaCard("DEEP", "🌱 Growth")}${areaCard("WORK", "💼 Work")}${areaCard("LIFE", "🏠 Life")}
<label>What could derail this day?</label><input name="risk">
<button id="save" type="submit">Save</button><p id="error" class="error"></p></form></main><script>
const tg=window.Telegram&&Telegram.WebApp;tg&&tg.ready();tg&&tg.MainButton.setText("Save");
async function submit(){const d=new FormData(plan);const initData=tg?tg.initData:"";const r=await fetch("/app/api/plan",{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Init-Data":initData},body:JSON.stringify({requestId:crypto.randomUUID(),mode:new URLSearchParams(location.search).get("mode")||"today",growth:d.get("DEEP"),work:d.get("WORK"),life:d.get("LIFE"),risk:d.get("risk")})});const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn't save");tg&&tg.HapticFeedback&&tg.HapticFeedback.notificationOccurred("success");tg&&tg.close();}
plan.onsubmit=e=>{e.prevent();submit().catch(e=>error.textContent=e.message)};
tg&&tg.MainButton.onClick(()=>submit().catch(e=>error.textContent=e.message));
</script></body></html>`;
}

export function addTaskPageHtml(name) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://telegram.org/js/telegram-web-app.js"></script><style>
:root{color-scheme:light dark;--pad:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}main{padding:var(--pad);max-width:680px;margin:auto}input,select{width:100%;min-height:44px;box-sizing:border-box}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{min-width:44px;padding:8px}.error{color:#b00020}button{min-height:44px}</style></head><body><main><h1>Add a task, ${escapeHtml(name)}</h1><form id="task">
<label>Title</label><input name="title" required><label>Area</label><select name="area"><option value="WORK">💼 Work</option><option value="DEEP">🌱 Growth</option><option value="LIFE">🏠 Life</option><option value="Admin">📎 Errands</option><option value="Other">⋯ Other</option></select>
<label>Priority</label><select name="priority"><option>Medium</option><option>High</option><option>Low</option></select><label>Due</label><select name="due"><option value="">No deadline</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option></select><label>What counts as done?</label><input name="doneTest"><button type="submit">Save</button><p id="error" class="error"></p></form></main><script>
const tg=window.Telegram&&Telegram.WebApp;tg&&tg.ready();tg&&tg.MainButton.setText("Save");
async function submit(){const d=new FormData(task);const r=await fetch("/app/api/task",{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Init-Data":tg?tg.initData:""},body:JSON.stringify({requestId:crypto.randomUUID(),title:d.get("title"),area:d.get("area"),priority:d.get("priority"),due:d.get("due"),doneTest:d.get("doneTest")})});const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn't save");tg&&tg.HapticFeedback&&tg.HapticFeedback.notificationOccurred("success");tg&&tg.close();}
task.onsubmit=e=>{e.prevent();submit().catch(e=>error.textContent=e.message)};tg&&tg.MainButton.onClick(()=>submit().catch(e=>error.textContent=e.message));
</script></body></html>`;
}

function areaCard(area, label) {
  return `<section class="card"><label>${label}</label><input name="${area}" placeholder="One outcome"><label><input type="checkbox" name="${area}_link"> Link a pending task</label><div class="chips"><span>Auto</span><span>25</span><span>50</span></div></section>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
