const notesService = require('../services/notesService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class NotesController {
  // CRUD operations
  async createNote(req, res, next) {
    try {
      const { title, content, category, tags, isPinned, isArchived, metadata } = req.body;
      if (!title || !content) {
        throw new AppError('Title and content are required', 400);
      }
      
      const note = await notesService.createNote(
        req.user.id,
        title,
        content,
        category,
        tags,
        isPinned,
        isArchived,
        metadata
      );
      
      res.status(201).json({
        success: true,
        message: 'Note created successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Create note error:', error);
      next(error);
    }
  }

  async getAllNotes(req, res, next) {
    try {
      const { 
        page = 1, 
        limit = 20, 
        sortBy = 'updatedAt', 
        sortOrder = 'desc',
        category,
        tags,
        archived,
        pinned
      } = req.query;
      
      const filters = {
        category,
        tags: tags ? tags.split(',') : [],
        archived: archived === 'true',
        pinned: pinned === 'true'
      };
      
      const result = await notesService.getAllNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit),
        sortBy,
        sortOrder,
        filters
      );
      
      res.status(200).json({
        success: true,
        message: 'Notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get all notes error:', error);
      next(error);
    }
  }

  async getNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.getNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note retrieved successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Get note error:', error);
      next(error);
    }
  }

  async updateNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const updateData = req.body;
      
      const note = await notesService.updateNote(noteId, req.user.id, updateData);
      
      res.status(200).json({
        success: true,
        message: 'Note updated successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Update note error:', error);
      next(error);
    }
  }

  async deleteNote(req, res, next) {
    try {
      const { noteId } = req.params;
      await notesService.deleteNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note deleted successfully'
      });
    } catch (error) {
      logger.error('Delete note error:', error);
      next(error);
    }
  }

  async deleteMultipleNotes(req, res, next) {
    try {
      const { noteIds } = req.body;
      if (!noteIds || !Array.isArray(noteIds)) {
        throw new AppError('Note IDs array is required', 400);
      }
      
      const result = await notesService.deleteMultipleNotes(noteIds, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Notes deleted successfully',
        data: result
      });
    } catch (error) {
      logger.error('Delete multiple notes error:', error);
      next(error);
    }
  }

  // Note organization
  async pinNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.pinNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note pinned successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Pin note error:', error);
      next(error);
    }
  }

  async unpinNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.unpinNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note unpinned successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Unpin note error:', error);
      next(error);
    }
  }

  async getPinnedNotes(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getPinnedNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Pinned notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get pinned notes error:', error);
      next(error);
    }
  }

  async archiveNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.archiveNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note archived successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Archive note error:', error);
      next(error);
    }
  }

  async unarchiveNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.unarchiveNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note unarchived successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Unarchive note error:', error);
      next(error);
    }
  }

  async getArchivedNotes(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getArchivedNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Archived notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get archived notes error:', error);
      next(error);
    }
  }

  async favoriteNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.favoriteNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note added to favorites',
        data: { note }
      });
    } catch (error) {
      logger.error('Favorite note error:', error);
      next(error);
    }
  }

  async unfavoriteNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.unfavoriteNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note removed from favorites',
        data: { note }
      });
    } catch (error) {
      logger.error('Unfavorite note error:', error);
      next(error);
    }
  }

  async getFavoriteNotes(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getFavoriteNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Favorite notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get favorite notes error:', error);
      next(error);
    }
  }

  async lockNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const { password } = req.body;
      
      const note = await notesService.lockNote(noteId, req.user.id, password);
      
      res.status(200).json({
        success: true,
        message: 'Note locked successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Lock note error:', error);
      next(error);
    }
  }

  async unlockNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const { password } = req.body;
      
      const note = await notesService.unlockNote(noteId, req.user.id, password);
      
      res.status(200).json({
        success: true,
        message: 'Note unlocked successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Unlock note error:', error);
      next(error);
    }
  }

  async getLockedNotes(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getLockedNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Locked notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get locked notes error:', error);
      next(error);
    }
  }

  // Note sharing
  async shareNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const { recipients, permission = 'view', expiresAt, message } = req.body;
      
      if (!recipients || !Array.isArray(recipients)) {
        throw new AppError('Recipients array is required', 400);
      }
      
      const share = await notesService.shareNote(
        noteId,
        req.user.id,
        recipients,
        permission,
        expiresAt,
        message
      );
      
      res.status(200).json({
        success: true,
        message: 'Note shared successfully',
        data: { share }
      });
    } catch (error) {
      logger.error('Share note error:', error);
      next(error);
    }
  }

  async revokeShare(req, res, next) {
    try {
      const { noteId } = req.params;
      const { shareId } = req.body;
      
      await notesService.revokeShare(noteId, req.user.id, shareId);
      
      res.status(200).json({
        success: true,
        message: 'Share revoked successfully'
      });
    } catch (error) {
      logger.error('Revoke share error:', error);
      next(error);
    }
  }

  async getSharedUsers(req, res, next) {
    try {
      const { noteId } = req.params;
      const result = await notesService.getSharedUsers(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Shared users retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get shared users error:', error);
      next(error);
    }
  }

  async getNotesSharedWithMe(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getNotesSharedWithMe(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Notes shared with me retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get notes shared with me error:', error);
      next(error);
    }
  }

  async getNotesSharedByMe(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getNotesSharedByMe(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Notes shared by me retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get notes shared by me error:', error);
      next(error);
    }
  }

  // Note collaboration
  async addCollaborator(req, res, next) {
    try {
      const { noteId } = req.params;
      const { userId, permission = 'edit' } = req.body;
      
      const collaborator = await notesService.addCollaborator(
        noteId,
        req.user.id,
        userId,
        permission
      );
      
      res.status(200).json({
        success: true,
        message: 'Collaborator added successfully',
        data: { collaborator }
      });
    } catch (error) {
      logger.error('Add collaborator error:', error);
      next(error);
    }
  }

  async removeCollaborator(req, res, next) {
    try {
      const { noteId } = req.params;
      const { userId } = req.body;
      
      await notesService.removeCollaborator(noteId, req.user.id, userId);
      
      res.status(200).json({
        success: true,
        message: 'Collaborator removed successfully'
      });
    } catch (error) {
      logger.error('Remove collaborator error:', error);
      next(error);
    }
  }

  async getCollaborators(req, res, next) {
    try {
      const { noteId } = req.params;
      const result = await notesService.getCollaborators(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Collaborators retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get collaborators error:', error);
      next(error);
    }
  }

  async updateCollaboratorPermission(req, res, next) {
    try {
      const { noteId } = req.params;
      const { userId, permission } = req.body;
      
      const collaborator = await notesService.updateCollaboratorPermission(
        noteId,
        req.user.id,
        userId,
        permission
      );
      
      res.status(200).json({
        success: true,
        message: 'Collaborator permission updated successfully',
        data: { collaborator }
      });
    } catch (error) {
      logger.error('Update collaborator permission error:', error);
      next(error);
    }
  }

  // Note content operations
  async duplicateNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.duplicateNote(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note duplicated successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Duplicate note error:', error);
      next(error);
    }
  }

  async moveNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const { newCategory } = req.body;
      
      const note = await notesService.moveNote(noteId, req.user.id, newCategory);
      
      res.status(200).json({
        success: true,
        message: 'Note moved successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Move note error:', error);
      next(error);
    }
  }

  async copyNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const { targetUserId, permission = 'view' } = req.body;
      
      const copy = await notesService.copyNote(
        noteId,
        req.user.id,
        targetUserId,
        permission
      );
      
      res.status(200).json({
        success: true,
        message: 'Note copied successfully',
        data: { copy }
      });
    } catch (error) {
      logger.error('Copy note error:', error);
      next(error);
    }
  }

  async mergeNotes(req, res, next) {
    try {
      const { noteIds, title } = req.body;
      if (!noteIds || !Array.isArray(noteIds) || noteIds.length < 2) {
        throw new AppError('At least 2 note IDs are required', 400);
      }
      
      const note = await notesService.mergeNotes(noteIds, req.user.id, title);
      
      res.status(200).json({
        success: true,
        message: 'Notes merged successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Merge notes error:', error);
      next(error);
    }
  }

  // Note attachments
  async addAttachment(req, res, next) {
    try {
      const { noteId } = req.params;
      if (!req.file) {
        throw new AppError('Attachment file is required', 400);
      }
      
      const attachment = await notesService.addAttachment(
        noteId,
        req.user.id,
        req.file
      );
      
      res.status(200).json({
        success: true,
        message: 'Attachment added successfully',
        data: { attachment }
      });
    } catch (error) {
      logger.error('Add attachment error:', error);
      next(error);
    }
  }

  async removeAttachment(req, res, next) {
    try {
      const { noteId, attachmentId } = req.params;
      await notesService.removeAttachment(noteId, req.user.id, attachmentId);
      
      res.status(200).json({
        success: true,
        message: 'Attachment removed successfully'
      });
    } catch (error) {
      logger.error('Remove attachment error:', error);
      next(error);
    }
  }

  async getAttachments(req, res, next) {
    try {
      const { noteId } = req.params;
      const result = await notesService.getAttachments(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Attachments retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get attachments error:', error);
      next(error);
    }
  }

  // Note tags
  async addTag(req, res, next) {
    try {
      const { noteId } = req.params;
      const { tag } = req.body;
      
      const result = await notesService.addTag(noteId, req.user.id, tag);
      
      res.status(200).json({
        success: true,
        message: 'Tag added successfully',
        data: result
      });
    } catch (error) {
      logger.error('Add tag error:', error);
      next(error);
    }
  }

  async removeTag(req, res, next) {
    try {
      const { noteId, tagId } = req.params;
      await notesService.removeTag(noteId, req.user.id, tagId);
      
      res.status(200).json({
        success: true,
        message: 'Tag removed successfully'
      });
    } catch (error) {
      logger.error('Remove tag error:', error);
      next(error);
    }
  }

  async getNoteTags(req, res, next) {
    try {
      const { noteId } = req.params;
      const tags = await notesService.getNoteTags(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note tags retrieved successfully',
        data: { tags }
      });
    } catch (error) {
      logger.error('Get note tags error:', error);
      next(error);
    }
  }

  async updateTags(req, res, next) {
    try {
      const { noteId } = req.params;
      const { tags } = req.body;
      
      const result = await notesService.updateTags(noteId, req.user.id, tags);
      
      res.status(200).json({
        success: true,
        message: 'Tags updated successfully',
        data: result
      });
    } catch (error) {
      logger.error('Update tags error:', error);
      next(error);
    }
  }

  // Note categories/notebooks
  async createCategory(req, res, next) {
    try {
      const { name, description, color, parentId } = req.body;
      if (!name) {
        throw new AppError('Category name is required', 400);
      }
      
      const category = await notesService.createCategory(
        req.user.id,
        name,
        description,
        color,
        parentId
      );
      
      res.status(201).json({
        success: true,
        message: 'Category created successfully',
        data: { category }
      });
    } catch (error) {
      logger.error('Create category error:', error);
      next(error);
    }
  }

  async getAllCategories(req, res, next) {
    try {
      const { includeNotes = false } = req.query;
      const categories = await notesService.getAllCategories(
        req.user.id,
        includeNotes === 'true'
      );
      
      res.status(200).json({
        success: true,
        message: 'Categories retrieved successfully',
        data: { categories }
      });
    } catch (error) {
      logger.error('Get all categories error:', error);
      next(error);
    }
  }

  async getCategory(req, res, next) {
    try {
      const { categoryId } = req.params;
      const { includeNotes = false } = req.query;
      
      const category = await notesService.getCategory(
        categoryId,
        req.user.id,
        includeNotes === 'true'
      );
      
      res.status(200).json({
        success: true,
        message: 'Category retrieved successfully',
        data: { category }
      });
    } catch (error) {
      logger.error('Get category error:', error);
      next(error);
    }
  }

  async updateCategory(req, res, next) {
    try {
      const { categoryId } = req.params;
      const updateData = req.body;
      
      const category = await notesService.updateCategory(
        categoryId,
        req.user.id,
        updateData
      );
      
      res.status(200).json({
        success: true,
        message: 'Category updated successfully',
        data: { category }
      });
    } catch (error) {
      logger.error('Update category error:', error);
      next(error);
    }
  }

  async deleteCategory(req, res, next) {
    try {
      const { categoryId } = req.params;
      const { moveNotesTo } = req.query;
      
      await notesService.deleteCategory(
        categoryId,
        req.user.id,
        moveNotesTo
      );
      
      res.status(200).json({
        success: true,
        message: 'Category deleted successfully'
      });
    } catch (error) {
      logger.error('Delete category error:', error);
      next(error);
    }
  }

  async getNotesByCategory(req, res, next) {
    try {
      const { categoryId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      
      const result = await notesService.getNotesByCategory(
        categoryId,
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Category notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get notes by category error:', error);
      next(error);
    }
  }

  // Note templates
  async createTemplate(req, res, next) {
    try {
      const { name, content, category, tags, isPublic = false } = req.body;
      if (!name || !content) {
        throw new AppError('Name and content are required', 400);
      }
      
      const template = await notesService.createTemplate(
        req.user.id,
        name,
        content,
        category,
        tags,
        isPublic
      );
      
      res.status(201).json({
        success: true,
        message: 'Template created successfully',
        data: { template }
      });
    } catch (error) {
      logger.error('Create template error:', error);
      next(error);
    }
  }

  async getAllTemplates(req, res, next) {
    try {
      const { includePublic = false } = req.query;
      const templates = await notesService.getAllTemplates(
        req.user.id,
        includePublic === 'true'
      );
      
      res.status(200).json({
        success: true,
        message: 'Templates retrieved successfully',
        data: { templates }
      });
    } catch (error) {
      logger.error('Get all templates error:', error);
      next(error);
    }
  }

  async getTemplate(req, res, next) {
    try {
      const { templateId } = req.params;
      const template = await notesService.getTemplate(templateId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Template retrieved successfully',
        data: { template }
      });
    } catch (error) {
      logger.error('Get template error:', error);
      next(error);
    }
  }

  async updateTemplate(req, res, next) {
    try {
      const { templateId } = req.params;
      const updateData = req.body;
      
      const template = await notesService.updateTemplate(
        templateId,
        req.user.id,
        updateData
      );
      
      res.status(200).json({
        success: true,
        message: 'Template updated successfully',
        data: { template }
      });
    } catch (error) {
      logger.error('Update template error:', error);
      next(error);
    }
  }

  async deleteTemplate(req, res, next) {
    try {
      const { templateId } = req.params;
      await notesService.deleteTemplate(templateId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Template deleted successfully'
      });
    } catch (error) {
      logger.error('Delete template error:', error);
      next(error);
    }
  }

  async applyTemplate(req, res, next) {
    try {
      const { noteId, templateId } = req.params;
      const note = await notesService.applyTemplate(noteId, templateId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Template applied successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Apply template error:', error);
      next(error);
    }
  }

  // Note versions/history
  async saveVersion(req, res, next) {
    try {
      const { noteId } = req.params;
      const { name, description } = req.body;
      
      const version = await notesService.saveVersion(
        noteId,
        req.user.id,
        name,
        description
      );
      
      res.status(201).json({
        success: true,
        message: 'Version saved successfully',
        data: { version }
      });
    } catch (error) {
      logger.error('Save version error:', error);
      next(error);
    }
  }

  async getVersions(req, res, next) {
    try {
      const { noteId } = req.params;
      const versions = await notesService.getVersions(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Versions retrieved successfully',
        data: { versions }
      });
    } catch (error) {
      logger.error('Get versions error:', error);
      next(error);
    }
  }

  async getVersion(req, res, next) {
    try {
      const { noteId, versionId } = req.params;
      const version = await notesService.getVersion(
        noteId,
        versionId,
        req.user.id
      );
      
      res.status(200).json({
        success: true,
        message: 'Version retrieved successfully',
        data: { version }
      });
    } catch (error) {
      logger.error('Get version error:', error);
      next(error);
    }
  }

  async restoreVersion(req, res, next) {
    try {
      const { noteId, versionId } = req.params;
      const note = await notesService.restoreVersion(
        noteId,
        versionId,
        req.user.id
      );
      
      res.status(200).json({
        success: true,
        message: 'Version restored successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Restore version error:', error);
      next(error);
    }
  }

  async deleteVersion(req, res, next) {
    try {
      const { noteId, versionId } = req.params;
      await notesService.deleteVersion(noteId, versionId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Version deleted successfully'
      });
    } catch (error) {
      logger.error('Delete version error:', error);
      next(error);
    }
  }

  // Note reminders
  async addReminder(req, res, next) {
    try {
      const { noteId } = req.params;
      const { date, time, repeat, message } = req.body;
      
      const reminder = await notesService.addReminder(
        noteId,
        req.user.id,
        date,
        time,
        repeat,
        message
      );
      
      res.status(201).json({
        success: true,
        message: 'Reminder added successfully',
        data: { reminder }
      });
    } catch (error) {
      logger.error('Add reminder error:', error);
      next(error);
    }
  }

  async updateReminder(req, res, next) {
    try {
      const { noteId, reminderId } = req.params;
      const updateData = req.body;
      
      const reminder = await notesService.updateReminder(
        noteId,
        reminderId,
        req.user.id,
        updateData
      );
      
      res.status(200).json({
        success: true,
        message: 'Reminder updated successfully',
        data: { reminder }
      });
    } catch (error) {
      logger.error('Update reminder error:', error);
      next(error);
    }
  }

  async removeReminder(req, res, next) {
    try {
      const { noteId, reminderId } = req.params;
      await notesService.removeReminder(noteId, reminderId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Reminder removed successfully'
      });
    } catch (error) {
      logger.error('Remove reminder error:', error);
      next(error);
    }
  }

  async getReminders(req, res, next) {
    try {
      const { noteId } = req.params;
      const reminders = await notesService.getReminders(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Reminders retrieved successfully',
        data: { reminders }
      });
    } catch (error) {
      logger.error('Get reminders error:', error);
      next(error);
    }
  }

  async getUpcomingReminders(req, res, next) {
    try {
      const { days = 7 } = req.query;
      const reminders = await notesService.getUpcomingReminders(
        req.user.id,
        parseInt(days)
      );
      
      res.status(200).json({
        success: true,
        message: 'Upcoming reminders retrieved successfully',
        data: { reminders }
      });
    } catch (error) {
      logger.error('Get upcoming reminders error:', error);
      next(error);
    }
  }

  // Note comments
  async addComment(req, res, next) {
    try {
      const { noteId } = req.params;
      const { content, parentId } = req.body;
      
      const comment = await notesService.addComment(
        noteId,
        req.user.id,
        content,
        parentId
      );
      
      res.status(201).json({
        success: true,
        message: 'Comment added successfully',
        data: { comment }
      });
    } catch (error) {
      logger.error('Add comment error:', error);
      next(error);
    }
  }

  async updateComment(req, res, next) {
    try {
      const { noteId, commentId } = req.params;
      const { content } = req.body;
      
      const comment = await notesService.updateComment(
        noteId,
        commentId,
        req.user.id,
        content
      );
      
      res.status(200).json({
        success: true,
        message: 'Comment updated successfully',
        data: { comment }
      });
    } catch (error) {
      logger.error('Update comment error:', error);
      next(error);
    }
  }

  async deleteComment(req, res, next) {
    try {
      const { noteId, commentId } = req.params;
      await notesService.deleteComment(noteId, commentId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Comment deleted successfully'
      });
    } catch (error) {
      logger.error('Delete comment error:', error);
      next(error);
    }
  }

  async getComments(req, res, next) {
    try {
      const { noteId } = req.params;
      const comments = await notesService.getComments(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Comments retrieved successfully',
        data: { comments }
      });
    } catch (error) {
      logger.error('Get comments error:', error);
      next(error);
    }
  }

  // Note tasks/checklists
  async addChecklist(req, res, next) {
    try {
      const { noteId } = req.params;
      const { title, items } = req.body;
      
      const checklist = await notesService.addChecklist(
        noteId,
        req.user.id,
        title,
        items
      );
      
      res.status(201).json({
        success: true,
        message: 'Checklist added successfully',
        data: { checklist }
      });
    } catch (error) {
      logger.error('Add checklist error:', error);
      next(error);
    }
  }

  async updateChecklist(req, res, next) {
    try {
      const { noteId, checklistId } = req.params;
      const updateData = req.body;
      
      const checklist = await notesService.updateChecklist(
        noteId,
        checklistId,
        req.user.id,
        updateData
      );
      
      res.status(200).json({
        success: true,
        message: 'Checklist updated successfully',
        data: { checklist }
      });
    } catch (error) {
      logger.error('Update checklist error:', error);
      next(error);
    }
  }

  async deleteChecklist(req, res, next) {
    try {
      const { noteId, checklistId } = req.params;
      await notesService.deleteChecklist(noteId, checklistId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Checklist deleted successfully'
      });
    } catch (error) {
      logger.error('Delete checklist error:', error);
      next(error);
    }
  }

  async getChecklists(req, res, next) {
    try {
      const { noteId } = req.params;
      const checklists = await notesService.getChecklists(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Checklists retrieved successfully',
        data: { checklists }
      });
    } catch (error) {
      logger.error('Get checklists error:', error);
      next(error);
    }
  }

  async addChecklistItem(req, res, next) {
    try {
      const { noteId, checklistId } = req.params;
      const { text } = req.body;
      
      const item = await notesService.addChecklistItem(
        noteId,
        checklistId,
        req.user.id,
        text
      );
      
      res.status(201).json({
        success: true,
        message: 'Checklist item added successfully',
        data: { item }
      });
    } catch (error) {
      logger.error('Add checklist item error:', error);
      next(error);
    }
  }

  async updateChecklistItem(req, res, next) {
    try {
      const { noteId, checklistId, itemId } = req.params;
      const updateData = req.body;
      
      const item = await notesService.updateChecklistItem(
        noteId,
        checklistId,
        itemId,
        req.user.id,
        updateData
      );
      
      res.status(200).json({
        success: true,
        message: 'Checklist item updated successfully',
        data: { item }
      });
    } catch (error) {
      logger.error('Update checklist item error:', error);
      next(error);
    }
  }

  async deleteChecklistItem(req, res, next) {
    try {
      const { noteId, checklistId, itemId } = req.params;
      await notesService.deleteChecklistItem(
        noteId,
        checklistId,
        itemId,
        req.user.id
      );
      
      res.status(200).json({
        success: true,
        message: 'Checklist item deleted successfully'
      });
    } catch (error) {
      logger.error('Delete checklist item error:', error);
      next(error);
    }
  }

  async toggleChecklistItem(req, res, next) {
    try {
      const { noteId, checklistId, itemId } = req.params;
      const item = await notesService.toggleChecklistItem(
        noteId,
        checklistId,
        itemId,
        req.user.id
      );
      
      res.status(200).json({
        success: true,
        message: 'Checklist item toggled successfully',
        data: { item }
      });
    } catch (error) {
      logger.error('Toggle checklist item error:', error);
      next(error);
    }
  }

  // Note links
  async addLink(req, res, next) {
    try {
      const { noteId } = req.params;
      const { url, title, description } = req.body;
      
      const link = await notesService.addLink(
        noteId,
        req.user.id,
        url,
        title,
        description
      );
      
      res.status(201).json({
        success: true,
        message: 'Link added successfully',
        data: { link }
      });
    } catch (error) {
      logger.error('Add link error:', error);
      next(error);
    }
  }

  async removeLink(req, res, next) {
    try {
      const { noteId, linkId } = req.params;
      await notesService.removeLink(noteId, linkId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Link removed successfully'
      });
    } catch (error) {
      logger.error('Remove link error:', error);
      next(error);
    }
  }

  async getLinks(req, res, next) {
    try {
      const { noteId } = req.params;
      const links = await notesService.getLinks(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Links retrieved successfully',
        data: { links }
      });
    } catch (error) {
      logger.error('Get links error:', error);
      next(error);
    }
  }

  // Note statistics
  async getOverviewStats(req, res, next) {
    try {
      const stats = await notesService.getOverviewStats(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Overview stats retrieved successfully',
        data: { stats }
      });
    } catch (error) {
      logger.error('Get overview stats error:', error);
      next(error);
    }
  }

  async getCategoryStats(req, res, next) {
    try {
      const stats = await notesService.getCategoryStats(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Category stats retrieved successfully',
        data: { stats }
      });
    } catch (error) {
      logger.error('Get category stats error:', error);
      next(error);
    }
  }

  async getTagStats(req, res, next) {
    try {
      const stats = await notesService.getTagStats(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Tag stats retrieved successfully',
        data: { stats }
      });
    } catch (error) {
      logger.error('Get tag stats error:', error);
      next(error);
    }
  }

  async getActivityStats(req, res, next) {
    try {
      const { days = 30 } = req.query;
      const stats = await notesService.getActivityStats(
        req.user.id,
        parseInt(days)
      );
      
      res.status(200).json({
        success: true,
        message: 'Activity stats retrieved successfully',
        data: { stats }
      });
    } catch (error) {
      logger.error('Get activity stats error:', error);
      next(error);
    }
  }

  // Note search
  async searchNotes(req, res, next) {
    try {
      const { 
        query, 
        page = 1, 
        limit = 20,
        includeContent = false 
      } = req.query;
      
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await notesService.searchNotes(
        query,
        req.user.id,
        parseInt(page),
        parseInt(limit),
        includeContent === 'true'
      );
      
      res.status(200).json({
        success: true,
        message: 'Notes search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search notes error:', error);
      next(error);
    }
  }

  async searchByTags(req, res, next) {
    try {
      const { 
        tags, 
        operator = 'AND', 
        page = 1, 
        limit = 20 
      } = req.query;
      
      if (!tags) {
        throw new AppError('Tags are required', 400);
      }
      
      const tagArray = Array.isArray(tags) ? tags : tags.split(',');
      const result = await notesService.searchByTags(
        tagArray,
        operator,
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Tag search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by tags error:', error);
      next(error);
    }
  }

  async searchByCategory(req, res, next) {
    try {
      const { 
        category, 
        subcategory, 
        page = 1, 
        limit = 20 
      } = req.query;
      
      if (!category) {
        throw new AppError('Category is required', 400);
      }
      
      const result = await notesService.searchByCategory(
        category,
        subcategory,
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Category search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by category error:', error);
      next(error);
    }
  }

  async searchByDate(req, res, next) {
    try {
      const { 
        date, 
        range = 'exact', 
        page = 1, 
        limit = 20 
      } = req.query;
      
      if (!date) {
        throw new AppError('Date is required', 400);
      }
      
      const result = await notesService.searchByDate(
        date,
        range,
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Date search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by date error:', error);
      next(error);
    }
  }

  // Note export/import
  async exportNote(req, res, next) {
    try {
      const { noteId } = req.params;
      const { format = 'json' } = req.body;
      
      const result = await notesService.exportNote(
        noteId,
        req.user.id,
        format
      );
      
      if (format === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=note_${noteId}.pdf`);
        return res.send(result);
      } else if (format === 'txt') {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename=note_${noteId}.txt`);
        return res.send(result);
      } else {
        res.status(200).json({
          success: true,
          message: 'Note exported successfully',
          data: result
        });
      }
    } catch (error) {
      logger.error('Export note error:', error);
      next(error);
    }
  }

  async exportNotes(req, res, next) {
    try {
      const { noteIds, format = 'json', includeAttachments = false } = req.body;
      
      if (!noteIds || !Array.isArray(noteIds)) {
        throw new AppError('Note IDs array is required', 400);
      }
      
      const result = await notesService.exportNotes(
        noteIds,
        req.user.id,
        format,
        includeAttachments
      );
      
      if (format === 'zip') {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=notes_export_${new Date().toISOString().split('T')[0]}.zip`);
        return res.send(result);
      } else {
        res.status(200).json({
          success: true,
          message: 'Notes exported successfully',
          data: result
        });
      }
    } catch (error) {
      logger.error('Export notes error:', error);
      next(error);
    }
  }

  async importNotes(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('Import file is required', 400);
      }
      
      const { format, category, tags } = req.body;
      const result = await notesService.importNotes(
        req.file,
        req.user.id,
        format,
        category,
        tags
      );
      
      res.status(201).json({
        success: true,
        message: 'Notes imported successfully',
        data: result
      });
    } catch (error) {
      logger.error('Import notes error:', error);
      next(error);
    }
  }

  async importMultipleNotes(req, res, next) {
    try {
      if (!req.files || req.files.length === 0) {
        throw new AppError('Import files are required', 400);
      }
      
      const { category, tags } = req.body;
      const result = await notesService.importMultipleNotes(
        req.files,
        req.user.id,
        category,
        tags
      );
      
      res.status(201).json({
        success: true,
        message: 'Multiple notes imported successfully',
        data: result
      });
    } catch (error) {
      logger.error('Import multiple notes error:', error);
      next(error);
    }
  }

  // Note backup
  async createBackup(req, res, next) {
    try {
      const { type = 'full', includeAttachments = true } = req.body;
      const result = await notesService.createBackup(
        req.user.id,
        type,
        includeAttachments
      );
      
      res.status(201).json({
        success: true,
        message: 'Backup created successfully',
        data: result
      });
    } catch (error) {
      logger.error('Create backup error:', error);
      next(error);
    }
  }

  async listBackups(req, res, next) {
    try {
      const backups = await notesService.listBackups(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Backups listed successfully',
        data: { backups }
      });
    } catch (error) {
      logger.error('List backups error:', error);
      next(error);
    }
  }

  async restoreBackup(req, res, next) {
    try {
      const { backupId } = req.body;
      if (!backupId) {
        throw new AppError('Backup ID is required', 400);
      }
      
      await notesService.restoreBackup(backupId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Backup restored successfully'
      });
    } catch (error) {
      logger.error('Restore backup error:', error);
      next(error);
    }
  }

  // Note recycling bin
  async moveToTrash(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.moveToTrash(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note moved to trash',
        data: { note }
      });
    } catch (error) {
      logger.error('Move to trash error:', error);
      next(error);
    }
  }

  async getTrashedNotes(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getTrashedNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Trashed notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get trashed notes error:', error);
      next(error);
    }
  }

  async emptyTrash(req, res, next) {
    try {
      const result = await notesService.emptyTrash(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Trash emptied successfully',
        data: result
      });
    } catch (error) {
      logger.error('Empty trash error:', error);
      next(error);
    }
  }

  async restoreFromTrash(req, res, next) {
    try {
      const { noteId } = req.params;
      const note = await notesService.restoreFromTrash(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note restored from trash',
        data: { note }
      });
    } catch (error) {
      logger.error('Restore from trash error:', error);
      next(error);
    }
  }

  async deletePermanently(req, res, next) {
    try {
      const { noteId } = req.params;
      await notesService.deletePermanently(noteId, req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note permanently deleted'
      });
    } catch (error) {
      logger.error('Delete permanently error:', error);
      next(error);
    }
  }

  // Note settings
  async getNoteSettings(req, res, next) {
    try {
      const settings = await notesService.getNoteSettings(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Note settings retrieved successfully',
        data: { settings }
      });
    } catch (error) {
      logger.error('Get note settings error:', error);
      next(error);
    }
  }

  async updateNoteSettings(req, res, next) {
    try {
      const settings = req.body;
      const updatedSettings = await notesService.updateNoteSettings(
        req.user.id,
        settings
      );
      
      res.status(200).json({
        success: true,
        message: 'Note settings updated successfully',
        data: { settings: updatedSettings }
      });
    } catch (error) {
      logger.error('Update note settings error:', error);
      next(error);
    }
  }

  // Note sorting/filtering
  async getSortedNotes(req, res, next) {
    try {
      const { sortBy } = req.params;
      const { page = 1, limit = 20 } = req.query;
      
      const result = await notesService.getSortedNotes(
        req.user.id,
        sortBy,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Sorted notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get sorted notes error:', error);
      next(error);
    }
  }

  async filterNotes(req, res, next) {
    try {
      const filters = req.body;
      const { page = 1, limit = 20 } = req.query;
      
      const result = await notesService.filterNotes(
        req.user.id,
        filters,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Filtered notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Filter notes error:', error);
      next(error);
    }
  }

  // Quick notes
  async createQuickNote(req, res, next) {
    try {
      const { content } = req.body;
      if (!content) {
        throw new AppError('Content is required', 400);
      }
      
      const note = await notesService.createQuickNote(req.user.id, content);
      
      res.status(201).json({
        success: true,
        message: 'Quick note created successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Create quick note error:', error);
      next(error);
    }
  }

  async getRecentQuickNotes(req, res, next) {
    try {
      const { limit = 10 } = req.query;
      const notes = await notesService.getRecentQuickNotes(
        req.user.id,
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Recent quick notes retrieved successfully',
        data: { notes }
      });
    } catch (error) {
      logger.error('Get recent quick notes error:', error);
      next(error);
    }
  }

  // Note synchronization
  async getSyncStatus(req, res, next) {
    try {
      const status = await notesService.getSyncStatus(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Sync status retrieved successfully',
        data: { status }
      });
    } catch (error) {
      logger.error('Get sync status error:', error);
      next(error);
    }
  }

  async pullChanges(req, res, next) {
    try {
      const changes = await notesService.pullChanges(req.user.id);
      
      res.status(200).json({
        success: true,
        message: 'Changes pulled successfully',
        data: { changes }
      });
    } catch (error) {
      logger.error('Pull changes error:', error);
      next(error);
    }
  }

  async pushChanges(req, res, next) {
    try {
      const { changes } = req.body;
      const result = await notesService.pushChanges(req.user.id, changes);
      
      res.status(200).json({
        success: true,
        message: 'Changes pushed successfully',
        data: result
      });
    } catch (error) {
      logger.error('Push changes error:', error);
      next(error);
    }
  }

  async resolveConflicts(req, res, next) {
    try {
      const { conflicts } = req.body;
      const result = await notesService.resolveConflicts(req.user.id, conflicts);
      
      res.status(200).json({
        success: true,
        message: 'Conflicts resolved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Resolve conflicts error:', error);
      next(error);
    }
  }

  // Note web clipping
  async clipWebContent(req, res, next) {
    try {
      const { url, title, content, tags } = req.body;
      if (!url || !content) {
        throw new AppError('URL and content are required', 400);
      }
      
      const note = await notesService.clipWebContent(
        req.user.id,
        url,
        title,
        content,
        tags
      );
      
      res.status(201).json({
        success: true,
        message: 'Web content clipped successfully',
        data: { note }
      });
    } catch (error) {
      logger.error('Clip web content error:', error);
      next(error);
    }
  }

  async getClippedNotes(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await notesService.getClippedNotes(
        req.user.id,
        parseInt(page),
        parseInt(limit)
      );
      
      res.status(200).json({
        success: true,
        message: 'Clipped notes retrieved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Get clipped notes error:', error);
      next(error);
    }
  }
}

module.exports = new NotesController();