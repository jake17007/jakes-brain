// Synthetic, memory-only state. No fetch, storage, native keys, or server data access.
const TODAY='2026-11-20';
const NOW='2026-11-20T15:00:00.000Z';
const round=n=>Math.round(n*100)/100;
let accounts,transactions,categories;
const defaults=[
 {id:'housing',name:'Housing',budget:2200,color:'#6776a8'},
 {id:'groceries',name:'Groceries',budget:600,color:'#319868'},
 {id:'dining',name:'Dining',budget:250,color:'#d79b48'},
 {id:'transport',name:'Transport',budget:180,color:'#6388ba'},
 {id:'subscriptions',name:'Subscriptions',budget:100,color:'#9680b6'},
 {id:'shopping',name:'Shopping',budget:300,color:'#bc818c'},
 {id:'health',name:'Health',budget:150,color:'#5c9c9b'},
];
function reset(){
 accounts=[
 {id:'sample-chase-checking',name:'Chase Checking',org:'Chase',type:'cash',balance:8450},
 {id:'sample-wells-savings',name:'Wells Fargo Savings',org:'Wells Fargo',type:'cash',balance:18200},
 {id:'sample-chase-card',name:'Chase Sapphire',org:'Chase',type:'credit',balance:-1250,credit_limit:8000},
 {id:'sample-coinbase-btc',name:'Bitcoin',org:'Coinbase',type:'crypto',balance:4600},
 {id:'sample-coinbase-eth',name:'Ethereum',org:'Coinbase',type:'crypto',balance:1800},
 ].map(a=>({...a,nickname:'',type_auto:a.type,hidden:false,currency:'USD',balance_date:NOW,updated_at:NOW,available:a.type==='cash'?a.balance:null,credit_limit:a.credit_limit??null,holdings_value:a.type==='crypto'?a.balance:null}));
 categories=structuredClone(defaults);
 const rows=[
 ['11-20','Whole Foods Market',-128.47,'groceries'],['11-19','Freelance project',4200,'income','sample-chase-checking'],
 ['11-19','Trader Joe’s',-86.35,'groceries'],['11-18','MTA Subway',-29,'transport'],
 ['11-18','Sweetgreen',-24.80,'dining'],['11-17','Coffee shop',-12.60,'dining'],
 ['11-16','Adobe Creative Cloud',-59.99,'subscriptions'],['11-15','Grocery delivery',-112.40,'groceries'],
 ['11-14','City pharmacy',-28,'health'],['11-13','Uniqlo',-129.95,'shopping'],
 ['11-12','Neighborhood restaurant',-89,'dining'],['11-11','Rideshare',-34.75,'transport'],
 ['11-10','Spotify',-11.99,'subscriptions'],['11-09','Trader Joe’s',-111.30,'groceries'],
 ['11-08','Lunch with friends',-60,'dining'],['11-07','Fitness class',-37,'health'],
 ['11-06','MTA Subway',-29,'transport'],['11-05','iCloud+',-2.99,'subscriptions'],
 ['11-01','Apartment rent',-2200,'housing','sample-chase-checking'],
 ['10-29','Grocery delivery',-136.24,'groceries'],['10-27','Neighborhood restaurant',-76.40,'dining'],
 ['10-24','MTA Subway',-29,'transport'],['10-22','Creative project',3100,'income','sample-chase-checking'],
 ];
 transactions=rows.map((r,i)=>({id:`sample-tx-${i+1}`,posted:`2026-${r[0]}T12:00:00.000Z`,payee:r[1],description:r[3]==='income'?'Sample freelance income':'Sample transaction',amount:r[2],category:r[3],account_id:r[4]||'sample-chase-card',pending:false})).sort((a,b)=>b.posted.localeCompare(a.posted));
}
reset();
function budget(){
 const cats=categories.map(c=>{const tx=transactions.filter(t=>t.category===c.id&&t.posted.startsWith('2026-11')); const spent=round(-tx.reduce((n,t)=>n+Math.min(0,t.amount),0));return {...c,spent,remaining:round(c.budget-spent),transactions:tx.map(txOut)};});
 const total=round(cats.reduce((n,c)=>n+c.budget,0)),spent=round(cats.reduce((n,c)=>n+c.spent,0));
 return {month:'November 2026',month_key:'2026-11',budget:total,spent,remaining:round(total-spent),categories:cats};
}
function txOut(t){return {...t,account:accounts.find(a=>a.id===t.account_id)?.nickname||accounts.find(a=>a.id===t.account_id)?.name||'Sample account'};}
function overview(){
 const visible=accounts.filter(a=>!a.hidden);
 const summary={net_worth:0,assets:0,debts:0,cash:0,credit:0,crypto:0,investment:0,loan:0,other:0,as_of:NOW};
 visible.forEach(a=>{summary.net_worth+=a.balance;summary[a.balance>=0?'assets':'debts']+=Math.abs(a.balance);summary[a.type]+=a.type==='credit'||a.type==='loan'?-a.balance:a.balance;});
 Object.keys(summary).filter(k=>typeof summary[k]==='number').forEach(k=>summary[k]=round(summary[k]));
 const available_credit=round(visible.filter(a=>a.type==='credit').reduce((n,a)=>n+Math.max(0,(a.credit_limit||0)+a.balance),0));
 const monthly_spending=round(-transactions.filter(t=>t.amount<0).reduce((n,t)=>n+t.amount,0));
 const spendable=round(summary.cash+summary.crypto+available_credit);
 const runway={cash:summary.cash,crypto:summary.crypto,available_credit,monthly_spending,days:30,spendable,months:round(spendable/monthly_spending),months_cash_only:round((summary.cash+summary.crypto)/monthly_spending)};
 return {sample:true,connected:true,sync:{last_success:NOW,last_attempt:NOW,last_error:null,messages:[]},summary,change:{days:30,net_worth:1840},runway,budget:budget(),goal_link:{goal_id:'sample-emergency-fund',title:'Build a $50k financial cushion',target_value:50000,current_value:summary.net_worth,progress:summary.net_worth/50000,target_date:'2027-12-31',auto:true},accounts:accounts.map(a=>({...a,available_credit:a.type==='credit'?Math.max(0,(a.credit_limit||0)+a.balance):null}))};
}
function history(url){
 const days=url.searchParams.get('days')==='all'?365:Math.max(7,Math.min(365,Number(url.searchParams.get('days'))||90));
 const id=url.searchParams.get('account'),a=accounts.find(a=>a.id===id);if(id&&!a)throw Object.assign(new Error('No sample account'),{status:404});
 const current=a?a.balance:overview().summary.net_worth;
 const pts=[];for(let i=days-1;i>=0;i--){const d=new Date(TODAY+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-i);const t=365-i;const drift=(Math.sin(t*.16)-Math.sin(365*.16))*75+(Math.cos(t*.055)-Math.cos(365*.055))*110;const change=a?(a.type==='crypto'?i*2.7:i*5.8):i*27;const val=i===0?current:round(current-change+drift*(a?.type==='credit'?.2:1));pts.push({date:d.toISOString().slice(0,10),net_worth:val,assets:Math.max(val,0),debts:Math.max(-val,0)});}
 return {points:pts};
}

