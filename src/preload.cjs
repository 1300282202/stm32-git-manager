'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['projects', 'inspect', 'state', 'init', 'identity', 'stage', 'unstage', 'commit', 'diff', 'history', 'historyFiles', 'readFile', 'ignorePreview', 'ignoreApply', 'restorePreview', 'restore', 'backups', 'undoRestore', 'logs', 'chooseProject', 'openKeil', 'openFolder', 'chooseCloneDestination', 'clone', 'appInfo']);
for (const action of ['branches','branchCreate','branchSwitch','branchRename','branchDelete','mergePreview','merge','conflicts','conflictFile','resolveConflict','continueOperation','abortOperation','stashes','stashCreate','stashApply','stashDrop','stashRecover','cherryPick','tags','tagCreate','tagDelete','worktrees','worktreeAdd','worktreeRemove','remotes','remoteSave','remoteRemove','syncPreview','fetch','pull','push','exportArchive','chooseArchiveDestination']) actions.add(action);
for (const action of ['githubOpenNew', 'githubOpenRepository', 'githubLogin']) actions.add(action);
for (const action of ['expertOverview','expertCatalog','expertHelp','expertReflog','expertPreview','expertBackups','expertBisectStatus','expertDiagnose','expertExecute','expertRescue','expertBackupExport','expertBisectStart','expertBisectMark','expertBisectStop','expertBisectWorktree','expertBundleExport','expertBundleVerify','chooseExpertBundleSave','chooseExpertBundleOpen','openExpertHelp']) actions.add(action);
for (const action of ["engineeringOverview","engineeringBuildPoll","engineeringBuildCancel","engineeringNotes","engineeringNoteRead","engineeringNoteImage","engineeringLfs","engineeringSummary","engineeringAutoTick","engineeringSettings","engineeringBuildStart","engineeringVerification","engineeringArchive","engineeringArchiveExport","engineeringNoteSave","engineeringCheckpoint","engineeringCheckpointExport","engineeringCheckpointDelete","engineeringReport","chooseKeilExecutable","chooseEngineeringReportSave"]) actions.add(action);
actions.add('openEngineeringLink');
contextBridge.exposeInMainWorld('stm32', Object.freeze({
  async invoke(action, payload = {}) {
    if (!actions.has(action)) throw new Error('未支持的操作。');
    const result = await ipcRenderer.invoke('stm32:invoke', action, payload);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return result.data;
  },
}));
