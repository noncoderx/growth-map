# Points Gamification + Hybrid Zen-Play Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sarah and Mirayah earn points for correct worksheet answers (AI-assisted grading of an uploaded photo, parent-approved before points post), tracked in a Supabase-backed wallet, with the whole site restyled to a calm "Hybrid Zen-Play" look.

**Architecture:** Single-file static app (`growth-map.html`) stays single-file. Adds a Supabase backend (2 new tables `sheets`/`points_ledger`, a Storage bucket, one Edge Function `grade-sheet`) reusing the existing (currently paused) `growth-map` Supabase project. Reinstates the cross-device localStorage+Supabase sync that was built and then reverted on 2026-07-22 (code recovered from git history, cause of the revert unknown but not a known blocker). The existing manual mastery-check flow (`openMasteryCheck`/`confirmMastery`) is extended, not replaced — AI grading pre-fills the same `mCorrect` input the parent already edits by hand.

**Tech Stack:** Vanilla JS (no build step, matches existing file), Supabase JS SDK v2 via CDN (`@supabase/supabase-js@2`), Supabase Postgres + Storage + Edge Functions (Deno), Anthropic Messages API called via raw `fetch` from the Edge Function (Deno has no official Anthropic SDK, so raw HTTP is correct per the API skill's language-detection rules), model `claude-opus-5` with `output_config.format` (structured outputs) so grading always returns valid JSON.

## Global Constraints

- Never write to booksgoat.com — not touched by this plan, no-op.
- `node --check` doesn't apply (no Node build); instead every HTML/JS edit must be validated by opening the file in a browser (or headless via Playwright) and checking for console errors before moving to the next task.
- Reuse the existing Supabase project `growth-map` (id `fuajabuexuqjoqndbeed`, org `oqzqnkjusaalgafmyysp`) — do not create a second project. It is currently `INACTIVE` (paused, free-tier auto-pause) and must be restored in Task 1.
- Open RLS (public anon read/write, no login) on every new table/bucket — matches the rest of this app's posture (private family tool, shared by a plain link, not a public product). This is a deliberate, already-approved tradeoff, not something to relitigate.
- Print output (`.sheet` CSS class and everything under it) must not change — the reskin (Task 3) is screen-UI only.
- Never commit secrets. The Anthropic API key goes into Supabase as a function secret (`supabase secrets set` / dashboard), never into `growth-map.html` or any committed file.
- Test approach: no test framework in this repo. Verify each task by driving the real `growth-map.html` in a browser (Playwright MCP tools are available: `mcp__plugin_playwright_playwright__*`) and/or querying the real Supabase tables — same convention as the existing `growth-map-exhaustive-audit` skill.

---

### Task 1: Restore Supabase project and create schema

**Files:**
- No local files — this is Supabase-side setup (SQL migration + Storage + secrets).

**Interfaces:**
- Produces: two tables `sheets` and `points_ledger`, a public Storage bucket `sheet-photos`, all with open RLS. Later tasks (3, 5, 6, 7, 9) depend on this schema existing.

- [ ] **Step 1: Restore the paused project**

Via the Supabase MCP tool available in this environment: call `mcp__claude_ai_Supabase__restore_project` with `id: "fuajabuexuqjoqndbeed"` (may require `confirm_cost` first — follow the tool's own prompts). If that MCP tool isn't available in the executing session, restore it from the Supabase dashboard instead: log in, open the `growth-map` project, click "Restore project."

- [ ] **Step 2: Verify the existing `state` table survived**

Run (via `mcp__claude_ai_Supabase__execute_sql` or the SQL editor in the dashboard):

```sql
select count(*) from state;
```

Expect this to succeed (table exists, likely 0 or 1 rows — it was never written to before the 2026-07-22 revert). If the table is missing, that's fine — Task 2 creates it fresh.

- [ ] **Step 3: Create the `sheets` and `points_ledger` tables**

Run via `mcp__claude_ai_Supabase__apply_migration` (name: `points_gamification_schema`) or the SQL editor:

```sql
create table if not exists sheets (
  id uuid primary key default gen_random_uuid(),
  kid text not null check (kid in ('sarah','mirayah')),
  subject text not null check (subject in ('maths','science','english')),
  rung int not null,
  questions jsonb not null,
  answer_key jsonb not null,
  mtotal int not null,
  photo_url text,
  ai_verdict jsonb,
  final_verdict jsonb,
  points_awarded int,
  status text not null default 'pending_upload' check (status in ('pending_upload','pending_review','approved')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists points_ledger (
  id uuid primary key default gen_random_uuid(),
  kid text not null check (kid in ('sarah','mirayah')),
  delta int not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table sheets enable row level security;
alter table points_ledger enable row level security;

create policy "open select sheets" on sheets for select using (true);
create policy "open insert sheets" on sheets for insert with check (true);
create policy "open update sheets" on sheets for update using (true);

create policy "open select ledger" on points_ledger for select using (true);
create policy "open insert ledger" on points_ledger for insert with check (true);
```

- [ ] **Step 4: Create the Storage bucket**

```sql
insert into storage.buckets (id, name, public)
values ('sheet-photos', 'sheet-photos', true)
on conflict (id) do nothing;

create policy "open select sheet-photos" on storage.objects
  for select using (bucket_id = 'sheet-photos');
create policy "open insert sheet-photos" on storage.objects
  for insert with check (bucket_id = 'sheet-photos');
```

- [ ] **Step 5: Verify**

```sql
select table_name from information_schema.tables where table_name in ('sheets','points_ledger');
select id, public from storage.buckets where id = 'sheet-photos';
```

Expect both table names returned, and the bucket row with `public = true`.

- [ ] **Step 6: Set the Anthropic API key as a Supabase secret**

The key already exists locally at `~/.anthropic_api_key` — do not print or commit its contents. Via Supabase CLI:

```bash
supabase secrets set --project-ref fuajabuexuqjoqndbeed ANTHROPIC_API_KEY="$(cat ~/.anthropic_api_key)"
```

Verify it's set (value redacted in output):

```bash
supabase secrets list --project-ref fuajabuexuqjoqndbeed
```

Expect `ANTHROPIC_API_KEY` in the list.

---

### Task 2: Reinstate localStorage + Supabase cross-device state sync

**Files:**
- Modify: `growth-map.html:8` (add `<script>` tag for supabase-js after `</style>`)
- Modify: `growth-map.html:139-141` (persistence comment)
- Modify: `growth-map.html:614-643` (`save`/`load` functions)
- Modify: `growth-map.html:2336-2340` (INIT block)

**Interfaces:**
- Produces: `sb` (module-level Supabase client, used by Tasks 5/6/9/11), `saveLocal()`, `save()` (unchanged call sites — every existing caller of `save()` keeps working), `pushCloud()`, `pullAndMergeCloud(silent)`.
- Consumes: nothing new — this restores prior working code (git commits `49103f2`, `67edc36`, `c17620c`, reverted 2026-07-22 for an unrecorded reason, cherry-picked here in its final fixed form).

- [ ] **Step 1: Add the supabase-js CDN script tag**

In `growth-map.html`, right after the closing `</style>` tag (line 94) and before `</head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

- [ ] **Step 2: Update the persistence comment**

Replace (around line 136-141):

```
/* ============================================================
   OUR GROWTH MAP — v9  (the "step game")
   Every ✓ Done = an intelligent level-up, never a repeat.
   Progress is saved in the page URL (#state), so a reload
   keeps your place. (No localStorage — by design.)
   ============================================================ */
```

with:

```
/* ============================================================
   OUR GROWTH MAP — v9  (the "step game")
   Every ✓ Done = an intelligent level-up, never a repeat.
   Progress autosaves to localStorage on this device (survives closing
   the tab/browser, reopening the plain link, anything) AND to the page
   URL (#state) so a specific state can still be shared/handed off via
   link. A hash present in the URL wins on load (deliberate override for
   sharing); with no hash, localStorage is the fallback. It also syncs
   to Supabase so any device opening the same link converges to the
   same real progress — see the CLOUD SYNC block near the end of this
   script.
   ============================================================ */
```

- [ ] **Step 3: Replace `save`/`load` with `saveLocal`/`save`/`load`**

Replace the existing block at `growth-map.html:614-643` (from `function save(){` through the closing of `function load(){...}`) with:

```javascript
const LS_KEY='growthMapState_v1';
function currentStateSnapshot(){
 const ext={};
 for(const g of ['sarah','mirayah']){ext[g]={};for(const k of Object.keys(LEVELS[g]))ext[g][k]=LEVELS[g][k].length-BASE_LADDER_LEN[g][k];}
 return {L:LEVEL,X:ext,B:{sarah:{i:BOOK.sarah.idx,d:BOOK.sarah.done,c:BOOK.sarah.custom},mirayah:{i:BOOK.mirayah.idx,d:BOOK.mirayah.done,c:BOOK.mirayah.custom}}};
}
function saveLocal(){
 try{
  const json=JSON.stringify(currentStateSnapshot());
  history.replaceState(null,'','#'+encodeURIComponent(json));
  try{localStorage.setItem(LS_KEY,json);}catch(e){/* private-browsing/storage-blocked: hash still works this tab */}
 }catch(e){/* if hash write is blocked, stay in-memory */}
}
function save(){
 saveLocal();
 if(typeof pushCloud==='function')pushCloud(); // fire-and-forget; local save above already succeeded regardless
}
function load(){
 try{
  // A hash in the URL is a deliberate share/handoff — it wins. Otherwise fall back
  // to this device's own autosave, so a bare/fresh link still resumes real progress.
  let json=null;
  if(location.hash&&location.hash.length>1) json=decodeURIComponent(location.hash.slice(1));
  else try{json=localStorage.getItem(LS_KEY);}catch(e){/* storage blocked */}
  if(!json)return;
  const s=JSON.parse(json);
  if(s.X){for(const g of ['sarah','mirayah'])for(const k of Object.keys(LEVELS[g])){
    const n=s.X[g] && s.X[g][k];
    if(Number.isInteger(n)&&n>0){
     const lad=LEVELS[g][k],base=BASE_LADDER_LEN[g][k],cap=Math.min(n,1000); /* cap guards against a hand-edited/corrupt hash forcing a huge synchronous loop */
     for(let t=1;t<=cap;t++)lad.push(intensifyRung(lad[base-1],t));
    }
  }}
  if(s.L){for(const g of ['sarah','mirayah'])for(const k of Object.keys(LEVELS[g])){
    const v=s.L[g] && s.L[g][k]; const max=LEVELS[g][k].length-1;
    if(Number.isInteger(v)) LEVEL[g][k]=Math.max(0,Math.min(max,v));
  }}
  if(s.B){for(const g of ['sarah','mirayah']){
    if(s.B[g]){ if(Number.isInteger(s.B[g].i)) BOOK[g].idx=Math.max(0,s.B[g].i);
                if(Array.isArray(s.B[g].d)) BOOK[g].done=s.B[g].d;
                if(typeof s.B[g].c==='string') BOOK[g].custom=s.B[g].c; }
  }}
 }catch(e){/* ignore a malformed hash */}
}
```

- [ ] **Step 4: Add the cloud sync block**

Insert this new block right before the `/* ===== INIT ===== */` comment (currently around line 2336), after the `MASTERY MODAL WIRING` section:

```javascript
/* ===== CLOUD SYNC (Supabase) — same real progress on any device, no login =====
   Open by design: public anon key, RLS lets anyone read/write this one table,
   no per-user auth. This is a private family tool shared by a plain link, not
   a public product — that tradeoff was a deliberate, explicit decision, not
   an oversight. Merge on every pull is monotonic: max() per LEVEL/X counter
   (never regress real progress if the two devices diverged), union of
   BOOK.done (never lose a finished book), max of BOOK.idx, BOOK.custom kept
   from whichever side actually has a non-empty value. */
const SB_URL='https://fuajabuexuqjoqndbeed.supabase.co';
const SB_KEY='sb_publishable_GvCjPmsNOd56vxVrMCeufw_KtIze4O9';
const SB_ROW_KEY='family';
const sb=window.supabase.createClient(SB_URL,SB_KEY);

function mergeState(local,remote){
 if(!remote)return local;
 if(!local)return remote;
 const out={L:{},X:{},B:{}};
 for(const g of ['sarah','mirayah']){
  out.L[g]={};for(const k of Object.keys(local.L[g]||{}))out.L[g][k]=Math.max(local.L[g]?.[k]??0,remote.L?.[g]?.[k]??0);
  out.X[g]={};const xk=new Set([...Object.keys(local.X?.[g]||{}),...Object.keys(remote.X?.[g]||{})]);
  for(const k of xk)out.X[g][k]=Math.max(local.X?.[g]?.[k]??0,remote.X?.[g]?.[k]??0);
  const li=local.B?.[g]||{i:0,d:[],c:null},ri=remote.B?.[g]||{i:0,d:[],c:null};
  out.B[g]={
   i:Math.max(li.i||0,ri.i||0),
   d:[...new Set([...(li.d||[]),...(ri.d||[])])],
   c:(li.c&&li.c.trim())?li.c:((ri.c&&ri.c.trim())?ri.c:null)
  };
 }
 return out;
}

function applyState(s){
 if(s.X){for(const g of ['sarah','mirayah'])for(const k of Object.keys(LEVELS[g])){
   const want=s.X[g]&&s.X[g][k],have=LEVELS[g][k].length-BASE_LADDER_LEN[g][k];
   if(Number.isInteger(want)&&want>have){
    const lad=LEVELS[g][k],base=BASE_LADDER_LEN[g][k],cap=Math.min(want,1000);
    for(let t=have+1;t<=cap;t++)lad.push(intensifyRung(lad[base-1],t));
   }
 }}
 if(s.L){for(const g of ['sarah','mirayah'])for(const k of Object.keys(LEVELS[g])){
   const v=s.L[g]&&s.L[g][k];const max=LEVELS[g][k].length-1;
   if(Number.isInteger(v))LEVEL[g][k]=Math.max(0,Math.min(max,v));
 }}
 if(s.B){for(const g of ['sarah','mirayah']){
   if(s.B[g]){ if(Number.isInteger(s.B[g].i))BOOK[g].idx=Math.max(BOOK[g].idx,s.B[g].i);
               if(Array.isArray(s.B[g].d))BOOK[g].done=[...new Set([...(BOOK[g].done||[]),...s.B[g].d])];
               if(typeof s.B[g].c==='string'&&s.B[g].c.trim())BOOK[g].custom=s.B[g].c; }
 }}
}

async function writeCloudRaw(stateObj){
 try{await sb.from('state').upsert({key:SB_ROW_KEY,data:stateObj,updated_at:new Date().toISOString()});}
 catch(e){/* offline or blocked — local save already happened, not fatal */}
}

async function pushCloud(){
 // Merge-before-write, never a blind overwrite — this exact bug was found and
 // fixed during the 2026-07-22 build: device A pushes real advances, device B
 // (never refreshed, holding a stale local snapshot) later saves anything and
 // its naive push silently erases A's progress. Pulling + merging first means
 // a stale push can only ever advance the cloud (mergeState is monotonic),
 // never roll it back.
 try{
  const {data}=await sb.from('state').select('data').eq('key',SB_ROW_KEY).maybeSingle();
  const merged=mergeState(currentStateSnapshot(),data?data.data:null);
  applyState(merged);
  saveLocal();
  await writeCloudRaw(merged);
 }catch(e){/* offline or blocked — local save already happened, not fatal */}
}

async function pullAndMergeCloud(silent){
 try{
  const {data,error}=await sb.from('state').select('data').eq('key',SB_ROW_KEY).maybeSingle();
  if(error||!data)return;
  const merged=mergeState(currentStateSnapshot(),data.data);
  applyState(merged);
  saveLocal();
  if(!silent)await writeCloudRaw(merged);
  buildOverview();buildGirl('sarah');buildGirl('mirayah');
 }catch(e){/* offline — local state stands, will retry on next load/change */}
}

sb.channel('state-changes')
 .on('postgres_changes',{event:'*',schema:'public',table:'state',filter:`key=eq.${SB_ROW_KEY}`},()=>{pullAndMergeCloud(true);})
 .subscribe();
```

- [ ] **Step 5: Update the INIT block**

Replace (around line 2336-2340):

```javascript
/* ===== INIT ===== */
load();
buildOverview();
buildGirl('sarah');
buildGirl('mirayah');
```

with:

```javascript
/* ===== INIT ===== */
load();
buildOverview();
buildGirl('sarah');
buildGirl('mirayah');
pullAndMergeCloud(); // async — page renders instantly from local/hash first, upgrades to merged cross-device state moments later
```

- [ ] **Step 6: Verify in a browser**

Open `growth-map.html` directly (`file://` path) via Playwright (`mcp__plugin_playwright_playwright__browser_navigate`), check console for errors (`mcp__plugin_playwright_playwright__browser_console_messages`) — expect none. Click "✓ Done — level up" on any lane subject (e.g. Sarah → Swimming, which doesn't need the mastery modal), confirm the URL hash changes and no error appears. Then query Supabase directly:

```sql
select * from state where key = 'family';
```

Expect one row, `updated_at` recent, `data` containing the just-changed level. **Cleanup after testing:** `delete from state where key='family';` with zero browser tabs open (an open tab's realtime subscription will otherwise re-push the test value right back) — this table is the real production data store, not a test fixture.

- [ ] **Step 7: Commit**

```bash
git add growth-map.html
git commit -m "feat: reinstate localStorage + Supabase cross-device sync

Cherry-picked from the working, stress-tested 2026-07-22 build that was
reverted the same day for an unrecorded reason. Cross-device balance
sync is now a hard requirement for the points feature, so rebuilding
this was necessary regardless.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Full-site reskin — Hybrid Zen-Play

**Files:**
- Modify: `growth-map.html:8-9` (`:root` CSS variables)
- Modify: `growth-map.html:11-93` (component CSS rules — NOT the `.sheet`/print rules)

**Interfaces:**
- Produces: new CSS custom properties consumed by every subsequent UI task (Wallet screen in Task 5 uses `--ring-arc`/`--card`/etc.).
- Consumes: nothing — pure CSS, no JS changes, no DOM structure changes (class names stay identical so existing JS `document.querySelector`/`classList` calls keep working).

- [ ] **Step 1: Replace the `:root` block**

Replace `growth-map.html:8-9`:

```css
  :root{--card:#1a1f3d;--card2:#232a52;--ink:#eef1ff;--muted:#9aa3d4;--line:#2c3566;
    --learn:#7c9cff;--english:#ff8da3;--maths:#7c9cff;--swim:#39c5e8;--music:#c98bff;--ride:#ffb86b;--give:#5fe0b0;--star:#ffd86b;}
```

with:

```css
  :root{--card:#ffffff;--card2:#fbf6ea;--ink:#2e2a3d;--muted:#8a7a55;--line:#f0e9da;
    --learn:#5b4a8a;--english:#ff8da3;--maths:#5b4a8a;--swim:#39c5e8;--music:#c98bff;--ride:#ffb069;--give:#5fe0b0;--star:#ffb069;
    --hz-bg1:#fdf6ec;--hz-bg2:#eef3ff;--hz-primary:#5b4a8a;--hz-primary-ink:#fff;--hz-accent:#ffb069;--hz-track:#eee1ff;}
```

- [ ] **Step 2: Update `body`, `.tab`, `.card`, `.btn`, progress bar, `.wszone`, `.masteryCard`**

Replace `growth-map.html:11`:

```css
  body{margin:0;font-family:'Trebuchet MS','Segoe UI',system-ui,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#1c2350,#0f1226);color:var(--ink);padding:22px;min-height:100vh}
```

with:

```css
  body{margin:0;font-family:'Trebuchet MS','Segoe UI',system-ui,sans-serif;background:linear-gradient(180deg,var(--hz-bg1),var(--hz-bg2));color:var(--ink);padding:22px;min-height:100vh}
```

Replace `growth-map.html:17-18` (`.tab` rules):

```css
  .tab{background:var(--card);border:1px solid var(--line);color:var(--muted);padding:9px 18px;border-radius:99px;font-size:13.5px;font-family:inherit;cursor:pointer;font-weight:600}
  .tab:hover{color:var(--ink)}.tab.active{background:var(--ink);color:#0f1226;border-color:var(--ink)}
```

with:

```css
  .tab{background:var(--card);border:1px solid var(--line);color:var(--muted);padding:9px 18px;border-radius:99px;font-size:13.5px;font-family:inherit;cursor:pointer;font-weight:600;box-shadow:0 2px 8px rgba(90,70,40,.05)}
  .tab:hover{color:var(--ink)}.tab.active{background:var(--hz-primary);color:var(--hz-primary-ink);border-color:var(--hz-primary)}
```

Replace `growth-map.html:21-24` (`.card` rules):

```css
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;position:relative;overflow:hidden;cursor:pointer;transition:border-color .15s,transform .15s}
  .card:hover{border-color:var(--accent);transform:translateY(-2px)}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--accent)}
  .ico{font-size:22px}.ctitle{font-weight:700;font-size:15px;margin:6px 0 2px}.cnow{color:var(--muted);font-size:12px}.cnow b{color:var(--ink)}.stars{margin-top:8px;font-size:14px;color:var(--star);letter-spacing:2px}
```

with:

```css
  .card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:16px;position:relative;overflow:hidden;cursor:pointer;transition:border-color .15s,transform .15s;box-shadow:0 8px 20px rgba(90,70,40,.06)}
  .card:hover{border-color:var(--accent);transform:translateY(-2px)}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--accent)}
  .ico{font-size:22px}.ctitle{font-weight:700;font-size:15px;margin:6px 0 2px}.cnow{color:var(--muted);font-size:12px}.cnow b{color:var(--ink)}.stars{margin-top:8px;font-size:14px;color:var(--star);letter-spacing:2px}
```

Replace `growth-map.html:31-32` (`.btn` rules):

```css
  .btn{background:var(--card);border:1px solid var(--line);color:var(--ink);padding:8px 14px;border-radius:10px;font-size:12.5px;font-family:inherit;cursor:pointer;font-weight:600}
  .btn:hover{border-color:var(--muted)}
```

with:

```css
  .btn{background:var(--card2);border:2px solid var(--line);color:var(--hz-primary);padding:8px 16px;border-radius:99px;font-size:12.5px;font-family:inherit;cursor:pointer;font-weight:700}
  .btn:hover{border-color:var(--hz-primary)}
  .btn.primary{background:var(--hz-primary);border-color:var(--hz-primary);color:var(--hz-primary-ink)}
```

Replace `growth-map.html:33-34` (progress bar):

```css
  .progress{height:9px;background:#0f1226;border:1px solid var(--line);border-radius:99px;overflow:hidden;margin:6px 0 16px}
  .progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--give),var(--swim));transition:width .25s}
