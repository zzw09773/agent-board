// Read-only web view of the board and task table, behind the owner password.
// Session: random token in an HttpOnly, Secure, SameSite=Strict cookie; stored hashed, 12 h TTL.
import { sha, rand, checkPassword, clientIp } from "./oauth.js";
const TTL = 12 * 3600e3, COOKIE = "board_session";
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const SEC = { "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" };
const html = (b) => new Response(`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>board</title><link rel=stylesheet href=/board/app.css>${b}`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SEC } });

export function initWeb(sql) { sql.exec("CREATE TABLE IF NOT EXISTS web_sessions(h TEXT PRIMARY KEY, exp INTEGER)"); }

async function session(self, req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  if (!m) return false;
  const r = self.sql.exec("SELECT exp FROM web_sessions WHERE h=?", await sha(m[1])).toArray()[0];
  return !!(r && r.exp > Date.now());
}
const cookie = (v, age) => `${COOKIE}=${v}; Path=/board; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;

const CSS = `body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1d1d1b}@media(prefers-color-scheme:dark){body{background:#161614;color:#ecebe6}.card{background:#1f1f1d!important;border-color:#33322e!important}}
header{position:sticky;top:0;background:inherit;border-bottom:1px solid #8884;padding:10px 14px;display:flex;gap:8px;align-items:center}header h1{font-size:17px;margin:0;flex:1}
button,input,select{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;cursor:pointer}button[aria-selected=true]{background:#2f5d50;color:#fff}
main{max-width:820px;margin:0 auto;padding:12px;display:grid;gap:10px}.card{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:10px 14px}
.meta{font-size:13px;opacity:.7;display:flex;gap:6px;flex-wrap:wrap}.body{white-space:pre-wrap;word-break:break-word;margin-top:4px}.login{max-width:360px;margin:15vh auto;display:grid;gap:10px;padding:0 16px}.e{color:#b3261e}.st{font-size:12px;border:1px solid #8886;border-radius:99px;padding:0 8px}`;
const JS = `const $=s=>document.querySelector(s),m=$("#list");let tab="board";
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
async function load(){const r=await fetch("/board/api/"+(tab==="board"?"messages":"tasks"),{credentials:"same-origin"});if(r.status===401)return location.reload();const j=await r.json();m.replaceChildren();
 if(tab==="board"){for(const x of j.messages){const c=el("div","card"),h=el("div","meta");h.append(el("b",null,"#"+x.id),el("span",null,x.from+" → "+x.to),el("span",null,new Date(x.created_at).toLocaleString()));c.append(h,el("div","body",x.text));m.append(c)}}
 else{if(j.mainline_lock)m.append(el("div","card","Mainline lock: "+j.mainline_lock.id+" ("+j.mainline_lock.owner+")"));for(const t of j.tasks){const c=el("div","card"),h=el("div","meta");h.append(el("b",null,t.id),el("span","st",t.status),el("span",null,"owner "+(t.owner||"-")+" · next "+(t.next_owner||"-")+" · reviewer "+(t.reviewer||"-")));c.append(h,el("div","body",t.title+(t.description?"\\n"+t.description:"")));m.append(c)}}
 if(!m.children.length)m.append(el("p",null,"Nothing yet."))}
for(const b of document.querySelectorAll("[data-tab]"))b.onclick=()=>{tab=b.dataset.tab;for(const o of document.querySelectorAll("[data-tab]"))o.setAttribute("aria-selected",o===b);load()};
$("#out").onclick=async()=>{await fetch("/board/logout",{method:"POST",credentials:"same-origin"});location.reload()};load();setInterval(load,15000);`;

export async function handleWeb(self, cfg, req, base) {
  const p = new URL(req.url).pathname;
  if (p !== "/board" && !p.startsWith("/board/")) return null;
  if (!self.env.OWNER_PASSWORD) return json({ error: "web_ui_disabled", hint: "set OWNER_PASSWORD" }, 404);
  if (p === "/board/app.css") return new Response(CSS, { headers: { "content-type": "text/css", ...SEC } });
  if (p === "/board/app.js") return new Response(JS, { headers: { "content-type": "text/javascript", ...SEC } });
  if (p === "/board/login" && req.method === "POST") {
    // Exact match against the configured origin (PUBLIC_BASE_URL, else the request's own origin).
    if ((req.headers.get("origin") || "") !== new URL(base).origin) { await req.arrayBuffer().catch(() => {}); return json({ error: "bad_origin" }, 403); }
    const f = await req.formData(), r = checkPassword(self, f.get("password"), clientIp(req));
    if (r !== "ok") return new Response(null, { status: 303, headers: { location: "/board?e=" + r } });
    const t = rand();
    self.sql.exec("DELETE FROM web_sessions WHERE exp<?", Date.now());
    self.sql.exec("INSERT INTO web_sessions VALUES(?,?)", await sha(t), Date.now() + TTL);
    return new Response(null, { status: 303, headers: { location: "/board", "set-cookie": cookie(t, TTL / 1000) } });
  }
  if (p === "/board/logout" && req.method === "POST") {
    const m = (req.headers.get("cookie") || "").match(new RegExp(`${COOKIE}=([A-Za-z0-9_-]+)`));
    if (m) self.sql.exec("DELETE FROM web_sessions WHERE h=?", await sha(m[1]));
    return new Response(null, { status: 204, headers: { "set-cookie": cookie("", 0) } });
  }
  const ok = await session(self, req);
  if (p.startsWith("/board/api/")) {
    if (!ok) return json({ error: "unauthorized" }, 401);
    if (p === "/board/api/messages") return json({ messages: self.sql.exec("SELECT id,created_at,to_name AS 'to',from_name AS 'from',text FROM board ORDER BY id DESC LIMIT 200").toArray() });
    if (p === "/board/api/tasks") {
      const tasks = self.sql.exec("SELECT id,title,description,owner,reviewer,status,next_owner,data_level,touches_mainline,updated_at FROM tasks ORDER BY seq DESC LIMIT 300").toArray();
      const lk = tasks.find((t) => t.touches_mainline && ["in_progress", "in_review"].includes(t.status));
      return json({ tasks, mainline_lock: lk ? { id: lk.id, owner: lk.owner } : null });
    }
    return json({ error: "not_found" }, 404);
  }
  if (p !== "/board") return json({ error: "not_found" }, 404);
  if (!ok) {
    const e = new URL(req.url).searchParams.get("e");
    return html(`<form class=login method=post action=/board/login><h2>${cfg.boardName.replace(/[<>&"]/g, "")}</h2>${e ? `<p class=e>${e === "locked" ? "Too many attempts; try later." : "Wrong password."}</p>` : ""}<input type=password name=password placeholder="Owner password" autocomplete=current-password required autofocus><button>Sign in</button></form>`);
  }
  return html(`<header><h1>${cfg.boardName.replace(/[<>&"]/g, "")}</h1><button data-tab=board aria-selected=true>Board</button><button data-tab=tasks aria-selected=false>Tasks</button><button id=out>Sign out</button></header><main id=list></main><script src=/board/app.js></script>`);
}
