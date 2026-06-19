// Threads 配信スクリプト（GitHub Actions版・キャッチアップ方式・投稿漏れゼロ優先）
// - トークン/USER_IDは環境変数(GitHub Secrets)から取得
// - 予定時刻(JST)を過ぎた未投稿を全て配信（時刻ゲートなし・スキップなし）
// - 二重投稿防止: 状態ファイル + Threads既存投稿の本文照合
// - 失敗(network/api/token)は retry_pending で保持し次回再試行
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
// ローカルテスト用に .env.local があれば読む（Actionsでは存在しない＝Secretsを使う）
const ENV = join(__dir, '.env.local');
if (existsSync(ENV)) for (const l of readFileSync(ENV,'utf8').split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}

const TOKEN=process.env.THREADS_ACCESS_TOKEN, USER_ID=process.env.THREADS_USER_ID;
const API='https://graph.threads.net/v1.0';
const START_DATE='2026-06-19';                 // day1（JST基準）
const SLOT_HOUR={ '08':8, '12':12, '19':19, '22':22 };
const QUEUE=join(__dir,'data','phase1_12.json');
const STATE=join(__dir,'data','phase1_state.json');
const LOG=join(__dir,'data','phase1_delivery_log.csv');

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// JST(+09:00)固定で予定時刻を計算（UTCランナーでも正しく動く）
function scheduledMs(p){ return new Date(START_DATE+'T00:00:00+09:00').getTime() + (Number(p.day)-1)*86400000 + (SLOT_HOUR[p.time_slot]||0)*3600000; }

function loadState(){
  let st={};
  if(existsSync(STATE)) st=JSON.parse(readFileSync(STATE,'utf8'));
  if(existsSync(LOG)) for(const line of readFileSync(LOG,'utf8').trim().split('\n').slice(1)){
    const c=line.split(','); const id=(c[0]||'').replace(/"/g,''); const media=(c[3]||'').replace(/"/g,'');
    if(id && !st[id]) st[id]={status:'posted',media_id:media,retry_count:0};
  }
  return st;
}
const saveState=(st)=>writeFileSync(STATE, JSON.stringify(st,null,2),'utf8');
function logRow(p,media,permalink,note){
  if(!existsSync(LOG)) writeFileSync(LOG,'post_id,ab,keyword,media_id,permalink,posted_at,note\n','utf8');
  appendFileSync(LOG,`"${p.post_id}","${p.ab}","${p.keyword}","${media}","${permalink}","${new Date().toISOString()}","${note||''}"\n`);
}
async function api(path,params,method='GET'){
  try{
    const url=new URL(API+path); const body=new URLSearchParams({...params,access_token:TOKEN});
    const opt=method==='GET'?{}:{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body};
    if(method==='GET')for(const[k,v]of body)url.searchParams.set(k,v);
    const res=await fetch(url,opt); const json=await res.json().catch(()=>({}));
    return {ok:res.ok,status:res.status,json};
  }catch(e){ return {ok:false,status:0,json:{},networkError:String(e.message||e)}; }
}
function classifyError(r){
  if(r.networkError) return {type:'network', msg:r.networkError};
  const m=JSON.stringify(r.json||{});
  if(r.status===401 || /oauth|access token|expired|access blocked|code\":\s*(190|200)/i.test(m)) return {type:'token', msg:m.slice(0,200)};
  return {type:'api', msg:`status=${r.status} ${m.slice(0,200)}`};
}
async function recentTexts(){
  const r=await api(`/${USER_ID}/threads`,{fields:'id,text',limit:'25'});
  if(!r.ok || !r.json.data) return null;
  const map=new Map(); for(const x of r.json.data) if(x.text) map.set(x.text.trim(), x.id);
  return map;
}
async function deliverOne(p, st, recent){
  if(st[p.post_id]?.status==='posted'){ console.log(`skip(posted): ${p.post_id}`); return; }
  if(recent && recent.has(p.body.trim())){
    const media=recent.get(p.body.trim());
    st[p.post_id]={status:'posted',media_id:media,retry_count:(st[p.post_id]?.retry_count||0),posted_at:new Date().toISOString(),note:'dedup-existing'};
    logRow(p,media,'','dedup-existing'); saveState(st);
    console.log(`skip(既存検出→posted): ${p.post_id} media=${media}`); return;
  }
  const create=await api(`/${USER_ID}/threads`,{media_type:'TEXT',text:p.body},'POST');
  if(!create.ok){ const e=classifyError(create); st[p.post_id]={status:'retry_pending',retry_count:(st[p.post_id]?.retry_count||0)+1,last_error:`create/${e.type}: ${e.msg}`}; saveState(st); console.log(`⚠️ retry_pending(${e.type}) ${p.post_id} [create]`); return; }
  const pub=await api(`/${USER_ID}/threads_publish`,{creation_id:create.json.id},'POST');
  if(!pub.ok){ const e=classifyError(pub); st[p.post_id]={status:'retry_pending',retry_count:(st[p.post_id]?.retry_count||0)+1,last_error:`publish/${e.type}: ${e.msg}`}; saveState(st); console.log(`⚠️ retry_pending(${e.type}) ${p.post_id} [publish]`); return; }
  const media=pub.json.id;
  st[p.post_id]={status:'posted',media_id:media,retry_count:(st[p.post_id]?.retry_count||0),posted_at:new Date().toISOString()};
  saveState(st);
  const chk=await api(`/${media}`,{fields:'permalink'});
  const permalink=chk.ok?(chk.json.permalink||''):'';
  logRow(p,media,permalink,'posted');
  console.log(`✅ posted ${p.post_id} ${p.ab}[${p.keyword}] media=${media} ${permalink}`);
}

(async()=>{
  if(!TOKEN||!USER_ID){ console.error('❌ THREADS_ACCESS_TOKEN / THREADS_USER_ID 未設定'); process.exit(1); }
  const queue=JSON.parse(readFileSync(QUEUE,'utf8'));
  const st=loadState();
  const now=Date.now();
  const due=queue.filter(p=>scheduledMs(p)<=now && st[p.post_id]?.status!=='posted')
                 .sort((a,b)=>scheduledMs(a)-scheduledMs(b));
  console.log(`[${new Date().toISOString()}] due(未投稿で予定時刻超過)=${due.length}件`);
  if(due.length===0){ console.log('配信対象なし。'); saveState(st); return; }
  const recent=await recentTexts();
  if(recent===null) console.log('※既存投稿の取得不可（ガードBスキップ・状態ファイルで二重投稿防止）');
  for(const p of due){ await deliverOne(p, st, recent); await sleep(2000); }
  console.log('完了。');
})();
