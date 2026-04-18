const path = require('path');
const express = require('express');
const router = express.Router();
const { apiRateLimiter } = require('../middleware/rateLimiter');
const notesController = require('../controllers/notesController');

// All routes are protected by parent auth middleware in server.js
// No need for router.use(authenticateToken) or router.use(authenticate) as parent handles it

console.log('✅ Notes routes initialized');

// ============ STATIC ROUTES (must come before /:noteId routes) ============

// Note organization - static endpoints
router.get('/pinned', apiRateLimiter, notesController.getPinnedNotes);
router.get('/archived', apiRateLimiter, notesController.getArchivedNotes);
router.get('/favorites', apiRateLimiter, notesController.getFavoriteNotes);
router.get('/locked', apiRateLimiter, notesController.getLockedNotes);

// Note sharing - static endpoints
router.get('/shared/with-me', apiRateLimiter, notesController.getNotesSharedWithMe);
router.get('/shared/by-me', apiRateLimiter, notesController.getNotesSharedByMe);

// Note categories/notebooks - static endpoints
router.post('/categories', apiRateLimiter, notesController.createCategory);
router.get('/categories', apiRateLimiter, notesController.getAllCategories);
router.get('/categories/:categoryId', apiRateLimiter, notesController.getCategory);
router.put('/categories/:categoryId', apiRateLimiter, notesController.updateCategory);
router.delete('/categories/:categoryId', apiRateLimiter, notesController.deleteCategory);
router.get('/categories/:categoryId/notes', apiRateLimiter, notesController.getNotesByCategory);

// Note templates - static endpoints
router.post('/templates', apiRateLimiter, notesController.createTemplate);
router.get('/templates', apiRateLimiter, notesController.getAllTemplates);
router.get('/templates/:templateId', apiRateLimiter, notesController.getTemplate);
router.put('/templates/:templateId', apiRateLimiter, notesController.updateTemplate);
router.delete('/templates/:templateId', apiRateLimiter, notesController.deleteTemplate);

// Note reminders - static endpoints
router.get('/reminders/upcoming', apiRateLimiter, notesController.getUpcomingReminders);

// Note statistics - static endpoints
router.get('/stats/overview', apiRateLimiter, notesController.getOverviewStats);
router.get('/stats/categories', apiRateLimiter, notesController.getCategoryStats);
router.get('/stats/tags', apiRateLimiter, notesController.getTagStats);
router.get('/stats/activity', apiRateLimiter, notesController.getActivityStats);

// Note search - static endpoints
router.get('/search/text', apiRateLimiter, notesController.searchNotes);
router.get('/search/tags', apiRateLimiter, notesController.searchByTags);
router.get('/search/category', apiRateLimiter, notesController.searchByCategory);
router.get('/search/date', apiRateLimiter, notesController.searchByDate);

// Note settings - static endpoints
router.get('/settings', apiRateLimiter, notesController.getNoteSettings);
router.put('/settings', apiRateLimiter, notesController.updateNoteSettings);

// Quick notes - static endpoints
router.get('/quick/recent', apiRateLimiter, notesController.getRecentQuickNotes);

// Note synchronization - static endpoints
router.get('/sync/status', apiRateLimiter, notesController.getSyncStatus);
router.post('/sync/pull', apiRateLimiter, notesController.pullChanges);
router.post('/sync/push', apiRateLimiter, notesController.pushChanges);
router.post('/sync/resolve', apiRateLimiter, notesController.resolveConflicts);

// Note backup - static endpoints
router.post('/backup/create', apiRateLimiter, notesController.createBackup);
router.get('/backup/list', apiRateLimiter, notesController.listBackups);
router.post('/backup/restore', apiRateLimiter, notesController.restoreBackup);

// Trash/recycling bin - static endpoints
router.get('/trash', apiRateLimiter, notesController.getTrashedNotes);
router.post('/trash/empty', apiRateLimiter, notesController.emptyTrash);

// Web clipping - static endpoints
router.get('/clipped', apiRateLimiter, notesController.getClippedNotes);

// Merge notes - static endpoint
router.post('/merge', apiRateLimiter, notesController.mergeNotes);

// Sorting/filtering - static endpoints
router.get('/sort/:sortBy', apiRateLimiter, notesController.getSortedNotes);
router.post('/filter', apiRateLimiter, notesController.filterNotes);

// ============ DYNAMIC ROUTES (with :noteId parameter) ============

// CRUD operations
router.post('/', apiRateLimiter, notesController.createNote);
router.get('/', apiRateLimiter, notesController.getAllNotes);
router.delete('/', apiRateLimiter, notesController.deleteMultipleNotes);

// Note CRUD with specific ID
router.get('/:noteId', apiRateLimiter, notesController.getNote);
router.put('/:noteId', apiRateLimiter, notesController.updateNote);
router.delete('/:noteId', apiRateLimiter, notesController.deleteNote);

// Note organization (with specific noteId)
router.post('/:noteId/pin', apiRateLimiter, notesController.pinNote);
router.post('/:noteId/unpin', apiRateLimiter, notesController.unpinNote);
router.post('/:noteId/archive', apiRateLimiter, notesController.archiveNote);
router.post('/:noteId/unarchive', apiRateLimiter, notesController.unarchiveNote);
router.post('/:noteId/favorite', apiRateLimiter, notesController.favoriteNote);
router.post('/:noteId/unfavorite', apiRateLimiter, notesController.unfavoriteNote);
router.post('/:noteId/lock', apiRateLimiter, notesController.lockNote);
router.post('/:noteId/unlock', apiRateLimiter, notesController.unlockNote);

