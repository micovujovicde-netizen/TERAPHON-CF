// TERAPHON separate licensing Worker; adapted from the user-supplied BrakeMonster v4 flow.
// DO NOT deploy over BrakeMonster. Use a separate D1 and Worker route, and TERAPHON Creem products.
// Before allowing purchases, create three new Creem products and configure the env variables.
// This file is a prepared integration, not a claim that any real checkout was tested.
function configuredProducts(env) {
  return Object.freeze({
    monthly: env.TERA_PRODUCT_MONTHLY || 'prod_g1lpJZPJbfKTkhr8qiqbn',
    yearly: env.TERA_PRODUCT_YEARLY || 'prod_6cQTQHjizsAhj9BAkvJoIn',
    lifetime: env.TERA_PRODUCT_LIFETIME || 'prod_6fnL2AfTLkXb9WU1BYDZzL',
  });
}
function planMap(products) { return new Map(Object.entries(products).map(([k,v]) => [v,k])); }
function productsReady(env) {
  const ids = Object.values(configuredProducts(env));
  return ids.every(v => /^prod_[A-Za-z0-9]+$/.test(v)) && new Set(ids).size === 3;
}
const KNOWN_EVENTS = new Set(['subscription.paid', 'subscription.canceled',
  'subscription.expired', 'subscription.active', 'subscription.update',
  'subscription.paused', 'subscription.trialing', 'checkout.completed',
  'refund.created', 'dispute.created']);
const WRITE_EVENTS = new Set(['subscription.paid', 'subscription.canceled',
  'checkout.completed', 'refund.created', 'dispute.created']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }});
}
function str(v, max = 1000) {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}
function id(v) { return str(typeof v === 'string' ? v : v?.id); }
function dateISO(v) {
  if (typeof v !== 'string') return null;
  const millis = Date.parse(v);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}
