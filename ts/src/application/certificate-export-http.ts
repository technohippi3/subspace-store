import type {IncomingMessage,ServerResponse} from 'node:http';
import type {CertificateExports} from './certificate-export.ts';
import {Effect} from 'effect';
import {body} from './http.ts';
import {ExportError,headers,profiles,exportRoute} from './certificate-export.ts';
const esc=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function page(response:ServerResponse,code:number,title:string,content:string){const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1>${content}</main></body></html>`;response.writeHead(code,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(html)});response.end(html);}
export async function exportBrowserRoute(service:CertificateExports,request:IncomingMessage,response:ServerResponse){
 const order=/^\/o\/([A-Za-z0-9_-]{32})\/exports$/.exec(request.url??''),view=/^\/c\/([A-Za-z0-9_-]{43})\/view$/.exec(request.url??'');
 if(!order&&!view){if((request.url??'').startsWith('/c/')){await exportRoute(service,request,response);return true;}return false;}
 try{
  if(view&&request.method==='GET'){
   const manifest=await service.manifest(view[1]!),svg=await service.qr(view[1]!);
   page(response,200,'Native certificate export',`<p>This is a certificate-only link. It does not open or manage an order.</p><p>Profile: <code>${esc(manifest.profile)}</code>. Native libveritas 0.4.4 format; no Nacho app import compatibility is claimed.</p><p><a id="native-download" href="${esc(manifest.url)}">Download ${esc(manifest.filename)}</a></p><div id="certificate-qr" aria-label="Certificate download URL QR code">${svg}</div><p>The QR contains only the certificate download URL. Use it with a client that supports this native format.</p><p>Expires: ${esc(new Date(manifest.expires*1000).toISOString())}</p><p><a href="${esc(service.url(view[1]!,'manifest.json'))}">Native format manifest</a></p>`);return true;
  }
  if(!order)throw new ExportError(404,'not found');
  // Full order authority is checked before any new capability is issued.
  await Effect.runPromise(service.store.certificateExportContext(order[1]!));
  if(request.method==='GET'){
   page(response,200,'Choose a native certificate format',`<p>These are native libveritas 0.4.4 artifacts. A qualified Nacho import profile is not available for the currently unidentified app build.</p>${Object.entries(profiles).map(([profile,p])=>`<form method="post" action="/o/${order[1]!}/exports"><input type="hidden" name="profile" value="${profile}"><button type="submit">Create certificate-only link for ${esc(p.file)}</button></form>`).join('')}<form method="post" action="/o/${order[1]!}/exports"><input type="hidden" name="action" value="revoke"><button type="submit">Revoke all certificate-only links</button></form><p>Each new link replaces your previous link for that format. It expires automatically and follows current certificate readiness.</p>`);return true;
  }
  if(request.method!=='POST')throw new ExportError(404,'not found');
  if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??''))throw new ExportError(400,'invalid form');
  const raw=await body(request);if(raw==='action=revoke'){await service.revokeAll(order[1]!);response.writeHead(303,{...headers,Location:'/o/'+order[1]!+'/exports','Content-Length':0});response.end();return true;}const match=/^profile=(spacecert-v1|spacemsg-0\.4\.4)$/.exec(raw);if(!match)throw new ExportError(400,'invalid form');
  const cap=await service.issue(order[1]!,match[1]!);response.writeHead(303,{...headers,Location:'/c/'+cap.token+'/view','Content-Length':0});response.end();return true;
 }catch(error){const code=error instanceof ExportError?error.code:error&&typeof error==='object'&&'code'in error&&error.code==='not_found'?404:error&&typeof error==='object'&&'code'in error&&error.code==='invalid'?400:503;page(response,code,code===404?'Not found':'Certificate export unavailable','<p>The requested certificate export is unavailable. No payment is requested.</p>');return true;}
}
