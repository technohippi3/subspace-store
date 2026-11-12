/** Independent deterministic specification model. No production imports. */
export type Format = "spacecert-v1" | "spacemsg-0.4.4";
export interface Grant { hash: string; order: string; revision: string; format: Format; artifact: string; expires: number; revoked: boolean }
export interface Ledger { now: number; grants: Grant[] }
export interface Model { durable: Ledger; pending: Ledger | null; ready: Record<string, string | undefined>; available: boolean }
export const initial = (): Model => ({durable:{now:0,grants:[]},pending:null,ready:{},available:true});
export function stageIssue(m:Model,grant:Grant,now:number):Model {
  if(!Number.isSafeInteger(now)||now<m.durable.now||grant.expires<=now||m.ready[grant.order]!==grant.revision)throw Error("refused");
  const current=m.pending??m.durable;
  return {...m,pending:{now,grants:[...current.grants.filter(g=>g.order!==grant.order||g.format!==grant.format),{...grant}]}};
}
export function stageRevoke(m:Model,hash:string):Model {
  const current=m.pending??m.durable;if(!current.grants.some(g=>g.hash===hash))throw Error("unknown grant");
  return {...m,pending:{...current,grants:current.grants.map(g=>g.hash===hash?{...g,revoked:true}:g)}};
}
export function stageExpiry(m: Model, hash: string, now: number): Model {
  const current = m.pending ?? m.durable, grant = current.grants.find(g => g.hash === hash);
  if (!Number.isSafeInteger(now) || now < current.now || !grant || grant.revoked || now < grant.expires)
    throw Error("not an observed expiry");
  return { ...m, pending: { now, grants: current.grants.map(g => g.hash === hash ? { ...g, revoked: true } : g) } };
}
export function acknowledge(m:Model):Model {
  if(!m.available||!m.pending)throw Error("not acknowledged");
  return {...m,durable:structuredClone(m.pending),pending:null};
}
export function hostLoss(m:Model):Model {return {...m,pending:null,durable:structuredClone(m.durable)};}
export function read(m:Model,hash:string,format:Format,now:number):Grant {
  if(!m.available||m.pending||now<m.durable.now)throw Error("not acknowledged");
  const grant=m.durable.grants.find(g=>g.hash===hash);
  if(!grant||grant.format!==format||grant.revoked||now>=grant.expires||m.ready[grant.order]!==grant.revision)throw Error("unavailable");
  return structuredClone(grant);
}
