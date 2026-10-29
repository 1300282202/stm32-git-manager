'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { XMLParser } = require('fast-xml-parser');
const { error, within, shaFile, digest, displayBuffer } = require('./git-utils.cjs');
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
function strings(node, key, out = []) { if (!node || typeof node !== 'object') return out; for (const [k, value] of Object.entries(node)) { if (k === key) for (const item of list(value)) if (typeof item !== 'object' && String(item).trim()) out.push(String(item).trim()); if (typeof value === 'object') for (const item of list(value)) strings(item, key, out); } return out; }
function resolveProjectPath(root, projectDir, value, { output = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || /[\0$%]/.test(value)) throw error('工程路径为空或含暂不支持的变量：' + value);
  const raw = value.replace(/\\/g, '/');
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw error('D1 隔离编译仅支持工程内的相对路径：' + value);
  const full = path.resolve(projectDir, raw);
  if (!within(root, full) || (output && full === root) || path.relative(root, full).split(path.sep).some(part => part.toLowerCase() === '.git')) throw error('工程路径超出允许范围：' + value);
  return path.relative(root, full).replace(/\\/g, '/');
}
async function parseProject(service, root, relative) {
  const safe = await service.safePath(root, relative, { allowMissing: false });
  if (!/\.uvprojx$/i.test(relative)) throw error('请选择 .uvprojx 工程。');
  const xml = await fs.readFile(safe.absolute, 'utf8');
  if (xml.length > 5 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw error('工程文件过大或含不支持的 XML 实体。');
  const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true }).parse(xml);
  const targets = [];
  for (const target of list(doc?.Project?.Targets?.Target)) {
    const common = target.TargetOption?.TargetCommonOption || {}, name = String(target.TargetName || '');
    const item = { name, device: String(common.Device || ''), compiler: String(target.pCCUsed || ''), project: relative, outputName: String(common.OutputName || ''), createHex: String(common.CreateHexFile) === '1', outputs: [], files: [], includes: [], blocked: [] };
    if (!name || name.length > 200 || /[\r\n\0"\\]/.test(name)) item.blocked.push('Target 名称无效或包含无法安全传递的引号、反斜杠');
    try {
      if (!/^[^<>:"/\\|?*\0]+$/.test(item.outputName)) throw error('输出名称无效');
      for (const value of [common.OutputDirectory, common.ListingPath].filter(value => String(value || '').trim())) item.outputs.push(resolveProjectPath(root, path.dirname(safe.absolute), String(value), { output: true }));
      if (!String(common.OutputDirectory || '').trim()) throw error('需要单独的工程内输出目录');
      for (const phase of ['BeforeMake', 'BeforeCompile', 'AfterMake']) for (const key of ['RunUserProg1', 'RunUserProg2']) if (String(common[phase]?.[key] || '0') !== '0') item.blocked.push(phase + ' 启用了自定义程序；D1 不执行这些程序');
      for (const value of strings(target.Groups, 'FilePath')) {
        const file = resolveProjectPath(root, path.dirname(safe.absolute), value); const source = await service.safePath(root, file, { allowMissing: false });
        if (!(await fs.stat(source.absolute)).isFile()) throw error('源码引用不是普通文件：' + value); item.files.push(file);
      }
      for (const value of strings(target.TargetOption, 'IncludePath').flatMap(value => value.split(';')).map(value => value.trim()).filter(Boolean)) {
        const dir = resolveProjectPath(root, path.dirname(safe.absolute), value); const full = dir ? (await service.safePath(root, dir, { allowMissing: false })).absolute : root;
        if (!(await fs.stat(full)).isDirectory()) throw error('IncludePath 不是目录：' + value); item.includes.push(dir);
      }
      for (const value of strings(target.TargetOption, 'ScatterFile')) await service.safePath(root, resolveProjectPath(root, path.dirname(safe.absolute), value), { allowMissing: false });
      if (strings(target.TargetOption, 'Misc').some(value => /(?:--preinclude|--via|--scatter|--userlibpath|--sysroot|--plugin|\b--predefine)\b|(?:^|\s)@/i.test(value))) item.blocked.push('检测到需要单独核验的外部输入或编译扩展参数');
      for (const file of item.files) if (item.outputs.some(out => file === out || file.startsWith(out + '/'))) item.blocked.push('源码引用位于输出目录，不能隔离排除旧产物');
      for (const out of item.outputs) await service.safePath(root, out);
    } catch (e) { item.blocked.push(e.message); }
    targets.push(item);
  }
  if (!targets.length) throw error('工程中没有可识别的 Target。');
  return { project: relative, hash: digest(xml), targets };
}
async function snapshot(service, root, outputs = []) {
  const files = []; let bytes = 0, count = 0;
  async function visit(dir, depth) {
    if (depth > 40) throw error('工程目录层级过深。');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (++count > 12000) throw error('D1 工程快照最多支持 12000 个目录项。');
      const relative = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
      if (entry.name.toLowerCase() === '.git') { if (dir === root) continue; throw error('D1 不编译包含嵌套仓库或子模块的快照。'); }
      if (outputs.some(out => relative === out || relative.startsWith(out + '/')) || /\.uvgu(?:ix|i)\./i.test(entry.name)) continue;
      const safe = await service.safePath(root, relative, { allowMissing: false });
      if (entry.isDirectory()) await visit(safe.absolute, depth + 1);
      else if (entry.isFile()) { const stat = await fs.stat(safe.absolute); bytes += stat.size; if (bytes > 256 * 1024 * 1024) throw error('D1 工程文件快照超过 256 MB。'); files.push({ path: relative, bytes: stat.size, sha256: await shaFile(safe.absolute) }); }
      else throw error('工程含不支持的特殊文件。');
    }
  }
  await visit(root, 0); files.sort((a, b) => a.path.localeCompare(b.path)); return { files, bytes, hash: digest(JSON.stringify(files)) };
}
function buildKeilArgs({ workspace, project, target, mode, logPath }, windows = process.platform === 'win32') {
  if (typeof target !== 'string' || /[\r\n\0"\\]/.test(target)) throw error('Target 名称不能包含控制字符、引号或反斜杠。');
  const projectPath = path.join(workspace, project);
  if ([projectPath,logPath].some(value => typeof value !== 'string' || /[\r\n\0"]/.test(value))) throw error('编译路径无效。');
  // UV4 5.x parses the raw Windows command line. It expects -t"Target 1",
  // not the CRT-equivalent "-tTarget 1" that libuv would normally produce.
  return windows ? [mode === 'build' ? '-b' : '-r', `"${projectPath}"`, `-t"${target}"`, '-j0', `-o"${logPath}"`] : [mode === 'build' ? '-b' : '-r', projectPath, '-t' + target, '-j0', '-o' + logPath];
}
async function runKeil({ executable, workspace, project, target, mode, logPath, signal }) {
  return new Promise((resolve, reject) => {
    const args = buildKeilArgs({ workspace,project,target,mode,logPath });
    // Older UV4 descendants can inherit pipe handles and keep `close` pending after UV4 exits.
    // UV4 writes its build log through -o, so no inherited console pipes are needed.
    const child = spawn(executable, args, { cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: 'ignore', ...(process.platform === 'win32' ? { windowsVerbatimArguments: true, argv0: `"${executable}"` } : {}) });
    let finished = false, fallback;
    const finish = code => { if (finished) return; finished = true; clearTimeout(fallback); signal.removeEventListener('abort', abort); child.unref(); resolve({ code, output: '' }); };
    const abort = () => {
      if (!child.pid || finished) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      else child.kill('SIGTERM');
      fallback = setTimeout(() => finish(null), 5000);
    };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.once('error', e => { if (finished) return; finished = true; clearTimeout(fallback); signal.removeEventListener('abort', abort); reject(e); });
    child.once('exit', finish);
  });
}
function parseBuildResult(code, log) {
  const summary = /\b(\d+)\s+Error\(s\),\s*(\d+)\s+Warning\(s\)/i.exec(log);
  const errors = summary ? Number(summary[1]) : null, warnings = summary ? Number(summary[2]) : null;
  const passed = (code === 0 || code === 1) && errors === 0 && !/fatal error|Target not created|not available|license.*(?:fail|error)|Error:.*(?:cannot|not found)/i.test(log);
  return { passed, errors, warnings, status: passed ? (code === 1 || warnings ? 'passed-with-warnings' : 'passed') : 'failed', summaryFound: Boolean(summary) };
}
async function readLog(file) { try { const raw = await fs.readFile(file); return displayBuffer(raw.subarray(0, 1024 * 1024), raw.length).text; } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
module.exports = { parseProject, snapshot, runKeil, buildKeilArgs, parseBuildResult, readLog };