function customer(obj) { return id(obj?.customer) || id(obj?.order?.customer); }
function email(obj) { return str(obj?.customer?.email, 320); }
function product(obj) { return id(obj?.product) || id(obj?.order?.product) || id(obj?.subscription?.product); }
function testPayload(ev, obj) {
  // Check all known Creem sample/test markers *after signature verification*.
  const items = [ev, obj, obj?.order, obj?.subscription, obj?.customer,
    obj?.transaction, obj?.product];
  for (const v of items) {
    if (!v || typeof v !== 'object') continue;
    if (v.test === true || v.test_mode === true || v.is_test === true) return true;
    if (typeof v.mode === 'string' && ['test', 'sandbox'].includes(v.mode.toLowerCase())) return true;
    if (typeof v.environment === 'string' && ['test', 'sandbox'].includes(v.environment.toLowerCase())) return true;
    if (typeof v.id === 'string' && /^(?:evt|ch|ord|sub|tran|txn|cust|ref|disp)_test(?:_|$)/i.test(v.id)) return true;
  }
  return false;
}
async function signatureValid(raw, supplied, secret) {
  if (!secret || typeof secret !== 'string' || typeof supplied !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(supplied.trim())) return false;
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', bytes.encode(secret),
    {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const calc = new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes.encode(raw)));
  const theirs = supplied.trim().match(/../g).map(hex=>parseInt(hex,16));
  let delta=0; for (let i=0;i<32;i++) delta |= calc[i]^theirs[i];
  return delta === 0;
}
// Client receives a 256-bit random installation token. Only its SHA-256 is stored server-side.
function bearer(request) {
  const auth=request.headers.get('Authorization')||'';
  const match=/^Bearer ([0-9a-f]{64})$/.exec(auth);
  return match ? match[1] : null;
}
async function deviceHash(token) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
const SITE_ORIGINS=new Set(['https://teraphonia.com','https://www.teraphonia.com']);
function withCors(response,request) {
  const origin=request.headers.get('Origin');
  if (!origin || !SITE_ORIGINS.has(origin)) return response;
  const headers=new Headers(response.headers);
  headers.set('access-control-allow-origin',origin);
  headers.set('access-control-allow-methods','GET, POST, OPTIONS');
  headers.set('access-control-allow-headers','Authorization, Content-Type');
  headers.set('vary','Origin');
  return new Response(response.body,{status:response.status,headers});
}
function billingOn(env) { return env.BILLING_ENABLED === 'true' && Boolean(env.CREEM_API_KEY) && Boolean(env.CREEM_WEBHOOK_SECRET) && Boolean(env.DB) && productsReady(env); }
async function entitlement(db,hash,products) {
  const rows=await db.prepare(`SELECT l.status,l.expires_at,l.product_id
    FROM licenses l INNER JOIN license_devices d ON d.license_id=l.id
    WHERE d.token_hash=?1`).bind(hash).all();
  const now=Date.now(); let validUntil=0; let type='inactive'; let activePlan='free';
  for (const r of rows.results||[]) {
    if(r.status==='lifetime' && r.product_id===products.lifetime) {
      return {active:true,validUntil:253402300799000,plan:'lifetime',entitlementType:'lifetime',status:'Lifetime'};
    }
    if(!['active','canceled'].includes(r.status) ||
        ![products.monthly,products.yearly].includes(r.product_id)) continue;
    const until=Date.parse(r.expires_at||'');
    if(Number.isFinite(until) && until>now && until>validUntil) {
      validUntil=until;type=r.status==='canceled'?'Canceled — access until paid period ends':'Active';
      activePlan = r.product_id === products.yearly ? 'yearly' : 'monthly';
    }
  }
  return {active:validUntil>now,validUntil,plan:activePlan,entitlementType:validUntil>now?'paid':'free',status:type};
}
const TRIAL_MS = 7 * 86_400_000;
async function trialEntitlement(db, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint || ''))
    return {active:false,validUntil:0,plan:'free',entitlementType:'free',status:'No trial identity'};
  const now = Date.now();
  await db.prepare('INSERT OR IGNORE INTO teraphon_trial_devices (device_fingerprint,first_seen_ms) VALUES (?1,?2)')
    .bind(fingerprint,now).run();
  const row = await db.prepare('SELECT first_seen_ms FROM teraphon_trial_devices WHERE device_fingerprint=?1')
    .bind(fingerprint).first();
  const start = Number(row?.first_seen_ms);
  const until = Number.isSafeInteger(start) && start > 0 ? start + TRIAL_MS : 0;
  return until > now
    ? {active:true,validUntil:until,plan:'trial',entitlementType:'trial',status:'7-day TERAPHON trial'}
    : {active:false,validUntil:0,plan:'free',entitlementType:'free',status:'7-day trial ended'};
}


