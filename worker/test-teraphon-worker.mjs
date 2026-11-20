import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const src=readFileSync(new URL('./teraphon-license.js',import.meta.url),'utf8');
const worker=(await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)).default;
class DB {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));}
  prepare(sql){const numbers=[];const param=sql.replace(/\?(\d+)/g,(_m,n)=>{numbers.push(Number(n)-1);return '?'});
    const statement=this.db.prepare(param);
    return {bind(...args){const bound=numbers.map(n=>args[n]);return {
      run:()=>statement.run(...bound),first:()=>statement.get(...bound)||null,all:()=>({results:statement.all(...bound)})
    }}}
  }
  async batch(statements){this.db.exec('BEGIN');try {for(const s of statements)await s.run();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e}}
}
const db=new DB();
const env={DB:db,BILLING_ENABLED:'false',TERA_PRODUCT_MONTHLY:'',TERA_PRODUCT_YEARLY:'',TERA_PRODUCT_LIFETIME:''};
const token='b'.repeat(64),fingerprint='e'.repeat(64);
async function call(path,method='GET',fp=fingerprint,auth=token){
 const headers={Authorization:`Bearer ${auth}`}; if(fp) headers['X-Tera-Trial-Device']=fp;
 const r=await worker.fetch(new Request(`https://mock.example${path}`,{method,headers}),env);
 return {status:r.status,json:await r.json()};
}
let a=await call('/v1/license');assert.equal(a.status,200);assert.equal(a.json.active,true);
assert.equal(a.json.plan,'trial');assert.equal(a.json.entitlementType,'trial');
assert(a.json.validUntil>Date.now());
let b=await call('/v1/license');assert.equal(a.json.validUntil,b.json.validUntil);
let empty=await call('/v1/license','GET',null);assert.equal(empty.json.active,false);
let wrong=await call('/v1/license','GET',fingerprint,'invalid');assert.equal(wrong.status,401);
let notConfigured=await worker.fetch(new Request('https://mock.example/v1/checkout',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'{"plan":"monthly"}'}),env);
assert.equal(notConfigured.status,503);
// Fake signed paid event already persisted by the webhook flow, using a *TERAPHON* product.
env.TERA_PRODUCT_MONTHLY='prod_TeraMonthly1'; env.TERA_PRODUCT_YEARLY='prod_TeraYearly2'; env.TERA_PRODUCT_LIFETIME='prod_TeraLifetime3';
const hash=createHash('sha256').update(token).digest('hex');
db.db.prepare(`INSERT INTO licenses (id,creem_customer_id,creem_subscription_id,product_id,status,expires_at,last_event_ms)
 VALUES ('sub_tera','cust_tera','sub_tera','prod_TeraMonthly1','active',?,1)`)
 .run(new Date(Date.now()+15*86400000).toISOString());
db.db.prepare("INSERT INTO license_devices (license_id,token_hash) VALUES ('sub_tera',?)").run(hash);
let paid=await call('/v1/license');assert.equal(paid.json.plan,'monthly');assert.equal(paid.json.entitlementType,'paid');
assert(paid.json.validUntil>Date.now());
// Other install never inherits this purchaser's subscription.
let other=await call('/v1/license','GET','f'.repeat(64),'a'.repeat(64));assert.equal(other.json.plan,'trial');
// TERAPHON-specific three-device activation, 130-bit code encrypted in D1.
env.ACTIVATION_ENCRYPTION_KEY=randomBytes(32).toString('base64');
let activation=await call('/v1/activation-code');
assert.equal(activation.status,200);assert.equal(activation.json.deviceLimit,3);
assert.equal(activation.json.used,1);assert.match(activation.json.code,/^TP1-/);
const code=activation.json.code;
const saved=db.db.prepare('SELECT code_cipher FROM teraphon_activation_codes').get();
assert(!saved.code_cipher.includes(code));
let activation2=await call('/v1/activation-code');assert.equal(activation2.json.code,code);
async function withCode(path,body,tokenValue){
 const r=await worker.fetch(new Request(`https://mock.example/v1/${path}`,{
 method:'POST',headers:{Authorization:`Bearer ${tokenValue}`,'Content-Type':'application/json'},body:JSON.stringify(body)
 }),env);return {status:r.status,json:await r.json()};
}
const third='c'.repeat(64),fourth='d'.repeat(64),fifth='1'.repeat(64);
let act=await withCode('activate',{code},third);assert.equal(act.status,200);assert.equal(act.json.used,2);
act=await withCode('activate',{code},fourth);assert.equal(act.status,200);assert.equal(act.json.used,3);
act=await withCode('activate',{code},fifth);assert.equal(act.status,409);
let thirdPaid=await call('/v1/license','GET','9'.repeat(64),third);assert.equal(thirdPaid.json.entitlementType,'paid');
let devices=await withCode('devices',{code},token);assert.equal(devices.json.used,3);
const releaseId=devices.json.devices.find(v=>v.thisDevice===false).deviceId;
let released=await withCode('release',{code,deviceId:releaseId},token);assert.equal(released.json.used,2);
act=await withCode('activate',{code},fifth);assert.equal(act.status,200);assert.equal(act.json.used,3);
let bad=await withCode('activate',{code:'TP1-INVALID'},'2'.repeat(64));assert.equal(bad.status,400);
let status=await call('/v1/health');assert.equal(status.json.billingEnabled,false);
console.log('TERAPHON separated-license worker checks: PASS (trial, persistent window, auth, no premature checkout, paid isolation, 3 devices)');