// Note sharing (with specific noteId)
router.post('/:noteId/share', apiRateLimiter, notesController.shareNote);
router.post('/:noteId/share/revoke', apiRateLimiter, notesController.revokeShare);
router.get('/:noteId/shared', apiRateLimiter, notesController.getSharedUsers);

// Note collaboration (with specific noteId)
router.post('/:noteId/collaborators/add', apiRateLimiter, notesController.addCollaborator);
router.post('/:noteId/collaborators/remove', apiRateLimiter, notesController.removeCollaborator);
router.get('/:noteId/collaborators', apiRateLimiter, notesController.getCollaborators);
router.post('/:noteId/collaborate/permission', apiRateLimiter, notesController.updateCollaboratorPermission);

// Note content operations (with specific noteId)
router.post('/:noteId/duplicate', apiRateLimiter, notesController.duplicateNote);
router.post('/:noteId/move', apiRateLimiter, notesController.moveNote);
router.post('/:noteId/copy', apiRateLimiter, notesController.copyNote);

// Note attachments (with specific noteId)
router.post('/:noteId/attachments', apiRateLimiter, notesController.addAttachment);
router.delete('/:noteId/attachments/:attachmentId', apiRateLimiter, notesController.removeAttachment);
router.get('/:noteId/attachments', apiRateLimiter, notesController.getAttachments);

// Note tags (with specific noteId)
router.post('/:noteId/tags', apiRateLimiter, notesController.addTag);
router.delete('/:noteId/tags/:tagId', apiRateLimiter, notesController.removeTag);
router.get('/:noteId/tags', apiRateLimiter, notesController.getNoteTags);
router.put('/:noteId/tags', apiRateLimiter, notesController.updateTags);

// Note templates - apply to specific note
router.post('/:noteId/apply-template/:templateId', apiRateLimiter, notesController.applyTemplate);

// Note versions/history (with specific noteId)
router.post('/:noteId/versions/save', apiRateLimiter, notesController.saveVersion);
router.get('/:noteId/versions', apiRateLimiter, notesController.getVersions);
router.get('/:noteId/versions/:versionId', apiRateLimiter, notesController.getVersion);
router.post('/:noteId/restore/:versionId', apiRateLimiter, notesController.restoreVersion);
router.delete('/:noteId/versions/:versionId', apiRateLimiter, notesController.deleteVersion);

// Note reminders (with specific noteId)
router.post('/:noteId/reminders', apiRateLimiter, notesController.addReminder);
router.put('/:noteId/reminders/:reminderId', apiRateLimiter, notesController.updateReminder);
router.delete('/:noteId/reminders/:reminderId', apiRateLimiter, notesController.removeReminder);
router.get('/:noteId/reminders', apiRateLimiter, notesController.getReminders);

// Note comments (with specific noteId)
router.post('/:noteId/comments', apiRateLimiter, notesController.addComment);
router.put('/:noteId/comments/:commentId', apiRateLimiter, notesController.updateComment);
router.delete('/:noteId/comments/:commentId', apiRateLimiter, notesController.deleteComment);
router.get('/:noteId/comments', apiRateLimiter, notesController.getComments);

// Note tasks/checklists (with specific noteId)
router.post('/:noteId/checklists', apiRateLimiter, notesController.addChecklist);
router.put('/:noteId/checklists/:checklistId', apiRateLimiter, notesController.updateChecklist);
router.delete('/:noteId/checklists/:checklistId', apiRateLimiter, notesController.deleteChecklist);
router.get('/:noteId/checklists', apiRateLimiter, notesController.getChecklists);
router.post('/:noteId/checklists/:checklistId/items', apiRateLimiter, notesController.addChecklistItem);
router.put('/:noteId/checklists/:checklistId/items/:itemId', apiRateLimiter, notesController.updateChecklistItem);
router.delete('/:noteId/checklists/:checklistId/items/:itemId', apiRateLimiter, notesController.deleteChecklistItem);
router.post('/:noteId/checklists/:checklistId/items/:itemId/toggle', apiRateLimiter, notesController.toggleChecklistItem);

// Note links (with specific noteId)
router.post('/:noteId/links', apiRateLimiter, notesController.addLink);
router.delete('/:noteId/links/:linkId', apiRateLimiter, notesController.removeLink);
router.get('/:noteId/links', apiRateLimiter, notesController.getLinks);

// Note export (with specific noteId)
router.post('/:noteId/export', apiRateLimiter, notesController.exportNote);

// Trash operations (with specific noteId)
router.post('/:noteId/trash', apiRateLimiter, notesController.moveToTrash);
router.post('/trash/:noteId/restore', apiRateLimiter, notesController.restoreFromTrash);
router.delete('/trash/:noteId', apiRateLimiter, notesController.deletePermanently);

// Quick note creation (no ID needed, but POST is fine here)
router.post('/quick', apiRateLimiter, notesController.createQuickNote);

// Web clipping (POST is fine here)
router.post('/clip', apiRateLimiter, notesController.clipWebContent);

// Export/import batch operations (static, no noteId)
router.post('/export/batch', apiRateLimiter, notesController.exportNotes);
router.post('/import', apiRateLimiter, notesController.importNotes);
router.post('/import/multiple', apiRateLimiter, notesController.importMultipleNotes);

module.exports = router;