// Three-device activation, isolated to TERAPHON. Codes are stored AES-GCM encrypted;
// server key stays in a Cloudflare secret (ACTIVATION_ENCRYPTION_KEY).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function normalizedActivationCode(value) {
  if (typeof value !== 'string') return null;
  const canonical=value.toUpperCase().replace(/[\s-]/g,'');
  return /^TP1[0-9A-HJKMNP-TV-Z]{26}$/.test(canonical) ? canonical : null;
}
async function sha256(input) {
  const bytes=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
}
function generateActivationCode() {
  const random=crypto.getRandomValues(new Uint8Array(26));
  const text=Array.from(random,v=>CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
  return 'TP1'+text;
}
function displayActivationCode(raw) {
  const text=raw.slice(3);
  return 'TP1-'+[text.slice(0,5),text.slice(5,10),text.slice(10,15),text.slice(15,20),text.slice(20)].join('-');
}
async function activationKey(env) {
  const b64=env.ACTIVATION_ENCRYPTION_KEY;
  if (typeof b64!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw new Error('Activation secret missing');
  const raw=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  if(raw.length!==32) throw new Error('Wrong activation key length');
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unb64(str) { return Uint8Array.from(atob(str),c=>c.charCodeAt(0)); }
async function protectCode(env,raw) {
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},await activationKey(env),new TextEncoder().encode(raw));
  return {nonce:b64(nonce),cipher:b64(new Uint8Array(encrypted))};
}
async function restoreCode(env,record) {
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(record.code_nonce)},
    await activationKey(env),unb64(record.code_cipher));
  const code=new TextDecoder().decode(bytes);
  if (!normalizedActivationCode(code) || await sha256(code)!==record.code_hash) throw new Error('Activation code corrupted');
  return code;
}
function licensed(row,products) {
  if(!row) return false;
  if(row.status==='lifetime') return row.product_id===products.lifetime;
  return ['active','canceled'].includes(row.status) &&
    [products.monthly,products.yearly].includes(row.product_id) &&
    Date.parse(row.expires_at||'')>Date.now();
}
async function installedPaidLicense(db,hash,products) {
  const rows=await db.prepare(`SELECT l.id,l.product_id,l.status,l.expires_at,l.last_event_ms
    FROM licenses l INNER JOIN license_devices d ON l.id=d.license_id
    WHERE d.token_hash=?1 ORDER BY l.last_event_ms DESC`).bind(hash).all();
  return (rows.results||[]).find(row=>licensed(row,products))||null;
}
async function usedSlots(db,licenseId) {
  const row=await db.prepare('SELECT COUNT(*) AS used FROM license_devices WHERE license_id=?1')
    .bind(licenseId).first();
  return Number(row?.used||0);
}
async function codeLicense(db,raw,products) {
  const codeHash=await sha256(raw);
  const row=await db.prepare(`SELECT l.id,l.product_id,l.status,l.expires_at
      FROM teraphon_activation_codes c JOIN licenses l ON c.license_id=l.id
      WHERE c.code_hash=?1`).bind(codeHash).first();
  return licensed(row,products)?row:null;
}
async function smallRequest(request) {
  const raw=await request.text();
  if(raw.length>2048) throw new Error('Request too long');
  return JSON.parse(raw);
}
async function activationCodes(request,env,products,method,path) {
  if(!env.DB) return json({error:'D1 missing'},503);
  const token=bearer(request); if(!token) return json({error:'Unauthorized'},401);
  const hash=await deviceHash(token);
  try {
    if(path==='/v1/activation-code' && method==='GET') {
      if(!env.ACTIVATION_ENCRYPTION_KEY) return json({error:'Activation service not configured'},503);
      const license=await installedPaidLicense(env.DB,hash,products);
      if(!license) return json({error:'No active paid TERAPHON license on this device'},404);
      let row=await env.DB.prepare('SELECT * FROM teraphon_activation_codes WHERE license_id=?1')
        .bind(license.id).first();
      if(!row){
        const code=generateActivationCode(); const cipher=await protectCode(env,code);
        await env.DB.prepare(`INSERT OR IGNORE INTO teraphon_activation_codes
          (license_id,code_hash,code_cipher,code_nonce) VALUES(?1,?2,?3,?4)`)
          .bind(license.id,await sha256(code),cipher.cipher,cipher.nonce).run();
        row=await env.DB.prepare('SELECT * FROM teraphon_activation_codes WHERE license_id=?1')
          .bind(license.id).first();
      }
      const code=await restoreCode(env,row);
      return json({code:displayActivationCode(code),deviceLimit:3,used:await usedSlots(env.DB,license.id)});
    }
    if(method!=='POST')return json({error:'Method not allowed'},405);
    let data;try{data=await smallRequest(request)}catch{return json({error:'Invalid JSON'},400)}
    const code=normalizedActivationCode(data?.code);
    if(!code)return json({error:'Invalid activation code'},400);
    const license=await codeLicense(env.DB,code,products);
    if(!license)return json({error:'Invalid or expired TERAPHON license'},403);
    if(path==='/v1/activate') {
      // Atomic insert-if-slot-available prevents parallel activation from exceeding 3 devices.
      await env.DB.prepare(`INSERT OR IGNORE INTO license_devices (license_id,token_hash)
         SELECT ?1,?2 WHERE (SELECT COUNT(*) FROM license_devices WHERE license_id=?1)<3`)
        .bind(license.id,hash).run();
      const mine=await env.DB.prepare(`SELECT token_hash FROM license_devices WHERE license_id=?1 AND token_hash=?2`)
        .bind(license.id,hash).first();
      if(!mine)return json({error:'Three TERAPHON device slots are already occupied'},409);
      return json({active:true,deviceLimit:3,used:await usedSlots(env.DB,license.id)});
    }
    if(path==='/v1/devices' || path==='/v1/release') {
      const rows=(await env.DB.prepare(`SELECT token_hash FROM license_devices WHERE license_id=?1
         ORDER BY created_at ASC,token_hash ASC`).bind(license.id).all()).results||[];
      if(path==='/v1/devices')return json({deviceLimit:3,used:rows.length,
        devices:rows.map((row,i)=>({deviceId:row.token_hash.slice(0,16),slot:i+1,thisDevice:row.token_hash===hash}))});
      if(!/^[a-f0-9]{16}$/.test(data?.deviceId||''))return json({error:'Invalid device ID'},400);
      const target=rows.find(row=>row.token_hash.slice(0,16)===data.deviceId);
      if(!target)return json({error:'Device no longer registered'},404);
      await env.DB.prepare('DELETE FROM license_devices WHERE license_id=?1 AND token_hash=?2')
        .bind(license.id,target.token_hash).run();
      return json({released:true,deviceLimit:3,used:await usedSlots(env.DB,license.id)});
    }
    return json({error:'Not found'},404);
  }catch(error){console.error('TERAPHON activation failure:',String(error?.name||'unknown').slice(0,50));
    return json({error:'Activation temporarily unavailable'},503)}
}

