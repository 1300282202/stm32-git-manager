'use strict';
const fs=require('node:fs/promises');
const fss=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const LIMIT=1024*1024;
function error(message,code='INVALID_OPERATION'){const e=new Error(message);e.code=code;return e;}
function digest(v){return crypto.createHash('sha256').update(v).digest('hex');}
function keyFor(v){return digest(path.resolve(v).toLowerCase()).slice(0,24);}
function norm(v){return v.replace(/\\/g,'/');}
function samePath(a,b){return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
function within(root,target){const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
async function exists(p){try{await fs.access(p);return true;}catch{return false;}}
async function jsonRead(p,fallback){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw error('本地记录文件无法读取，请保留应用数据并检查磁盘。','DATA_ERROR');}}
async function atomicJson(p,value){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),'utf8');await fs.rename(tmp,p);}
async function shaFile(p){const h=crypto.createHash('sha256');await new Promise((resolve,reject)=>{const s=fss.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',resolve);});return h.digest('hex');}
function displayBuffer(buffer,fullBytes=buffer.length){
 let text='',encoding='UTF-8',binary=false;const truncated=buffer.length>LIMIT||fullBytes>buffer.length;const data=buffer.subarray(0,LIMIT);
 if(data.length>=2&&data[0]===255&&data[1]===254){encoding='UTF-16LE';text=data.subarray(2).toString('utf16le');}
 else if(data.length>=2&&data[0]===254&&data[1]===255){encoding='UTF-16BE';text=new TextDecoder('utf-16be').decode(data.subarray(2));}
 else if(data.includes(0)){binary=true;encoding='binary';}
 else{try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{encoding='GB18030（推测）';try{text=new TextDecoder('gb18030',{fatal:true}).decode(data);}catch{binary=true;encoding='binary';}}
 if(!binary&&/[\x01-\x08\x0e-\x1f]/.test(text)){binary=true;encoding='binary';text='';}}
 return {text:binary?'':text,binary,encoding,truncated,bytes:fullBytes};
}
function translateGitError(text){
 if(/Authentication failed|could not read Username|terminal prompts disabled|interactive.*disabled|Repository not found/i.test(text))return '远程访问未获授权，或仓库地址不可访问。GitHub HTTPS 仓库请在“远程同步”点击“登录 GitHub”，并核对地址及账号权限；其他服务请检查系统 Git 凭据。';
 if(/index\.lock|Unable to create.*lock/i.test(text))return 'Git 正被其他程序使用，或存在未清理的锁。请确认其他 Git 操作已结束。\n'+text.slice(0,1200);
 if(/identity unknown|unable to auto-detect email/i.test(text))return '请先在工程设置中填写提交作者姓名和邮箱。';
 if(/nothing to commit|no changes added/i.test(text))return '没有已暂存的修改，请先选择文件加入本次版本。';
 if(/dubious ownership/i.test(text))return 'Git 检测到工程所有权不匹配，请在可信的 Git 环境中处理后重新打开；工具不会更改全局信任设置。';
 return (text.trim()||'Git 操作未完成。').slice(0,3000);
}
function runGit(gitPath,emptyHooks,root,args,{input,maxBuffer=16*LIMIT,timeout=30000,allowFailure=false,literalPaths=true}={}){
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('GIT_')&&!['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM'].includes(k))delete env[k];Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_PAGER:'cat',GCM_INTERACTIVE:'never',LC_ALL:'C.UTF-8'});
 const full=['--no-pager',...(literalPaths?['--literal-pathspecs']:[]),'-c','core.fsmonitor=false','-c',`core.hooksPath=${emptyHooks}`,'-c','core.quotePath=false','-c','color.ui=false'];
 // Opening a concrete project grants this process access to that exact root only.
 // This also supports folders created by an elevated installer; no global trust is changed.
 if(root)full.push('-c',`safe.directory=${root}`,'-C',root);full.push(...args);
 return new Promise((resolve,reject)=>{const child=spawn(gitPath,full,{windowsHide:true,shell:false,env,stdio:['pipe','pipe','pipe']});const out=[],err=[];let size=0,errSize=0,failed=false;
 const timer=setTimeout(()=>{failed=true;child.kill();reject(error('Git 操作超时，请检查工程状态后重试。','TIMEOUT'));},timeout);
 child.on('error',e=>{clearTimeout(timer);failed=true;reject(error(e.code==='ENOENT'?'未找到 Git，请安装 Git for Windows 后重新打开工具。':'无法启动 Git：'+e.message,'GIT_UNAVAILABLE'));});
 child.stdout.on('data',b=>{size+=b.length;if(size>maxBuffer){failed=true;child.kill();clearTimeout(timer);reject(error('结果过大，A 阶段暂不支持展开此内容。','OUTPUT_LIMIT'));}else out.push(b);});
 child.stderr.on('data',b=>{errSize+=b.length;if(errSize<256*1024)err.push(b);});
 child.on('close',code=>{clearTimeout(timer);if(failed)return;const r={code,stdout:Buffer.concat(out),stderr:Buffer.concat(err).toString('utf8')};if(code&&!allowFailure)reject(error(translateGitError(r.stderr),'GIT_FAILED'));else resolve(r);});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
module.exports={LIMIT,error,digest,keyFor,norm,samePath,within,exists,jsonRead,atomicJson,shaFile,displayBuffer,runGit};
