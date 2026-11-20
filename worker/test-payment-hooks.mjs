import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
let passed=0;
const src=readFileSync(new URL('./teraphon-license.js',import.meta.url),'utf8');
const moduleUrl=`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
const worker=(await import(moduleUrl)).default;
class DB {
 constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));}
 prepare(query){const map=[];const sql=query.replace(/\?(\d+)/g,(_m,n)=>{map.push(Number(n)-1);return '?'});const s=this.sql.prepare(sql);return {bind(...args){const items=map.map(i=>args[i]);return {run:()=>s.run(...items),all:()=>({results:s.all(...items)}),first:()=>s.get(...items)||null}}}};
 async batch(statements){this.sql.exec('BEGIN'); try {let results=[]; for(const statement of statements) results.push(await statement.run());this.sql.exec('COMMIT');return results;}catch(e){this.sql.exec('ROLLBACK');throw e}}
}
const DB1=new DB();
const env={DB:DB1,CREEM_WEBHOOK_SECRET:'whsec_known_test_key',BILLING_ENABLED:'false',TERA_PRODUCT_MONTHLY:'prod_TeraFakeMonth01',TERA_PRODUCT_YEARLY:'prod_TeraFakeYear02',TERA_PRODUCT_LIFETIME:'prod_TeraFakeLife03'};
const base='https://teraphon-license.test';
const token='f'.repeat(64);const hash=createHash('sha256').update(token).digest('hex');
const req=(path,method='GET',headers={},body)=>new Request(base+path,{method,headers,body});
const run=async(path,method,headers,body)=>{let r=await worker.fetch(req(path,method,headers,body),env);return {code:r.status,data:r.status===204?{}:await r.json(),headers:r.headers}};
const test=(cond,title)=>{assert.ok(cond,title);passed++;};
let r=await run('/','GET');test(r.code===200&&r.data.version==='teraphon-v1-prepared','status V4');
r=await run('/v1/health','GET');test(r.data.billingEnabled===false,'billing initially disabled');
r=await run('/v1/license','GET');test(r.code===401,'anonymous licence prohibited');
r=await run('/v1/license','GET',{Authorization:'Bearer '+token});test(r.code===200&&!r.data.active,'unpaid installation inactive');
r=await run('/v1/checkout','POST',{Authorization:'Bearer '+token,'content-type':'application/json'},JSON.stringify({plan:'monthly'}));test(r.code===503,'purchase disabled until secret present');
r=await run('/v1/checkout','OPTIONS',{Origin:'https://teraphonia.com'});test(r.code===204&&r.headers.get('access-control-allow-origin')==='https://teraphonia.com','CORS official domain');
r=await run('/v1/checkout','OPTIONS',{Origin:'https://evil.example'});test(r.code===403,'CORS foreign origin');
const savedFetch=globalThis.fetch;let checkoutPayload;
globalThis.fetch=async(url,opts)=>{checkoutPayload=JSON.parse(opts.body);return new Response(JSON.stringify({checkout_url:'https://checkout.creem.io/ch_test_abc'}),{status:200,headers:{'content-type':'application/json'}})};
env.CREEM_API_KEY='creem_fake_server_only'; env.BILLING_ENABLED='true';
r=await run('/v1/health','GET');test(r.data.billingEnabled===true,'health ready with secret & flag');
r=await run('/v1/checkout','POST',{Authorization:'Bearer '+token,'content-type':'application/json',Origin:'https://teraphonia.com'},JSON.stringify({plan:'monthly'}));
test(r.code===200&&r.data.url.includes('creem.io'),'Checkout returns verified Creem host');
test(checkoutPayload.metadata.tera_device_hash===hash,'checkout passes token hash only');
test(checkoutPayload.product_id==='prod_TeraFakeMonth01','checkout only allowed product ID');
r=await run('/v1/checkout','POST',{Authorization:'Bearer '+token,'content-type':'application/json'},JSON.stringify({plan:'unknown'}));test(r.code===400,'invalid plan rejected');
globalThis.fetch=savedFetch;
const now=Date.now(), period=new Date(now+27*86400000).toISOString();
let eventCounter=100;
function event(type,object){return {id:`evt_${++eventCounter}`,eventType:type,created_at:now+eventCounter,object}}
async function signed(ev){let body=JSON.stringify(ev);const signature=createHmac('sha256',env.CREEM_WEBHOOK_SECRET).update(body).digest('hex');return run('/webhook','POST',{'creem-signature':signature,'content-type':'application/json'},body)}
const checkoutObj={id:'ch_paid_1',status:'completed',order:{id:'ord_paid_1',status:'paid',customer:'cust_a',product:'prod_TeraFakeMonth01'},subscription:{id:'sub_paid_1'},product:{id:'prod_TeraFakeMonth01'},metadata:{tera_device_hash:hash},customer:{id:'cust_a',email:'a@example.com'}};
r=await signed(event('checkout.completed',checkoutObj));test(r.code===200,'checkout received');
const paid={id:'sub_paid_1',status:'active',product:{id:'prod_TeraFakeMonth01'},customer:{id:'cust_a',email:'a@example.com'},current_period_end_date:period,last_transaction_id:'tran_paid_1'};
const paidEvent=event('subscription.paid',paid);
r=await signed(paidEvent);test(r.code===200&&r.data.action==='paid','paid subscription accepted');
r=await signed(paidEvent);test(r.code===200&&r.data.duplicate===true,'repeated webhook is idempotent');
r=await run('/v1/license','GET',{Authorization:'Bearer '+token});test(r.code===200&&r.data.active&&r.data.validUntil>Date.now(),'licence active after payment');
test(DB1.sql.prepare('SELECT COUNT(*) n FROM license_devices').get().n===1,'one binding for one paid install');
const cancel=event('subscription.canceled',{id:'sub_paid_1',current_period_end_date:period,product:{id:'prod_TeraFakeMonth01'}});
r=await signed(cancel);test(r.code===200,'cancel event accepted');
r=await run('/v1/license','GET',{Authorization:'Bearer '+token});test(r.data.active&&r.data.status.startsWith('Canceled'),'cancel preserves paid access');
const order2={id:'ord_lifetime_1',status:'paid',customer:'cust_b',product:'prod_TeraFakeLife03',transaction:'tran_lifetime_1'};
const checkout2={id:'ch_lifetime',status:'completed',order:order2,product:{id:'prod_TeraFakeLife03'},customer:{id:'cust_b'},metadata:{tera_device_hash:hash}};
r=await signed(event('checkout.completed',checkout2));test(r.code===200&&r.data.action==='lifetime_paid','lifetime purchase accepted');
r=await run('/v1/license','GET',{Authorization:'Bearer '+token});test(r.data.status==='Lifetime'&&r.data.active,'lifetime verified on device');
const forged=event('subscription.paid',paid);
r=await run('/webhook','POST',{'creem-signature':'0'.repeat(64),'content-type':'application/json'},JSON.stringify(forged));test(r.code===401,'bad signature rejected');
// Out-of-order: paid before checkout still links when checkout arrives.
const token2='e'.repeat(64),h2=createHash('sha256').update(token2).digest('hex');
const paid2={...paid,id:'sub_paid_2',last_transaction_id:'tran_paid_2'};
r=await signed(event('subscription.paid',paid2));test(r.code===200,'paid-first stored');
r=await run('/v1/license','GET',{Authorization:'Bearer '+token2});test(!r.data.active,'not bound before checkout');
const chk2=structuredClone(checkoutObj); chk2.id='ch_paid_2';chk2.order.id='ord_paid_2';chk2.subscription.id='sub_paid_2';chk2.metadata.tera_device_hash=h2;
r=await signed(event('checkout.completed',chk2));test(r.code===200,'checkout arrives after paid');
r=await run('/v1/license','GET',{Authorization:'Bearer '+token2});test(r.data.active,'paid-first eventually active');
console.log(`PASS ${passed} V4 integration checks`);