export async function sampleApi(input, options = {}) {
  if (typeof input !== 'string' || !input.startsWith('/api/') || input.startsWith('//') || /[\\#]/.test(input)) throw Object.assign(new Error('Sample API path required'), {status:403});
  const url=new URL(input,'https://sample.invalid'),p=url.pathname,method=String(options.method||'GET').toUpperCase();
  const b=options.body===undefined?{}:options.body;
  const reject=(message,status=404)=>{throw Object.assign(new Error(message),{status});};
  const read=()=>{if(method!=='GET')reject('Method unavailable in sample mode',405);};
  let result;
  if(p==='/api/health'){read();result={ok:true,sample:true};}
  else if(p==='/api/version'){read();result={build:'finance-static-sample-v5',sample:true};}
  else if(p==='/api/apps'){read();result={apps:['finances'],web:['finances']};}
  else if(p==='/api/finances'){read();result=overview();}
  else if(p==='/api/finances/history'){read();result=history(url);}
  else if(p==='/api/finances/transactions'){
    read();const limit=Math.min(50,Math.max(1,Number(url.searchParams.get('limit'))||50)),before=url.searchParams.get('before'),id=url.searchParams.get('account');
    const tx=transactions.filter(t=>(!id||t.account_id===id)&&(!before||t.posted<before));result={transactions:tx.slice(0,limit).map(txOut),more:tx.length>limit};
  }
  else if(p==='/api/finances/budget'){read();result=budget();}
  else if(/^\/api\/finances\/budget\/[a-z-]+$/.test(p)&&method==='PATCH'){
    const c=categories.find(c=>c.id===p.split('/').pop());if(!c)reject('Sample category not found');
    if(typeof b.budget!=='number'||!Number.isFinite(b.budget)||b.budget<0||b.budget>100000)reject('Enter a budget from $0 to $100,000',400);
    c.budget=round(b.budget);result=budget();
  }
  else if(/^\/api\/finances\/accounts\/sample-[a-z-]+$/.test(p)&&method==='PATCH'){
    const a=accounts.find(a=>a.id===p.split('/').pop());if(!a)reject('Sample account not found');
    if('credit_limit'in b&&b.credit_limit!==null&&(typeof b.credit_limit!=='number'||!Number.isFinite(b.credit_limit)||b.credit_limit<0))reject('Invalid sample credit limit',400);
    if(typeof b.nickname==='string')a.nickname=b.nickname.slice(0,80);if(typeof b.hidden==='boolean')a.hidden=b.hidden;
    if(['cash','credit','crypto','investment','loan','other','auto'].includes(b.type))a.type=b.type==='auto'?a.type_auto:b.type;
    if('credit_limit'in b)a.credit_limit=b.credit_limit;result={account:a};
  }
  else if(p==='/api/finances/sync'&&method==='POST')result=overview();
  else if(p==='/api/demo/reset'&&method==='POST'){reset();result={ok:true,sample:true};}
  else reject('Unavailable in sample mode');
  return structuredClone(result);
}