function hashFromMetadata(obj) {
  const values=[obj?.metadata?.tera_device_hash,obj?.subscription?.metadata?.tera_device_hash];
  const val=values.find(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v));
  return val||null;
}
function bindingStatements(db,obj,eventType,productPlan) {
  const hash=hashFromMetadata(obj);
  if (!hash) return [];
  if (!productPlan.has(product(obj))) return [];
  let key=null;
  if(eventType==='subscription.paid') key=id(obj);
  if(eventType==='checkout.completed') {
    if(obj.status!=='completed'||obj?.order?.status!=='paid')return [];
    key=id(obj.subscription)||id(obj.order);
  }
  if (!key) return [];
  return [db.prepare(`INSERT OR IGNORE INTO license_devices
    (license_id,token_hash) VALUES(?1,?2)`).bind(key,hash)];
}
async function checkout(request,env,products) {
  if(!billingOn(env)) return json({error:'Checkout not enabled'},503);
  const rawToken=bearer(request);
  if(!rawToken) return json({error:'Invalid installation credential'},401);
  const raw=await request.text();if(raw.length>2048)return json({error:'Invalid request'},400);
  let input;try{input=JSON.parse(raw)}catch{return json({error:'Invalid JSON'},400)}
  const plan=input?.plan;
  if(!Object.hasOwn(products,plan))return json({error:'Unknown plan'},400);
  const hash=await deviceHash(rawToken);
  const creem=await fetch('https://api.creem.io/v1/checkouts',{
    method:'POST',headers:{'x-api-key':env.CREEM_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({
      product_id:products[plan],units:1,
      request_id:crypto.randomUUID(),
      success_url:'https://teraphonia.com/?purchase=teraphon',
      metadata:{tera_device_hash:hash,tera_origin:'teraphon_android'}
    }),redirect:'manual'
  });
  if(!creem.ok)return json({error:'Checkout provider unavailable'},502);
  const payload=await creem.json();
  let u;try{u=new URL(payload.checkout_url)}catch{return json({error:'Invalid checkout response'},502)}
  if(u.protocol!=='https:'||u.username||u.password||u.port||
    !(u.hostname==='creem.io'||u.hostname.endsWith('.creem.io')))
      return json({error:'Invalid checkout destination'},502);
  return json({url:u.toString()});
}

function eventStatement(db, event, action) {
  // Deliberately NOT INSERT OR IGNORE: duplicate ID causes atomic batch rollback,
  // so concurrent deliveries cannot both commit license changes.
  return db.prepare(`INSERT INTO webhook_events
    (event_id,event_type,status,processed_at)
    VALUES (?1,?2,?3,CURRENT_TIMESTAMP)`)
    .bind(event.id,event.eventType,action);
}
async function isAlreadyHandled(db,eventID) {
  return Boolean(await db.prepare('SELECT event_id FROM webhook_events WHERE event_id=?1')
    .bind(eventID).first());
}
async function saveEvent(db,event,action,changes=[]) {
  // Atomic D1 transaction: all license changes OR none are committed.
  await db.batch([...changes,eventStatement(db,event,action)]);
  return json({received:true,action});
}
function stmtPaid(db,obj,ms,productPlan) {
  const plan = productPlan.get(product(obj));
  if (plan !== 'monthly' && plan !== 'yearly') return {action:'unmatched_product',sql:[]};
  const subId=id(obj), custId=customer(obj), expires=dateISO(obj.current_period_end_date),
    txn=id(obj.last_transaction_id);
  // Grant only on a signed *paid* event with known product, customer and expiry.
  if (!subId || !custId || !expires || !txn || !['active','scheduled_cancel','canceled'].includes(obj.status))
    return {error:'Incomplete subscription.paid — requires verified transaction and period'};
  const s=db.prepare(`INSERT INTO licenses
    (id,creem_customer_id,creem_subscription_id,product_id,customer_email,
      status,expires_at,last_event_ms,last_paid_transaction_id,updated_at)
    VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?8,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      creem_customer_id=excluded.creem_customer_id,
      product_id=excluded.product_id,
      customer_email=COALESCE(excluded.customer_email, licenses.customer_email),
      status='active',expires_at=excluded.expires_at,
      last_event_ms=excluded.last_event_ms,
      last_paid_transaction_id=excluded.last_paid_transaction_id,
      updated_at=CURRENT_TIMESTAMP
    WHERE excluded.last_event_ms > licenses.last_event_ms AND
      (licenses.status != 'revoked' OR
       excluded.last_paid_transaction_id IS NOT licenses.last_paid_transaction_id)`)
    .bind(subId,custId,subId,product(obj),email(obj),expires,ms,txn);
  const transaction=db.prepare(`INSERT OR IGNORE INTO license_transactions
    (transaction_id,license_id) VALUES (?1,?2)`).bind(txn,subId);
  return {action:'paid',sql:[s,transaction]};
}
function stmtLifetime(db,obj,ms,products) {
  if (product(obj)!==products.lifetime) return {action:'unmatched_product',sql:[]};
  const order=obj.order, orderID=id(order), customerID=customer(obj),
    txn=id(order?.transaction)||id(obj.transaction);
  if (obj.status !== 'completed' || order?.status !== 'paid' || !orderID || !customerID)
    return {error:'Incomplete paid Lifetime checkout'};
  const upsert=db.prepare(`INSERT INTO licenses
    (id,creem_customer_id,creem_order_id,product_id,customer_email,status,
      expires_at,last_event_ms,last_paid_transaction_id,updated_at)
    VALUES (?1,?2,?3,?4,?5,'lifetime',NULL,?6,?7,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      creem_customer_id=excluded.creem_customer_id,
      customer_email=COALESCE(excluded.customer_email,licenses.customer_email),
      product_id=excluded.product_id, status='lifetime', expires_at=NULL,
      last_event_ms=excluded.last_event_ms,
      last_paid_transaction_id=COALESCE(excluded.last_paid_transaction_id,licenses.last_paid_transaction_id),
      updated_at=CURRENT_TIMESTAMP
    WHERE excluded.last_event_ms>licenses.last_event_ms AND licenses.status!='revoked'`)
    .bind(orderID,customerID,orderID,products.lifetime,email(obj),ms,txn);
  const sql=[upsert];
  if (txn) sql.push(db.prepare(`INSERT OR IGNORE INTO license_transactions
    (transaction_id,license_id) VALUES(?1,?2)`).bind(txn,orderID));
  return {action:txn?'lifetime_paid':'lifetime_paid_transaction_link_missing',sql};
}
function stmtCanceled(db,obj,ms) {
  const subId=id(obj), end=dateISO(obj.current_period_end_date);
  if (!subId || !end) return {error:'Incomplete cancellation'};
  // Do not remove paid access on cancellation; it remains valid until expiry.
  const sql=[db.prepare(`UPDATE licenses SET status='canceled',
      expires_at=CASE WHEN expires_at IS NULL OR expires_at<?1 THEN ?1 ELSE expires_at END,
      last_event_ms=?2,updated_at=CURRENT_TIMESTAMP
    WHERE creem_subscription_id=?3 AND last_event_ms<?2 AND status!='revoked'`)
    .bind(end,ms,subId)];
  return {action:'canceled_until_period_end',sql};
}
async function stmtReversal(db,type,obj,ms) {
  const txn=id(obj?.transaction), sub=id(obj?.subscription);
  // Partial refunds need a human assessment; don't revoke an unrelated renewal.
  if (type==='refund.created' && obj?.transaction?.status!=='refunded')
    return {action:'partial_refund_needs_review',sql:[]};
  if (!txn) return {action:'reversal_missing_transaction_needs_review',sql:[]};
  const linked=await db.prepare(`SELECT id,last_paid_transaction_id,creem_subscription_id,product_id
    FROM licenses WHERE last_paid_transaction_id=?1
    LIMIT 1`).bind(txn).first();
  if (!linked || (sub && linked.creem_subscription_id && sub!==linked.creem_subscription_id))
    return {action:'unmatched_or_historical_transaction_needs_review',sql:[]};
  const revokedAt=new Date(ms).toISOString();
  return {action:type==='refund.created'?'refunded_revoke':'disputed_revoke',sql:[
    db.prepare(`UPDATE licenses SET status='revoked',expires_at=?1,
      last_event_ms=?2,updated_at=CURRENT_TIMESTAMP
      WHERE id=?3 AND last_paid_transaction_id=?4 AND last_event_ms<?2`)
      .bind(revokedAt,ms,linked.id,txn)
  ]};
}

export default {
  async fetch(request,env) {
    const u=new URL(request.url);
    const products=configuredProducts(env);
    const productPlan=planMap(products);
    if (u.pathname==='/' && request.method==='GET') {
      return json({service:'TERAPHON Licensing',status:'online',
        webhookConfigured:Boolean(env.CREEM_WEBHOOK_SECRET),
        storageConfigured:Boolean(env.DB),productConfigured:productsReady(env),
        liveWritesEnabled:true,billingEnabled:billingOn(env),version:'teraphon-v1-prepared'});
    }
    // Only our official website can call the licensed checkout via browsers.
    const origin=request.headers.get('Origin');
    if(origin && !SITE_ORIGINS.has(origin)) return json({error:'Origin forbidden'},403);
    if(u.pathname==='/v1/health' && request.method==='GET')
      return withCors(json({status:'online',billingEnabled:billingOn(env),productConfigured:productsReady(env),version:'teraphon-v1-prepared'}),request);
    if(u.pathname==='/v1/license' && request.method==='GET') {
      if(!env.DB)return json({error:'Database unavailable'},503);
      const token=bearer(request);if(!token)return json({error:'Unauthorized'},401);
      try {
        const result=await entitlement(env.DB,await deviceHash(token),products);
        // Paid access takes precedence; trial is bound to a stable app-specific fingerprint.
        if (result.active) return withCors(json(result),request);
        return withCors(json(await trialEntitlement(env.DB,request.headers.get('X-Tera-Trial-Device'))),request);
      } catch(e) {console.error('Entitlement D1 failure');return json({error:'Database unavailable'},503);}
    }
    if(u.pathname==='/v1/checkout' && request.method==='OPTIONS')
      return withCors(new Response(null,{status:204,headers:{'cache-control':'no-store'}}),request);
    if(u.pathname==='/v1/checkout' && request.method==='POST')
      try{return withCors(await checkout(request,env,products),request);}
      catch(e){console.error('Checkout failure');return withCors(json({error:'Checkout unavailable'},503),request);}
    if(['/v1/activation-code','/v1/activate','/v1/devices','/v1/release'].includes(u.pathname))
      return withCors(await activationCodes(request,env,products,request.method,u.pathname),request);
    if(u.pathname==='/v1/portal' && request.method==='POST') {
      if(!billingOn(env) || !env.DB) return json({error:'Portal unavailable'},503);
      const token=bearer(request); if(!token) return json({error:'Unauthorized'},401);
      try {
        const owner=await env.DB.prepare(`SELECT l.creem_customer_id FROM licenses l
          JOIN license_devices d ON d.license_id=l.id WHERE d.token_hash=?1
          AND l.creem_customer_id IS NOT NULL ORDER BY l.last_event_ms DESC LIMIT 1`)
          .bind(await deviceHash(token)).first();
        if (!owner?.creem_customer_id) return json({error:'No verified TERAPHON purchase for this installation'},404);
        const response=await fetch('https://api.creem.io/v1/customers/billing', {
          method:'POST',redirect:'manual',
          headers:{'x-api-key':env.CREEM_API_KEY,'content-type':'application/json'},
          body:JSON.stringify({customer_id:owner.creem_customer_id})
        });
        if(!response.ok) return json({error:'Creem portal unavailable'},502);
        const payload=await response.json();
        let destination;try{destination=new URL(payload.customer_portal_link)}
        catch{return json({error:'Invalid portal response'},502)}
        if(destination.protocol!=='https:'||destination.username||destination.password||destination.port||
           !(destination.hostname==='creem.io'||destination.hostname.endsWith('.creem.io')))
          return json({error:'Untrusted portal URL'},502);
        return withCors(json({url:destination.toString()}),request);
      }catch(error){console.error('TERAPHON portal error');return json({error:'Portal unavailable'},503)}
    }
    if(u.pathname!=='/webhook') return json({error:'Not found'},404);
    if (request.method!=='POST') return json({error:'Method not allowed'},405);
    if (!env.DB || !env.CREEM_WEBHOOK_SECRET || !productsReady(env))
      return json({error:'Backend configuration incomplete'},503);
    const length=Number(request.headers.get('content-length')||0);
    if (length>250000) return json({error:'Payload too large'},413);
    const raw=await request.text();
    if (raw.length>250000) return json({error:'Payload too large'},413);
    if (!await signatureValid(raw,request.headers.get('creem-signature'),env.CREEM_WEBHOOK_SECRET))
      return json({error:'Invalid signature'},401);
    let event;
    try {event=JSON.parse(raw)} catch {return json({error:'Invalid JSON'},400)}
    if (!str(event?.id) || !str(event?.eventType) ||
        !Number.isSafeInteger(event?.created_at) || event.created_at<=0 ||
        !event.object || typeof event.object!=='object' || Array.isArray(event.object))
      return json({error:'Invalid event'},400);
    try {
      if (await isAlreadyHandled(env.DB,event.id))
        return json({received:true,duplicate:true});
      const obj=event.object, ms=event.created_at;
      if (testPayload(event,obj)) return await saveEvent(env.DB,event,'test_ignored');
      if (!KNOWN_EVENTS.has(event.eventType)) return await saveEvent(env.DB,event,'unknown_ignored');
      if (!WRITE_EVENTS.has(event.eventType)) return await saveEvent(env.DB,event,'non_payment_synced_no_access_change');
      let result;
      switch(event.eventType) {
        case 'subscription.paid': result=stmtPaid(env.DB,obj,ms,productPlan);break;
        case 'checkout.completed': result=stmtLifetime(env.DB,obj,ms,products);break;
        case 'subscription.canceled': result=stmtCanceled(env.DB,obj,ms);break;
        default: result=await stmtReversal(env.DB,event.eventType,obj,ms);
      }
      if (result.error) return json({error:result.error},422);
      const bindings=bindingStatements(env.DB,obj,event.eventType,productPlan);
      return await saveEvent(env.DB,event,result.action,[...result.sql,...bindings]);
    } catch(err) {
      // Concurrency: unique webhook_events.event_id prevents double commits.
      if (await isAlreadyHandled(env.DB,event.id).catch(()=>false))
        return json({received:true,duplicate:true});
      console.error('License webhook D1 failure',String(err?.message||'unknown').slice(0,200));
      return json({error:'Storage unavailable; retry delivery'},503);
    }
  }
};