```

with:

```css
  .progress{height:9px;background:var(--hz-track);border:1px solid var(--line);border-radius:99px;overflow:hidden;margin:6px 0 16px}
  .progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--hz-accent),var(--hz-primary));transition:width .25s}
```

Replace `growth-map.html:36-42` (`.task`/`.box` rules):

```css
  .task{display:flex;align-items:flex-start;gap:10px;padding:8px;border-radius:10px;cursor:pointer;background:#161b35;margin-bottom:6px;border:1px solid var(--line)}
  .task:hover{background:#1e244a}
  .box{flex:0 0 19px;width:19px;height:19px;border:2px solid var(--line);border-radius:6px;margin-top:1px;position:relative}
  .task.done .box{background:var(--give);border-color:var(--give)}
  .task.done .box::after{content:"✓";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#0f1226;font-size:12px;font-weight:900}
  .task .txt{font-size:13.5px;line-height:1.4}.task.done .txt{color:var(--muted);text-decoration:line-through}
  .task .txt small{display:block;color:var(--muted);font-size:11.5px;text-decoration:none;margin-top:2px}
```

with:

```css
  .task{display:flex;align-items:flex-start;gap:10px;padding:8px;border-radius:12px;cursor:pointer;background:var(--card2);margin-bottom:6px;border:1px solid var(--line)}
  .task:hover{border-color:var(--hz-primary)}
  .box{flex:0 0 19px;width:19px;height:19px;border:2px solid var(--line);border-radius:6px;margin-top:1px;position:relative}
  .task.done .box{background:var(--give);border-color:var(--give)}
  .task.done .box::after{content:"✓";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:900}
  .task .txt{font-size:13.5px;line-height:1.4}.task.done .txt{color:var(--muted);text-decoration:line-through}
  .task .txt small{display:block;color:var(--muted);font-size:11.5px;text-decoration:none;margin-top:2px}
```

Replace `growth-map.html:43` (`.reflectline`):

```css
  .reflectline{margin-top:14px;font-size:12.5px;color:var(--muted);background:#0f1226;border:1px dashed var(--line);border-radius:10px;padding:11px 13px}
```

with:

```css
  .reflectline{margin-top:14px;font-size:12.5px;color:var(--muted);background:var(--card2);border:1px dashed var(--line);border-radius:10px;padding:11px 13px}
```

Replace `growth-map.html:44-53` (`.wszone` and level-rail rules):

```css
  /* worksheet zone */
  .wszone{margin-top:22px;background:var(--card2);border:1px solid var(--line);border-radius:18px;padding:16px}
  .wszone .top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px}
  .wszone h3{margin:0;font-size:15px}
  .levelbadge{font-size:11.5px;color:#0f1226;background:var(--star);border-radius:99px;padding:4px 11px;font-weight:700}
  .levelrail{display:flex;gap:4px;margin:10px 0 2px;flex-wrap:wrap}
  .rung{height:7px;flex:1 1 8px;min-width:8px;border-radius:99px;background:#0f1226;border:1px solid var(--line)}
  .rung.on{background:linear-gradient(90deg,var(--give),var(--swim));border-color:transparent}
  .rung.here{outline:2px solid var(--star);outline-offset:1px}
  .lvline{font-size:11px;color:var(--muted);margin-top:4px}.lvline b{color:#ffe9a8}
  .donebtn{background:#5fe0b0;border-color:#5fe0b0;color:#0f1226}
```

with:

```css
  /* worksheet zone */
  .wszone{margin-top:22px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:16px;box-shadow:0 8px 20px rgba(90,70,40,.06)}
  .wszone .top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px}
  .wszone h3{margin:0;font-size:15px}
  .levelbadge{font-size:11.5px;color:#5b4a2e;background:var(--hz-accent);border-radius:99px;padding:4px 11px;font-weight:700}
  .levelrail{display:flex;gap:4px;margin:10px 0 2px;flex-wrap:wrap}
  .rung{height:7px;flex:1 1 8px;min-width:8px;border-radius:99px;background:var(--hz-track);border:1px solid var(--line)}
  .rung.on{background:linear-gradient(90deg,var(--hz-accent),var(--hz-primary));border-color:transparent}
  .rung.here{outline:2px solid var(--hz-accent);outline-offset:1px}
  .lvline{font-size:11px;color:var(--muted);margin-top:4px}.lvline b{color:#5b4a2e}
  .donebtn{background:var(--give);border-color:var(--give);color:#0f1226}
```

Replace `growth-map.html:60-72` (toast + mastery overlay/card rules):

```css
  #toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:#0f1226;border:1px solid var(--give);color:var(--ink);padding:10px 16px;border-radius:12px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:50;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .masteryOverlay{position:fixed;inset:0;background:rgba(6,8,16,.72);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px}
  .masteryCard{background:var(--card,#171a26);border:1px solid var(--line);border-radius:16px;padding:22px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .masteryCard h3{margin:0 0 10px}
  .masteryQ{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:14px}
  .masteryQ b{color:#ffe9a8}
  .masteryRow{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:8px}
  .masteryRow input{width:64px;text-align:center;font-size:20px;font-weight:700;background:#0f1226;border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:8px}
  .mStep{padding:8px 14px;font-size:18px;line-height:1}
  .masteryNeed{font-size:11.5px;color:var(--muted);text-align:center;margin-bottom:16px}
  .masteryActions{display:flex;flex-direction:column;gap:8px}
  .masteryActions .btn{width:100%}
```

with:

```css
  #toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:var(--hz-primary);border:1px solid var(--hz-primary);color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:50;box-shadow:0 10px 30px rgba(90,70,40,.25)}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .masteryOverlay{position:fixed;inset:0;background:rgba(60,50,80,.45);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px}
  .masteryCard{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(90,70,40,.25)}
  .masteryCard h3{margin:0 0 10px}
  .masteryQ{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:14px}
  .masteryQ b{color:var(--hz-primary)}
  .masteryRow{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:8px}
  .masteryRow input{width:64px;text-align:center;font-size:20px;font-weight:700;background:var(--hz-bg1);border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:8px}
  .mStep{padding:8px 14px;font-size:18px;line-height:1}
  .masteryNeed{font-size:11.5px;color:var(--muted);text-align:center;margin-bottom:16px}
  .masteryActions{display:flex;flex-direction:column;gap:8px}
  .masteryActions .btn{width:100%}
  .masteryAiNote{font-size:11.5px;color:var(--hz-primary);background:var(--card2);border:1px dashed var(--line);border-radius:10px;padding:8px 10px;margin-bottom:10px;text-align:center}
```

Do **not** touch the `.sheet` block (`growth-map.html:73-93`, the `@media print` rule, or `#printRoot`) — those stay exactly as-is per the constraint that printed output is unaffected.

- [ ] **Step 2: Verify in a browser**

Open the file via Playwright, take a screenshot (`mcp__plugin_playwright_playwright__browser_take_screenshot`) of the Overview tab and of a subject panel (e.g. Sarah → Maths). Confirm: cream/lavender background, white rounded cards, violet active tab, pill-shaped buttons. Click "Make worksheet" → "Print" is not invoked, but visually confirm the worksheet preview (`.sheet` inside `.wsprev`) still renders on its original white/serif styling, unaffected by the reskin.

- [ ] **Step 3: Commit**

```bash
git add growth-map.html
git commit -m "style: reskin to Hybrid Zen-Play across the whole site

Cream-to-lavender gradient background, white rounded cards, violet
pill buttons/tabs, warm-orange accents on progress/level indicators.
CSS-only — no DOM or JS changes. Printed worksheets (.sheet, @media
print) are untouched by design.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Persist worksheet + answer key at generation time

**Files:**
- Modify: `growth-map.html:2131-2134` (`makeWS`)

**Interfaces:**
- Consumes: `sb` (Supabase client from Task 2), `CURWS`/`CURGK`/`CURSK` (existing globals), `wsQuestionCount(ws)` (existing function at `growth-map.html:2162`).
- Produces: a new global `CURSHEETID` (the Supabase `sheets.id` for the currently-displayed worksheet), read by Task 6 (upload) and Task 8 (mastery prefill).

- [ ] **Step 1: Add a helper to extract question/answer text from a `CURWS` object**

Insert this function right before `makeWS` (before `growth-map.html:2131`):

```javascript
function wsQuestionsForStorage(ws){
 return ws.blocks.map(b=>({h:b.h,items:b.items||[]}));
}
function wsAnswerKeyForStorage(ws){
 return {keyLabel:ws.keyLabel||'Answer key — for grown-ups',ans:ws.ans||[]};
}
```

- [ ] **Step 2: Persist a `sheets` row every time a worksheet is generated**

Replace `growth-map.html:2131-2134`:

```javascript
let CURWS=null, CURGK=null, CURSK=null;
function makeWS(gk,sk){const li=LEVEL[gk][sk];const ws=(sk==='english')?GENS[gk][sk](li,curBook(gk)):GENS[gk][sk](li);CURWS=ws;CURGK=gk;CURSK=sk;
 const prev=document.getElementById('wsprev-'+gk+sk),empty=document.getElementById('wsempty-'+gk+sk);
 if(prev){prev.innerHTML=wsHTML(ws);prev.style.display='block';}if(empty)empty.style.display='none';}
```

with:

```javascript
let CURWS=null, CURGK=null, CURSK=null, CURSHEETID=null;
function makeWS(gk,sk){const li=LEVEL[gk][sk];const ws=(sk==='english')?GENS[gk][sk](li,curBook(gk)):GENS[gk][sk](li);CURWS=ws;CURGK=gk;CURSK=sk;CURSHEETID=null;
 const prev=document.getElementById('wsprev-'+gk+sk),empty=document.getElementById('wsempty-'+gk+sk);
 if(prev){prev.innerHTML=wsHTML(ws);prev.style.display='block';}if(empty)empty.style.display='none';
 if(isAcad(sk))persistSheet(gk,sk,li,ws);}
async function persistSheet(gk,sk,li,ws){
 try{
  const mtotal=wsQuestionCount(ws)||1;
  const {data,error}=await sb.from('sheets').insert({
   kid:gk,subject:sk,rung:li,
   questions:wsQuestionsForStorage(ws),
   answer_key:wsAnswerKeyForStorage(ws),
   mtotal,status:'pending_upload'
  }).select('id').single();
  if(!error&&data)CURSHEETID=data.id;
 }catch(e){/* offline — upload/AI-grade simply won't be available for this sheet until it can retry */}
}
```

Note: `isAcad` and `wsQuestionCount` already exist at `growth-map.html:2142` and `growth-map.html:2162` respectively — both are defined earlier in the file than `makeWS`'s new call site, so no reordering is needed. `sb` is defined in the Cloud Sync block from Task 2, which is later in the file, but `persistSheet` only *runs* on a button click (long after the whole script has parsed), so the forward reference is safe — same pattern the existing code already uses for `pushCloud` inside `save()`.

- [ ] **Step 3: Verify**

Via Playwright: navigate to the file, click Sarah tab → Maths subtab → "Make worksheet". Then query:

```sql
select id, kid, subject, rung, mtotal, status from sheets order by created_at desc limit 1;
```

Expect one row, `kid='sarah'`, `subject='maths'`, `status='pending_upload'`, `mtotal` a positive integer matching the sheet's graded question count. Cleanup: `delete from sheets;` after testing (test data, not real family progress, but keep the table clean before Task 6+ testing).

- [ ] **Step 4: Commit**

```bash
git add growth-map.html
git commit -m "feat: persist worksheet + answer key to Supabase at generation time

Every academic-subject worksheet now gets a sheets row with its
questions/answer_key/mtotal at the moment it's generated — the ground
truth the upcoming photo-grading feature checks against.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Points/wallet data helpers + Wallet UI (empty state)

**Files:**
- Modify: `growth-map.html:2261-2265` (`buildGirl` — add the Wallet entry point)
- Create (inline, new functions): wallet render/data functions, placed near `panelHTML` (~`growth-map.html:2228`)

**Interfaces:**
- Produces: `getBalance(gk)`, `getStreak(gk)`, `getLedgerHistory(gk)`, `renderWallet(gk)` — consumed by Task 9 (points award) and Task 10 (payout button).
- Consumes: `points_ledger` table (Task 1), `sb` (Task 2).

- [ ] **Step 1: Add wallet data helpers**

Insert before `panelHTML` (before `growth-map.html:2228`):

```javascript
/* ===== WALLET (points) ===== */
let WALLET_CACHE={sarah:{ledger:[]},mirayah:{ledger:[]}};
async function refreshWalletCache(gk){
 try{
  const {data,error}=await sb.from('points_ledger').select('*').eq('kid',gk).order('created_at',{ascending:false});
  if(!error&&data)WALLET_CACHE[gk].ledger=data;
 }catch(e){/* offline — cache stays at its last known value */}
}
function getBalance(gk){return WALLET_CACHE[gk].ledger.reduce((sum,r)=>sum+r.delta,0);}
function getStreak(gk){
 const days=new Set(WALLET_CACHE[gk].ledger.filter(r=>r.delta>0).map(r=>r.created_at.slice(0,10)));
 let streak=0,d=new Date();
 while(true){
  const key=d.toISOString().slice(0,10);
  if(days.has(key)){streak++;d.setDate(d.getDate()-1);}
  else if(streak===0&&key===new Date().toISOString().slice(0,10)){d.setDate(d.getDate()-1);continue;} /* today with no entry yet doesn't break a streak that continues from yesterday */
  else break;
 }
 return streak;
}
function walletHTML(gk){
 const g=DATA[gk],bal=getBalance(gk),streak=getStreak(gk),hist=WALLET_CACHE[gk].ledger.slice(0,10);
 const pct=Math.max(0,Math.min(1,bal/50)); /* ring fill is illustrative — caps visually at 50pts, balance number is the real value */
 const arc=Math.round(pct*360);
 let h='<div class="ebar"><h2>💰 Wallet — '+g.name+'</h2></div>';
 h+='<div class="hz-ring" style="--arc:'+arc+'deg"><div class="hz-ring-inner"><div class="hz-ring-lab">points owed</div><div class="hz-ring-num">'+bal+'</div></div></div>';
 h+='<div class="lvline" style="text-align:center;margin:6px 0 16px">🔥 '+streak+' day streak</div>';
 h+='<div class="actions" style="justify-content:center;margin-bottom:16px">'
  +'<button class="btn primary" data-act="uploadPhotoPrompt" data-gk="'+gk+'">📷 Upload today\'s sheet</button>'
  +'<button class="btn" data-act="payout" data-gk="'+gk+'">💸 Paid out — reset to 0</button>'
  +'</div>';
 h+='<div class="sect">Recent</div>';
 if(!hist.length)h+='<div class="wsempty">No points yet — upload a completed sheet to get started.</div>';
 else hist.forEach(r=>{
  const sign=r.delta>=0?'+':'';
  h+='<div class="task"><span class="txt">'+sign+r.delta+' — '+(r.reason==='payout'?'Paid out':'Sheet graded')+'<small>'+new Date(r.created_at).toLocaleDateString()+'</small></span></div>';
 });
 return h;
}
async function renderWallet(gk){
 const root=document.getElementById('content-'+gk);
 root.innerHTML='<div class="wsempty">Loading wallet…</div>';
 await refreshWalletCache(gk);
 root.innerHTML=walletHTML(gk);
}
```

- [ ] **Step 2: Add the ring CSS**

Add to the `:root`-adjacent component CSS (right after the `.masteryAiNote` rule added in Task 3, still inside the same `<style>` block):

```css
  .hz-ring{width:170px;height:170px;margin:16px auto;border-radius:50%;background:conic-gradient(var(--hz-accent) 0deg var(--arc,0deg),var(--hz-track) var(--arc,0deg) 360deg);display:flex;align-items:center;justify-content:center;position:relative}
  .hz-ring::after{content:'';position:absolute;inset:14px;border-radius:50%;background:var(--card)}
  .hz-ring-inner{position:relative;z-index:1;text-align:center}
  .hz-ring-lab{font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted)}
  .hz-ring-num{font-size:34px;font-weight:800;color:var(--hz-primary)}
```

- [ ] **Step 3: Wire "💰 Wallet" as a subtab**

Replace `growth-map.html:2261-2265`:

```javascript
function buildGirl(gk){const g=DATA[gk],bar=document.getElementById('subtabs-'+gk),keys=Object.keys(g.subjects);
 bar.innerHTML='';
 keys.forEach(sk=>{const s=g.subjects[sk],b=document.createElement('button');b.className='subtab';b.dataset.sk=sk;b.textContent=s.icon+' '+s.label;b.onclick=()=>selSub(gk,sk,b);bar.appendChild(b);});
 SOON.forEach(t=>{const b=document.createElement('button');b.className='subtab soon';b.disabled=true;b.textContent=t+' · soon';bar.appendChild(b);});
 selSub(gk,keys[0],bar.querySelector('.subtab'));}
```

with:

```javascript
function buildGirl(gk){const g=DATA[gk],bar=document.getElementById('subtabs-'+gk),keys=Object.keys(g.subjects);
 bar.innerHTML='';
 const wb=document.createElement('button');wb.className='subtab';wb.dataset.sk='wallet';wb.textContent='💰 Wallet';
 wb.onclick=()=>{bar.querySelectorAll('.subtab').forEach(x=>{if(!x.classList.contains('soon'))x.style.cssText='';});wb.style.cssText='background:'+DATA[gk].subjects[keys[0]].accent+';border-color:'+DATA[gk].subjects[keys[0]].accent+';color:#fff;font-weight:700';renderWallet(gk);};
 bar.appendChild(wb);
 keys.forEach(sk=>{const s=g.subjects[sk],b=document.createElement('button');b.className='subtab';b.dataset.sk=sk;b.textContent=s.icon+' '+s.label;b.onclick=()=>selSub(gk,sk,b);bar.appendChild(b);});
 SOON.forEach(t=>{const b=document.createElement('button');b.className='subtab soon';b.disabled=true;b.textContent=t+' · soon';bar.appendChild(b);});
 selSub(gk,keys[0],bar.querySelector('.subtab[data-sk="'+keys[0]+'"]'));}
```

`uploadPhotoPrompt` and `payout` action handlers are wired in Tasks 6 and 10 respectively — for this task, clicking them is a harmless no-op (the delegated click handler at `growth-map.html:2299` only reacts to `data-act` values it recognizes; it currently doesn't know these two, so nothing happens yet, which is expected mid-plan).

- [ ] **Step 4: Verify**

Via Playwright: navigate, click Sarah tab, click "💰 Wallet" subtab. Confirm: ring shows "0" with an empty track, "0 day streak", "No points yet" message, no console errors.

- [ ] **Step 5: Commit**

```bash
git add growth-map.html
git commit -m "feat: add Wallet subtab per kid (balance ring, streak, empty history)

Reads points_ledger via Supabase. Upload/payout buttons render but
aren't wired yet — that's Tasks 6 and 10.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Upload photo → Storage + sheets row + trigger grading

**Files:**
- Modify: `growth-map.html:2299-2311` (delegated click handler — add `uploadPhotoPrompt` case)
- Modify: `growth-map.html:2243-2254` (`panelHTML` actions row — add the upload button on the worksheet zone, not just the wallet)

**Interfaces:**
- Consumes: `CURSHEETID` (Task 4), `sb.storage` (Task 2's client, Task 1's bucket).
- Produces: after upload, invokes the `grade-sheet` Edge Function (built in Task 7) — this task can be built and tested independently by checking `sheets.photo_url` gets set even before Task 7 exists; the function-invoke call will simply 404 until Task 7 ships, which is expected mid-plan.

- [ ] **Step 1: Add an upload function**

Insert near `printWS`/`downloadWS` (after `growth-map.html:2139`):

```javascript
function uploadPhotoPrompt(gk,sk){
 if(!sk){ /* called from the Wallet screen with only gk — find the most recent pending_upload sheet for this kid */
  toast('Open the subject\'s worksheet screen and press "Upload photo" there — pick the sheet you just uploaded from.');
  return;
 }
 if(!CURSHEETID){toast('Press "Make worksheet" first, then upload once it\'s printed and filled in.');return;}
 const input=document.createElement('input');
 input.type='file';input.accept='image/*';input.capture='environment';
 input.onchange=()=>{if(input.files&&input.files[0])uploadSheetPhoto(CURSHEETID,input.files[0]);};
 input.click();
}
async function uploadSheetPhoto(sheetId,file){
 toast('📤 Uploading…');
 try{
  const path=sheetId+'-'+Date.now()+'.'+((file.name.split('.').pop())||'jpg');
  const {error:upErr}=await sb.storage.from('sheet-photos').upload(path,file,{upsert:false});
  if(upErr){toast('Upload failed: '+upErr.message);return;}
  const {data:pub}=sb.storage.from('sheet-photos').getPublicUrl(path);
  await sb.from('sheets').update({photo_url:path}).eq('id',sheetId);
  toast('🤖 Grading…');
  const {data,error}=await sb.functions.invoke('grade-sheet',{body:{sheet_id:sheetId}});
  if(error){toast('AI grading unavailable — you can still grade by hand in the mastery check.');return;}
  toast('✅ Graded — press "✓ Done — level up" to review and confirm.');
 }catch(e){toast('Upload failed — check your connection.');}
}
```

- [ ] **Step 2: Wire the delegated click handler**

Replace `growth-map.html:2299-2311`:

```javascript
document.addEventListener('click', e=>{
 const t=e.target.closest('[data-act]'); if(!t) return;
 const gk=t.dataset.gk, sk=t.dataset.sk, act=t.dataset.act;
 if(act==='makeWS') makeWS(gk,sk);
 else if(act==='doneLevelUp') doneLevelUp(gk,sk);
 else if(act==='stepDown') stepDown(gk,sk);
 else if(act==='printWS') printWS();
 else if(act==='downloadWS') downloadWS();
 else if(act==='printTasks') printTasks(gk,sk);
 else if(act==='finishBook') finishBook(gk);
 else if(act==='nextBook') nextBook(gk);
 else if(act==='goSubject') goToSubject(gk,sk);
});
```

with:

```javascript
document.addEventListener('click', e=>{
 const t=e.target.closest('[data-act]'); if(!t) return;
 const gk=t.dataset.gk, sk=t.dataset.sk, act=t.dataset.act;
 if(act==='makeWS') makeWS(gk,sk);
 else if(act==='doneLevelUp') doneLevelUp(gk,sk);
 else if(act==='stepDown') stepDown(gk,sk);
 else if(act==='printWS') printWS();
 else if(act==='downloadWS') downloadWS();
 else if(act==='printTasks') printTasks(gk,sk);
 else if(act==='finishBook') finishBook(gk);
 else if(act==='nextBook') nextBook(gk);
 else if(act==='goSubject') goToSubject(gk,sk);
 else if(act==='uploadPhotoPrompt') uploadPhotoPrompt(gk,sk);
 else if(act==='payout') payout(gk);
});
```

(`payout` is added in Task 10 — its case is added here now so Task 10 doesn't need to touch this handler again.)

- [ ] **Step 3: Add the upload button to the worksheet zone**

Replace `growth-map.html:2246-2252` (inside `panelHTML`, the `.actions` div in the `.wszone`):

```javascript
  +'<div class="actions" style="margin-top:12px">'
  +'<button class="btn" style="background:'+s.accent+';border-color:'+s.accent+';color:#0f1226" data-act="makeWS" data-gk="'+gk+'" data-sk="'+sk+'">'+makeLbl+'</button>'
  +'<button class="btn donebtn" data-act="doneLevelUp" data-gk="'+gk+'" data-sk="'+sk+'">✓ Done — level up →</button>'
  +'<button class="btn stepdown" data-act="stepDown" data-gk="'+gk+'" data-sk="'+sk+'" title="Too hard? step back a rung">↩︎</button>'
  +'<button class="btn" data-act="printWS">🖨️ Print</button>'
  +'<button class="btn" data-act="downloadWS">⬇️ Download</button>'
  +'</div>'
```

with:

```javascript
  +'<div class="actions" style="margin-top:12px">'
  +'<button class="btn" style="background:'+s.accent+';border-color:'+s.accent+';color:#0f1226" data-act="makeWS" data-gk="'+gk+'" data-sk="'+sk+'">'+makeLbl+'</button>'
  +(acad?'<button class="btn" data-act="uploadPhotoPrompt" data-gk="'+gk+'" data-sk="'+sk+'">📷 Upload photo</button>':'')
  +'<button class="btn donebtn" data-act="doneLevelUp" data-gk="'+gk+'" data-sk="'+sk+'">✓ Done — level up →</button>'
  +'<button class="btn stepdown" data-act="stepDown" data-gk="'+gk+'" data-sk="'+sk+'" title="Too hard? step back a rung">↩︎</button>'
  +'<button class="btn" data-act="printWS">🖨️ Print</button>'
  +'<button class="btn" data-act="downloadWS">⬇️ Download</button>'
  +'</div>'
```

(`acad` is already computed two lines earlier in `panelHTML` at `growth-map.html:2239` — `const acad=(sk==='english'||sk==='maths'||sk==='science');` — no new variable needed.)

- [ ] **Step 4: Verify (photo upload half only — grading will 404 until Task 7)**

Via Playwright: navigate, Sarah → Maths → "Make worksheet" → "📷 Upload photo" → the browser's native file picker opens (Playwright: use `mcp__plugin_playwright_playwright__browser_file_upload` to supply a test image path). After upload, query:

```sql
select id, photo_url from sheets order by created_at desc limit 1;
```

Expect `photo_url` set to a non-null path. The subsequent `sb.functions.invoke` call will fail (function doesn't exist yet) — confirm the toast shows "AI grading unavailable" rather than the page erroring. Cleanup: `delete from sheets; delete from storage.objects where bucket_id='sheet-photos';` (or leave for Task 7's testing, which needs a photo already uploaded).

- [ ] **Step 5: Commit**

```bash
git add growth-map.html
git commit -m "feat: upload worksheet photo to Storage, trigger grading

Grading call will fail until the grade-sheet Edge Function ships in
the next task — handled gracefully (falls back to manual grading).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Deploy the `grade-sheet` Edge Function

**Files:**
- Create: `supabase/functions/grade-sheet/index.ts` (new directory, not part of `growth-map.html`)

**Interfaces:**
- Consumes: `sheets` table (Task 1), `ANTHROPIC_API_KEY` secret (Task 1 Step 6), the photo at the public URL set in Task 6.
- Produces: writes `sheets.ai_verdict = {estimated_correct, note}` and flips `status` to `pending_review` — consumed by Task 8.

- [ ] **Step 1: Write the function**

```typescript
// supabase/functions/grade-sheet/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    estimated_correct: { type: "integer" },
    note: { type: "string" },
  },
  required: ["estimated_correct", "note"],
  additionalProperties: false,
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const { sheet_id } = await req.json();
    if (!sheet_id) {
      return new Response(JSON.stringify({ error: "sheet_id required" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const sb = createClient(SB_URL, SB_SERVICE_KEY);

    const { data: sheet, error: fetchErr } = await sb
      .from("sheets")
      .select("*")
      .eq("id", sheet_id)
      .single();
    if (fetchErr || !sheet) {
      return new Response(JSON.stringify({ error: "sheet not found" }), {
        status: 404,
        headers: corsHeaders(),
      });
    }
    if (!sheet.photo_url) {
      return new Response(JSON.stringify({ error: "no photo uploaded yet" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const { data: pub } = sb.storage.from("sheet-photos").getPublicUrl(sheet.photo_url);
    const photoResp = await fetch(pub.publicUrl);
    if (!photoResp.ok) {
      return new Response(JSON.stringify({ error: "could not fetch photo" }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
    const photoBuf = await photoResp.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(photoBuf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const photoB64 = btoa(binary);
    const mediaType = photoResp.headers.get("content-type") || "image/jpeg";

    const prompt =
      `This is a photo of a completed ${sheet.subject} worksheet (rung ${sheet.rung}) that a child filled in by hand.\n\n` +
      `The worksheet's questions were:\n${JSON.stringify(sheet.questions)}\n\n` +
      `The answer key is:\n${JSON.stringify(sheet.answer_key)}\n\n` +
      `There are ${sheet.mtotal} graded questions total. Read the child's handwritten answers in the photo and estimate how many of the ${sheet.mtotal} are correct against the answer key. Give a short note (1-2 sentences) on anything ambiguous, hard to read, or worth a human double-check.`;

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1024,
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: GRADE_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: photoB64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!claudeResp.ok) {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id);
      return new Response(JSON.stringify({ error: "claude request failed" }), {
        status: 502,
        headers: corsHeaders(),
      });
    }

    const claudeJson = await claudeResp.json();
    if (claudeJson.stop_reason === "refusal") {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id);
      return new Response(JSON.stringify({ ok: true, refused: true }), {
        status: 200,
        headers: corsHeaders(),
      });
    }

    const textBlock = (claudeJson.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock) {
      await sb.from("sheets").update({ status: "pending_review" }).eq("id", sheet_id);
      return new Response(JSON.stringify({ error: "no text block in response" }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
    const verdict = JSON.parse(textBlock.text);

    await sb.from("sheets").update({ ai_verdict: verdict, status: "pending_review" }).eq("id", sheet_id);

    return new Response(JSON.stringify({ ok: true, verdict }), {
      status: 200,
      headers: corsHeaders(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
});
```

- [ ] **Step 2: Deploy**

Via the Supabase MCP tool: `mcp__claude_ai_Supabase__deploy_edge_function` with `project_id: "fuajabuexuqjoqndbeed"`, function name `grade-sheet`, and the file content above. If that tool isn't available, use the Supabase CLI:

```bash
cd ~/code/growth-map
supabase functions deploy grade-sheet --project-ref fuajabuexuqjoqndbeed
```

- [ ] **Step 3: Verify — direct function invocation**

Using a `sheets` row from Task 6's test (one with `photo_url` already set — re-run Task 6's upload step if it was cleaned up):

```bash
curl -X POST 'https://fuajabuexuqjoqndbeed.supabase.co/functions/v1/grade-sheet' \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sheet_id":"<the test sheet id>"}'
```

Expect `{"ok":true,"verdict":{"estimated_correct":N,"note":"..."}}`. Then confirm in Postgres:

```sql
select ai_verdict, status from sheets where id = '<the test sheet id>';
```

Expect `status = 'pending_review'` and `ai_verdict` populated. Also re-run Task 6's browser-driven upload flow end-to-end now that the function exists — the toast should now say "✅ Graded" instead of "AI grading unavailable."

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/grade-sheet/index.ts
git commit -m "feat: add grade-sheet Edge Function (Claude vision grading)

Reads a sheet's saved answer key + the uploaded photo, calls Claude
Opus 5 with structured outputs to estimate a correct-count, writes
ai_verdict. Anthropic key stays a Supabase secret, never touches the
client.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire AI verdict into the mastery modal prefill

**Files:**
- Modify: `growth-map.html:117-133` (masteryOverlay HTML — add an AI-note element)
- Modify: `growth-map.html:2163-2171` (`openMasteryCheck`)

**Interfaces:**
- Consumes: `CURSHEETID` (Task 4), `sheets.ai_verdict` (Task 7).
- Produces: `mCorrect` input pre-filled from AI estimate when available; falls back to 0 exactly as today when not.

- [ ] **Step 1: Add an AI-note slot to the mastery modal HTML**

Replace `growth-map.html:120-126`:

```html
    <div class="masteryQ">Check their answers against the answer key. How many did they get right out of <b id="mTotal">0</b>?</div>
    <div class="masteryRow">
      <button class="btn mStep" data-d="-1">−</button>
      <input id="mCorrect" type="number" min="0" value="0" inputmode="numeric">
      <button class="btn mStep" data-d="1">+</button>
    </div>
    <div class="masteryNeed" id="mNeed"></div>
```

with:

```html
    <div class="masteryQ">Check their answers against the answer key. How many did they get right out of <b id="mTotal">0</b>?</div>
    <div class="masteryAiNote" id="mAiNote" style="display:none"></div>
    <div class="masteryRow">
      <button class="btn mStep" data-d="-1">−</button>
      <input id="mCorrect" type="number" min="0" value="0" inputmode="numeric">
      <button class="btn mStep" data-d="1">+</button>
    </div>
    <div class="masteryNeed" id="mNeed"></div>
```

- [ ] **Step 2: Prefill from `ai_verdict` in `openMasteryCheck`**

Replace `growth-map.html:2163-2171`:

```javascript
function openMasteryCheck(gk,sk){
 if(CURGK!==gk||CURSK!==sk||!CURWS){toast('Press “Make worksheet” first, mark it against the answer key, then Done.');return;}
 MGK=gk;MSK=sk;MTOTAL=wsQuestionCount(CURWS)||1;
 document.getElementById('mTotal').textContent=MTOTAL;
 const need=Math.ceil(MTOTAL*MASTERY_PASS);
 document.getElementById('mNeed').textContent='Need '+need+'/'+MTOTAL+' ('+Math.round(MASTERY_PASS*100)+'%+) to level up. Below that → fresh practice sheet at the same level.';
 const input=document.getElementById('mCorrect');input.max=MTOTAL;input.value=0;
 document.getElementById('masteryOverlay').style.display='flex';
}
```

with:

```javascript
function openMasteryCheck(gk,sk){
 if(CURGK!==gk||CURSK!==sk||!CURWS){toast('Press “Make worksheet” first, mark it against the answer key, then Done.');return;}
 MGK=gk;MSK=sk;MTOTAL=wsQuestionCount(CURWS)||1;
 document.getElementById('mTotal').textContent=MTOTAL;
 const need=Math.ceil(MTOTAL*MASTERY_PASS);
 document.getElementById('mNeed').textContent='Need '+need+'/'+MTOTAL+' ('+Math.round(MASTERY_PASS*100)+'%+) to level up. Below that → fresh practice sheet at the same level.';
 const input=document.getElementById('mCorrect'),aiNote=document.getElementById('mAiNote');
 input.max=MTOTAL;input.value=0;aiNote.style.display='none';
 document.getElementById('masteryOverlay').style.display='flex';
 if(CURSHEETID)prefillFromAiVerdict(CURSHEETID,input,aiNote,MTOTAL);
}
async function prefillFromAiVerdict(sheetId,input,aiNote,mtotal){
 try{
  const {data,error}=await sb.from('sheets').select('ai_verdict').eq('id',sheetId).single();
  if(error||!data||!data.ai_verdict)return; /* no photo uploaded / not graded yet / offline — input stays at 0, exactly today's behavior */
  const v=data.ai_verdict;
  const est=Math.max(0,Math.min(mtotal,parseInt(v.estimated_correct,10)||0));
  input.value=est;
  aiNote.textContent='🤖 AI read: '+est+'/'+mtotal+(v.note?' — '+v.note:'')+'. Adjust the number if needed, then confirm.';
  aiNote.style.display='block';
 }catch(e){/* offline — input stays at 0 */}
}
```

- [ ] **Step 3: Verify**

Via Playwright: use the sheet from Task 7's test (already graded — `ai_verdict` populated). Navigate to that kid/subject, the app auto-generates a fresh sheet on load though (no `CURSHEETID` match) — so instead: click "Make worksheet" (creates a new ungraded sheet, `CURSHEETID` set to it, `ai_verdict` null), open the mastery modal (click "✓ Done — level up"), confirm `mCorrect` stays at 0 and no AI note shows (expected — this fresh sheet has no photo/grade yet). Then manually run Task 6+7's upload+grade flow against this exact new sheet, re-open the mastery modal (close and reopen "✓ Done — level up"), confirm `mCorrect` is now prefilled and the AI note is visible.

- [ ] **Step 4: Commit**

```bash
git add growth-map.html
git commit -m "feat: prefill mastery-check count from AI grading verdict

Falls back to today's manual 0-start behavior whenever there's no
photo, no grade yet, or the request fails.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Award points on mastery confirm

**Files:**
- Modify: `growth-map.html:2173-2180` (`confirmMastery`)

**Interfaces:**
- Consumes: `CURSHEETID` (Task 4), `points_ledger`/`sheets` tables.
- Produces: writes one `points_ledger` row and marks the sheet `approved` — the Wallet UI (Task 5) picks this up on its next `refreshWalletCache`.

- [ ] **Step 1: Award points alongside the existing level-up logic**

Replace `growth-map.html:2173-2180`:

```javascript
function confirmMastery(){
 const gk=MGK,sk=MSK;if(!gk||!sk)return;
 const correct=Math.max(0,Math.min(MTOTAL,parseInt(document.getElementById('mCorrect').value,10)||0));
 const need=Math.ceil(MTOTAL*MASTERY_PASS);
 closeMasteryCheck();
 if(correct>=need){doDoneLevelUp(gk,sk);}
 else{makeWS(gk,sk);toast('Not yet — '+correct+'/'+MTOTAL+' (needed '+need+'+). Fresh sheet at the same level — practice again.');}
}
```

with:

```javascript
function confirmMastery(){
 const gk=MGK,sk=MSK;if(!gk||!sk)return;
 const correct=Math.max(0,Math.min(MTOTAL,parseInt(document.getElementById('mCorrect').value,10)||0));
 const need=Math.ceil(MTOTAL*MASTERY_PASS);
 const sheetId=CURSHEETID;
 closeMasteryCheck();
 if(sheetId)awardPoints(gk,sheetId,correct); /* points post on every confirm — a partial-credit sheet still earns partial points, independent of whether it also cleared the level-up bar */
 if(correct>=need){doDoneLevelUp(gk,sk);}
 else{makeWS(gk,sk);toast('Not yet — '+correct+'/'+MTOTAL+' (needed '+need+'+). Fresh sheet at the same level — practice again.');}
}
async function awardPoints(gk,sheetId,correct){
 try{
  await sb.from('points_ledger').insert({kid:gk,delta:correct,reason:sheetId});
  await sb.from('sheets').update({status:'approved',points_awarded:correct,final_verdict:{correct},reviewed_at:new Date().toISOString()}).eq('id',sheetId);
  await refreshWalletCache(gk);
  toast('⭐ +'+correct+' points!');
 }catch(e){toast('Points couldn\'t be saved — check your connection and try again from the Wallet screen.');}
}
```

- [ ] **Step 2: Verify**

Via Playwright, using the same graded sheet from Task 8's test: open the mastery modal (AI-prefilled), adjust the number if desired, click "✓ Confirm & level up". Confirm the toast shows "⭐ +N points!". Then:

```sql
select delta, reason from points_ledger order by created_at desc limit 1;
select status, points_awarded from sheets where id = '<the test sheet id>';
```

Expect the ledger row's `delta` to match the confirmed count and `reason` to equal the sheet id; the sheet's `status='approved'` and `points_awarded` set. Navigate to that kid's Wallet subtab — confirm the balance ring now shows the awarded points and the history list shows the new entry.

- [ ] **Step 3: Commit**

```bash
git add growth-map.html
git commit -m "feat: award points on mastery confirm

Points post on every confirm regardless of whether the 80% level-up
threshold was cleared — a partial-credit sheet still earns partial
points.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Payout button

**Files:**
- Modify: `growth-map.html` — add `payout(gk)` function near the wallet helpers (Task 5's block)

**Interfaces:**
- Consumes: `getBalance(gk)`, `points_ledger` table.
- Produces: inserts a `-balance` ledger row, never deletes history. `data-act="payout"` case already wired in Task 6 Step 2.

- [ ] **Step 1: Add the payout function**

Insert right after `renderWallet` (end of the block added in Task 5 Step 1):

```javascript
async function payout(gk){
 await refreshWalletCache(gk);
 const bal=getBalance(gk);
 if(bal<=0){toast('Nothing owed right now.');return;}
 if(!confirm('Mark '+DATA[gk].name+'\'s '+bal+' points as paid out? This resets the balance to 0 (history stays, for the record).'))return;
 try{
  await sb.from('points_ledger').insert({kid:gk,delta:-bal,reason:'payout'});
  await refreshWalletCache(gk);
  toast('💸 Paid out — balance reset to 0.');
  const active=document.querySelector('#subtabs-'+gk+' .subtab[data-sk="wallet"]');
  if(active)renderWallet(gk);
 }catch(e){toast('Payout couldn\'t be saved — check your connection.');}
}
```

- [ ] **Step 2: Verify**

Via Playwright, on the kid with points from Task 9's test: go to Wallet subtab, click "💸 Paid out — reset to 0" (the browser's native `confirm()` dialog appears — Playwright: use `mcp__plugin_playwright_playwright__browser_handle_dialog` to accept it). Confirm balance ring goes to 0 and the history list shows a new negative entry labeled "Paid out". Then:

```sql
select delta, reason from points_ledger where kid = '<gk>' order by created_at desc limit 1;
```

Expect `delta` negative, `reason='payout'`. Confirm the previous positive-delta row from Task 9 is still present (`select * from points_ledger where kid='<gk>' order by created_at;` — both rows exist, nothing deleted).

- [ ] **Step 3: Commit**

```bash
git add growth-map.html
git commit -m "feat: payout button resets balance to 0, keeps ledger history

Confirmation prompt before payout. Never deletes rows — a payout is
a new -balance ledger entry, so past payouts stay auditable.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Kid read-only wallet view

**Files:**
- Modify: `growth-map.html` — add a `KID_VIEW` check near the top of the script and gate the two wallet-mutating buttons in `walletHTML`

**Interfaces:**
- Consumes: `location.search` (new — first use of query params in this app; `location.hash` remains the state-persistence channel from Task 2, untouched).
- Produces: `KID_VIEW` global (`null` normally, or `'sarah'`/`'mirayah'` when `?kid=sarah`/`?kid=mirayah` is present in the URL).

- [ ] **Step 1: Detect kid-view mode**

Insert near the top of the script, right after the `/* ===== helpers ===== */` block (after `growth-map.html:146`):

```javascript
const KID_VIEW=(()=>{
 const p=new URLSearchParams(location.search).get('kid');
 return (p==='sarah'||p==='mirayah')?p:null;
})();
```

- [ ] **Step 2: Hide upload/payout buttons in kid-view mode**

In `walletHTML` (added in Task 5 Step 1), replace:

```javascript
 h+='<div class="actions" style="justify-content:center;margin-bottom:16px">'
  +'<button class="btn primary" data-act="uploadPhotoPrompt" data-gk="'+gk+'">📷 Upload today\'s sheet</button>'
  +'<button class="btn" data-act="payout" data-gk="'+gk+'">💸 Paid out — reset to 0</button>'
  +'</div>';
```

with:

```javascript
 if(!KID_VIEW)h+='<div class="actions" style="justify-content:center;margin-bottom:16px">'
  +'<button class="btn primary" data-act="uploadPhotoPrompt" data-gk="'+gk+'">📷 Upload today\'s sheet</button>'
  +'<button class="btn" data-act="payout" data-gk="'+gk+'">💸 Paid out — reset to 0</button>'
  +'</div>';
```

(Kid-view still shows the ring, streak, and history — just not the two mutating buttons, matching the earlier "for now read only works" scope: hide wallet-mutating controls only, leave the rest of the app — including "✓ Done — level up" on subject panels — untouched.)

- [ ] **Step 3: Auto-open the Wallet subtab when in kid-view**

At the very end of INIT (after the `pullAndMergeCloud();` call added in Task 2 Step 5), add:

```javascript
if(KID_VIEW){
 const topBtn=document.querySelector('.tab[data-pane="'+KID_VIEW+'"]');if(topBtn)topBtn.click();
 setTimeout(()=>{const wb=document.querySelector('#subtabs-'+KID_VIEW+' .subtab[data-sk="wallet"]');if(wb)wb.click();},50);
}
```

(A short `setTimeout` is needed because `buildGirl` — which creates the Wallet subtab button — runs synchronously right before this, but `pullAndMergeCloud()` is async and may re-render the subtabs shortly after; 50ms is enough to land after the initial synchronous build without waiting on the network call.)

- [ ] **Step 4: Verify**

Via Playwright: navigate to `growth-map.html?kid=sarah`. Confirm: the page opens directly on Sarah's Wallet subtab, the ring/streak/history render, and neither "Upload today's sheet" nor "Paid out — reset to 0" appears. Confirm the rest of the app (other tabs, "✓ Done — level up" on Maths/Science/English) is fully functional if the kid clicks around — the scope is wallet-only, not a full app-wide lockdown.

- [ ] **Step 5: Commit**

```bash
git add growth-map.html
git commit -m "feat: kid read-only wallet view via ?kid=sarah / ?kid=mirayah

Hides upload/payout controls on the Wallet screen only; rest of the
app is unaffected. Auto-opens straight to that kid's Wallet subtab.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end verification + decisions log

**Files:**
- Modify: `~/CLAUDE.md` (Decisions Log — per this environment's house rule 12, update immediately after the feature ships)

**Interfaces:**
- No code interfaces — this is the final verification + documentation pass.

- [ ] **Step 1: Full happy-path E2E via Playwright**

1. Navigate to `growth-map.html`.
2. Sarah → Maths → "Make worksheet" (confirms `sheets` row created, Task 4).
3. "📷 Upload photo" with a test image showing plausible handwritten answers (Task 6).
4. Wait for the "✅ Graded" toast (Task 7).
5. "✓ Done — level up" → confirm the modal shows an AI-prefilled count + note (Task 8).
6. Adjust the count if desired, "✓ Confirm & level up" → confirm the "+N points!" toast (Task 9) and (if the count cleared 80%) the level-up toast.
7. Sarah's Wallet subtab → confirm balance/streak/history reflect the confirm.
8. "💸 Paid out — reset to 0" → confirm the dialog, confirm balance resets, confirm ledger history still shows both entries.
9. Open a second browser tab (or `mcp__plugin_playwright_playwright__browser_tabs` new tab) to the same file — confirm the balance/level-up state matches tab 1 (cross-device sync, Task 2).
10. Navigate to `growth-map.html?kid=sarah` in a third tab — confirm read-only wallet view (Task 11).

- [ ] **Step 2: Failure-path check — AI grading unavailable**

Manually break the grading path (e.g. temporarily rename the `ANTHROPIC_API_KEY` secret via `supabase secrets unset` on a scratch/test invocation, or directly test against a sheet whose photo was never uploaded) and confirm: `sheets.status` still reaches `pending_review`, `mCorrect` still opens at 0 in the mastery modal (no AI note shown), and the parent can still grade and confirm points entirely by hand — nothing blocks on AI availability. Restore the secret afterward if it was removed.

- [ ] **Step 3: Regression check on existing features**

Confirm lane subjects (Swimming/Music/Riding/Madhurim) still level up via the honest-system `doDoneLevelUp` path with no mastery modal, no points, no photo-upload button (the `acad` gate in Task 6 Step 3 excludes them). Confirm the English book-ladder flow (`finishBook`/`nextBook`) is untouched. Confirm printed worksheets (`printWS`) still render on the original plain styling, unaffected by the Task 3 reskin.

- [ ] **Step 4: Clean up all test data**

```sql
delete from points_ledger;
delete from sheets;
delete from storage.objects where bucket_id = 'sheet-photos';
delete from state where key = 'family';
```

Run with zero browser tabs open against the live Supabase project (an open tab's realtime subscription would otherwise re-push a stale value). This clears every test artifact so the family's real first use starts from a clean slate.

- [ ] **Step 5: Update the Decisions Log in `~/CLAUDE.md`**

Add a new row to the Decisions Log table (this repo's `CLAUDE.md` covers Stocks; the growth-map decisions log lives in memory, not that file — add the entry to memory instead, per this session's existing pattern):

Update `[[project_growth_map_points]]` memory (`~/.claude/projects/-Users-shalabhgupta/memory/project_growth_map_points.md`) — replace the "Next step is `writing-plans`..." line with a summary that implementation shipped: which tasks landed, the live Wallet URL pattern (`growth-map.html?kid=sarah` / `?kid=mirayah`), and the final Supabase schema (`sheets`, `points_ledger`, `sheet-photos` bucket, `grade-sheet` function) — so a future session doesn't have to re-derive it from git history the way this session had to for the reverted sync feature.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: points gamification + reskin feature complete

All 12 plan tasks landed and verified end-to-end: cross-device sync
restored, full-site Hybrid Zen-Play reskin, worksheet+answer-key
persistence, AI-assisted photo grading via a Supabase Edge Function
and Claude Opus 5 structured outputs, points ledger wired into the
existing mastery-check flow, payout button, kid read-only view.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** every spec section has a task — data model (Task 1), backend grading (Task 7), flow steps 1-7 (Tasks 4, 6, 8, 9, 5/10, 11), reskin (Task 3), error handling (Task 7 Step 1's `pending_review`-on-failure path + Task 12 Step 2), testing approach (every task's own verify step + Task 12).
- **Type consistency checked:** `CURSHEETID` (Task 4) is read identically in Tasks 6, 8, 9. `ai_verdict` shape `{estimated_correct, note}` (Task 7) matches exactly what Task 8 reads (`v.estimated_correct`, `v.note`). `points_ledger.reason` stores the sheet's UUID string for a sheet-grading row and the literal `'payout'` for a payout row — consistent across Tasks 9 and 10, and `getStreak`/`walletHTML` (Task 5) only special-case the `'payout'` string, everything else renders as "Sheet graded."
- **No placeholders:** every task has real, complete code — no `// TODO` or "implement later" left anywhere.
