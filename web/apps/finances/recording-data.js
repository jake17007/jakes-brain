// Temporary recording data. Restore only when the user explicitly says filming is done.
// Auth/lock requests use the unchanged real gate. Financial values and edits remain in memory.
import { sampleApi } from '../../sample/sample-data.js';
const AUTH = new Set(['GET /api/finances/lock','POST /api/finances/unlock','POST /api/finances/lock/pin','DELETE /api/finances/lock/pin','POST /api/finances/lock/device','POST /api/finances/lock/now']);
const visible = (v) => Array.isArray(v) ? v.map(visible) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visible(x)]))
  : typeof v === 'string' ? v.startsWith('sample-') ? 'recording-'+v.slice(7) : v.replace(/\bSample\s+/g,'').replace(/\bsample\s+/g,'') : v;
export function createRecordingApi(realApi, getToken) {
  let lockCheck=null, checkToken='', goalOverride;
  const guard = async () => {
    const token=getToken();
    if (!lockCheck || checkToken!==token) {
      checkToken=token;
      const pending=realApi('/api/finances/lock',{headers:{'X-Finances-Unlock':token}});
      lockCheck=pending;
      pending.finally(()=>{if(lockCheck===pending)lockCheck=null;}).catch(()=>{});
    }
    const status=await lockCheck;
    if(status.enabled&&!status.unlocked)throw Object.assign(new Error('Finances is locked'),{status:423});
  };
  return async function recordingApi(path,opts={}) {
    const method=String(opts.method||'GET').toUpperCase();
    if(AUTH.has(`${method} ${path}`))return realApi(path,opts);
    await guard();
    if(typeof path!=='string'||(!path.startsWith('/api/finances')&&!path.startsWith('/api/goals?')))throw Object.assign(new Error('Unavailable during recording'),{status:404});
    if(path.startsWith('/api/goals?')&&method==='GET'){
      const o=await sampleApi('/api/finances'),g=visible(o.goal_link);
      return {goals:[{id:g.goal_id,title:g.title,unit:'$',target_value:g.target_value,current_value:g.current_value,target_date:g.target_date,status:'active'}]};
    }
    if(path==='/api/finances/goal'&&method==='PUT'){
      const requested=opts.body?.goal;
      if(requested===0)goalOverride=null;
      else if(requested===null||requested==='recording-emergency-fund')goalOverride=undefined;
      else throw Object.assign(new Error('Goal unavailable'),{status:404});
      const o=visible(await sampleApi('/api/finances'));if(goalOverride===null)o.goal_link=null;return o;
    }
    // Unknown, connection and unsupported calls fail closed here; never forward financial operations.
    const fixturePath=path.replace(/recording-/g,'sample-');
    try {
      const result=visible(await sampleApi(fixturePath,opts));
      if(result&&Object.hasOwn(result,'goal_link')&&goalOverride===null)result.goal_link=null;
      return result;
    } catch(error) {throw Object.assign(new Error(visible(error.message)),{status:error.status||400});}
  };
}
