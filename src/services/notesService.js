const { Op } = require('sequelize');
// FIX-DB-SINGLE-INSTANCE: previously required '../config/database', which
// lazily instantiates its OWN separate Sequelize connection (with its own,
// different DB-name fallback) used nowhere else in the app. sequelize.fn/
// sequelize.col are static query-builder helpers, not per-connection state,
// so there's no functional reason to keep a second connection alive just
// for them. Pointing at the same instance models/index.js exports removes
// the redundant connection and the inconsistent fallback name with it.
const { sequelize } = require('../models');
const Note = require('../models/Notes');
const User = require('../models/Users');
const File = require('../models/File');
const Category = require('../models/Category');
const Template = require('../models/Template');
const logger = require('../utils/logger');
const { ServerError, ValidationError, NotFoundError } = require('../utils/errors');

class NotesService {
  constructor() {
    // Initialize any required services
  }

  // CRUD operations
  async createNote(userId, title, content, category, tags, isPinned, isArchived, metadata) {
    try {
      const note = await Note.create({
        userId,
        title,
        content,
        category: category || 'Uncategorized',
        tags: tags || [],
        isPinned: isPinned || false,
        isArchived: isArchived || false,
        metadata: metadata || {},
        lastEditedBy: userId,
        version: 1
      });

      logger.info('Note created:', { noteId: note.id, userId });
      return note;
    } catch (error) {
      logger.error('Create note service error:', error);
      throw new ServerError('Failed to create note');
    }
  }

  async getAllNotes(userId, page, limit, sortBy, sortOrder, filters) {
    try {
      const offset = (page - 1) * limit;
      const whereCondition = { userId };

      // Apply filters
      if (filters.category) {
        whereCondition.category = filters.category;
      }

      if (filters.tags && filters.tags.length > 0) {
        whereCondition.tags = { [Op.overlap]: filters.tags };
      }

      if (filters.archived !== undefined) {
        whereCondition.isArchived = filters.archived;
      }

      if (filters.pinned !== undefined) {
        whereCondition.isPinned = filters.pinned;
      }

      // Determine sort order
      const order = [];
      if (sortBy && sortOrder) {
        order.push([sortBy, sortOrder.toUpperCase()]);
      } else {
        order.push(['updatedAt', 'DESC']);
      }

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        order,
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get all notes service error:', error);
      throw new ServerError('Failed to get notes');
    }
  }

  async getNote(noteId, userId) {
    try {
      const note = await Note.findOne({
        where: {
          id: noteId,
          [Op.or]: [
            { userId },
            { sharedWith: { [Op.contains]: [userId] } }
          ]
        }
      });

      if (!note) {
        throw new NotFoundError('Note not found or access denied');
      }

      return note;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Get note service error:', error);
      throw new ServerError('Failed to get note');
    }
  }

  async updateNote(noteId, userId, updateData) {
    try {
      const note = await this.getNote(noteId, userId);

      // Check if user has edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Update note
      const updatedFields = {
        ...updateData,
        lastEditedBy: userId,
        version: note.version + 1,
        updatedAt: new Date()
      };

      await note.update(updatedFields);

      logger.info('Note updated:', { noteId, userId });
      return note;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Update note service error:', error);
      throw new ServerError('Failed to update note');
    }
  }

  async deleteNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);

      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can delete');
      }

      await note.destroy();
      logger.info('Note deleted:', { noteId, userId });
      return true;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Delete note service error:', error);
      throw new ServerError('Failed to delete note');
    }
  }

  async deleteMultipleNotes(noteIds, userId) {
    try {
      const deletedCount = await Note.destroy({
        where: {
          id: { [Op.in]: noteIds },
          userId
        }
      });

      logger.info('Multiple notes deleted:', { count: deletedCount, userId });
      return { deletedCount };
    } catch (error) {
      logger.error('Delete multiple notes service error:', error);
      throw new ServerError('Failed to delete notes');
    }
  }

  // Note organization
  async pinNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      note.isPinned = true;
      await note.save();
      return note;
    } catch (error) {
      logger.error('Pin note service error:', error);
      throw new ServerError('Failed to pin note');
    }
  }

  async unpinNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      note.isPinned = false;
      await note.save();
      return note;
    } catch (error) {
      logger.error('Unpin note service error:', error);
      throw new ServerError('Failed to unpin note');
    }
  }

  async getPinnedNotes(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          isPinned: true,
          isArchived: false
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get pinned notes service error:', error);
      throw new ServerError('Failed to get pinned notes');
    }
  }

  async archiveNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      note.isArchived = true;
      note.isPinned = false; // Unpin when archiving
      await note.save();
      return note;
    } catch (error) {
      logger.error('Archive note service error:', error);
      throw new ServerError('Failed to archive note');
    }
  }

  async unarchiveNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      note.isArchived = false;
      await note.save();
      return note;
    } catch (error) {
      logger.error('Unarchive note service error:', error);
      throw new ServerError('Failed to unarchive note');
    }
  }

  async getArchivedNotes(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          isArchived: true
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get archived notes service error:', error);
      throw new ServerError('Failed to get archived notes');
    }
  }

  async favoriteNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      note.isFavorite = true;
      await note.save();
      return note;
    } catch (error) {
      logger.error('Favorite note service error:', error);
      throw new ServerError('Failed to favorite note');
    }
  }

  async unfavoriteNote(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      note.isFavorite = false;
      await note.save();
      return note;
    } catch (error) {
      logger.error('Unfavorite note service error:', error);
      throw new ServerError('Failed to unfavorite note');
    }
  }

  async getFavoriteNotes(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          isFavorite: true,
          isArchived: false
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get favorite notes service error:', error);
      throw new ServerError('Failed to get favorite notes');
    }
  }

  async lockNote(noteId, userId, password) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can lock');
      }

      note.isLocked = true;
      note.lockPassword = this.hashPassword(password);
      await note.save();
      return note;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Lock note service error:', error);
      throw new ServerError('Failed to lock note');
    }
  }

  async unlockNote(noteId, userId, password) {
    try {
      const note = await this.getNote(noteId, userId);
      
      if (!note.isLocked) {
        return note;
      }

      // Check password
      if (note.userId !== userId || !this.verifyPassword(password, note.lockPassword)) {
        throw new ValidationError('Invalid password');
      }

      note.isLocked = false;
      note.lockPassword = null;
      await note.save();
      return note;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Unlock note service error:', error);
      throw new ServerError('Failed to unlock note');
    }
  }

  async getLockedNotes(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          isLocked: true
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get locked notes service error:', error);
      throw new ServerError('Failed to get locked notes');
    }
  }

  // Note sharing
  async shareNote(noteId, userId, recipients, permission, expiresAt, message) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can share');
      }

      // Add sharing info
      const shareInfo = {
        shareId: `share_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        recipients,
        permission: permission || 'view',
        sharedBy: userId,
        sharedAt: new Date(),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        message
      };

      note.sharedWith = recipients;
      note.shareInfo = shareInfo;
      await note.save();

      return shareInfo;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Share note service error:', error);
      throw new ServerError('Failed to share note');
    }
  }

  async revokeShare(noteId, userId, shareId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can revoke share');
      }

      note.sharedWith = [];
      note.shareInfo = null;
      await note.save();

      return true;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Revoke share service error:', error);
      throw new ServerError('Failed to revoke share');
    }
  }

  async getSharedUsers(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return {
        sharedWith: note.sharedWith || [],
        shareInfo: note.shareInfo
      };
    } catch (error) {
      logger.error('Get shared users service error:', error);
      throw new ServerError('Failed to get shared users');
    }
  }

  async getNotesSharedWithMe(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          sharedWith: { [Op.contains]: [userId] }
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get notes shared with me service error:', error);
      throw new ServerError('Failed to get shared notes');
    }
  }

  async getNotesSharedByMe(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          sharedWith: { [Op.ne]: [] }
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get notes shared by me service error:', error);
      throw new ServerError('Failed to get shared notes');
    }
  }

  // Note collaboration
  async addCollaborator(noteId, userId, collaboratorId, permission) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can add collaborators');
      }

      // Add collaborator
      const collaborators = note.collaborators || [];
      const existingIndex = collaborators.findIndex(c => c.userId === collaboratorId);
      
      if (existingIndex >= 0) {
        collaborators[existingIndex].permission = permission;
      } else {
        collaborators.push({
          userId: collaboratorId,
          permission: permission || 'edit',
          addedAt: new Date(),
          addedBy: userId
        });
      }

      note.collaborators = collaborators;
      await note.save();

      return { userId: collaboratorId, permission };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Add collaborator service error:', error);
      throw new ServerError('Failed to add collaborator');
    }
  }

  async removeCollaborator(noteId, userId, collaboratorId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can remove collaborators');
      }

      const collaborators = note.collaborators || [];
      const updatedCollaborators = collaborators.filter(c => c.userId !== collaboratorId);
      
      note.collaborators = updatedCollaborators;
      await note.save();

      return true;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Remove collaborator service error:', error);
      throw new ServerError('Failed to remove collaborator');
    }
  }

  async getCollaborators(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return {
        collaborators: note.collaborators || [],
        ownerId: note.userId
      };
    } catch (error) {
      logger.error('Get collaborators service error:', error);
      throw new ServerError('Failed to get collaborators');
    }
  }

  async updateCollaboratorPermission(noteId, userId, collaboratorId, permission) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can update permissions');
      }

      const collaborators = note.collaborators || [];
      const collaboratorIndex = collaborators.findIndex(c => c.userId === collaboratorId);
      
      if (collaboratorIndex >= 0) {
        collaborators[collaboratorIndex].permission = permission;
        collaborators[collaboratorIndex].updatedAt = new Date();
        
        note.collaborators = collaborators;
        await note.save();
        
        return { userId: collaboratorId, permission };
      } else {
        throw new ValidationError('Collaborator not found');
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Update collaborator permission service error:', error);
      throw new ServerError('Failed to update collaborator permission');
    }
  }

  // Note content operations
  async duplicateNote(noteId, userId) {
    try {
      const originalNote = await this.getNote(noteId, userId);
      
      const duplicateNote = await Note.create({
        userId,
        title: `Copy of ${originalNote.title}`,
        content: originalNote.content,
        category: originalNote.category,
        tags: originalNote.tags,
        isPinned: false,
        isArchived: false,
        metadata: {
          ...originalNote.metadata,
          duplicatedFrom: noteId,
          duplicatedAt: new Date()
        },
        version: 1
      });

      logger.info('Note duplicated:', { originalNoteId: noteId, duplicateNoteId: duplicateNote.id, userId });
      return duplicateNote;
    } catch (error) {
      logger.error('Duplicate note service error:', error);
      throw new ServerError('Failed to duplicate note');
    }
  }

  async moveNote(noteId, userId, newCategory) {
    try {
      const note = await this.getNote(noteId, userId);
      note.category = newCategory || 'Uncategorized';
      await note.save();
      return note;
    } catch (error) {
      logger.error('Move note service error:', error);
      throw new ServerError('Failed to move note');
    }
  }

  async copyNote(noteId, userId, targetUserId, permission) {
    try {
      const originalNote = await this.getNote(noteId, userId);
      
      // Create copy for target user
      const copiedNote = await Note.create({
        userId: targetUserId,
        title: originalNote.title,
        content: originalNote.content,
        category: originalNote.category,
        tags: originalNote.tags,
        isPinned: false,
        isArchived: false,
        metadata: {
          ...originalNote.metadata,
          copiedFrom: noteId,
          copiedBy: userId,
          copiedAt: new Date(),
          permission: permission || 'view'
        },
        version: 1
      });

      return {
        noteId: copiedNote.id,
        originalNoteId: noteId,
        targetUserId,
        permission
      };
    } catch (error) {
      logger.error('Copy note service error:', error);
      throw new ServerError('Failed to copy note');
    }
  }

  async mergeNotes(noteIds, userId, title) {
    try {
      const notes = await Note.findAll({
        where: {
          id: { [Op.in]: noteIds },
          userId
        },
        order: [['createdAt', 'ASC']]
      });

      if (notes.length < 2) {
        throw new ValidationError('At least 2 notes are required for merging');
      }

      // Combine content
      let mergedContent = '';
      const mergedTags = new Set();
      const mergedMetadata = {
        mergedFrom: noteIds,
        mergedAt: new Date()
      };

      notes.forEach((note, index) => {
        mergedContent += `--- Note ${index + 1}: ${note.title} ---\n\n`;
        mergedContent += note.content + '\n\n';
        
        if (note.tags && Array.isArray(note.tags)) {
          note.tags.forEach(tag => mergedTags.add(tag));
        }
      });

      // Create merged note
      const mergedNote = await Note.create({
        userId,
        title: title || `Merged: ${notes[0].title}`,
        content: mergedContent,
        category: notes[0].category,
        tags: Array.from(mergedTags),
        metadata: mergedMetadata,
        version: 1
      });

      // Archive original notes
      await Note.update(
        { isArchived: true },
        { where: { id: { [Op.in]: noteIds } } }
      );

      return mergedNote;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Merge notes service error:', error);
      throw new ServerError('Failed to merge notes');
    }
  }

  // Note attachments
  async addAttachment(noteId, userId, file) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Create file record
      const attachment = await File.create({
        userId,
        noteId,
        filename: file.filename,
        originalName: file.originalname,
        filepath: file.path,
        mimetype: file.mimetype,
        size: file.size,
        metadata: {
          uploadedAt: new Date(),
          noteId
        }
      });

      // Add attachment reference to note
      const attachments = note.attachments || [];
      attachments.push({
        fileId: attachment.id,
        filename: file.filename,
        originalName: file.originalname,
        uploadedAt: new Date()
      });

      note.attachments = attachments;
      await note.save();

      return attachment;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Add attachment service error:', error);
      throw new ServerError('Failed to add attachment');
    }
  }

  async removeAttachment(noteId, userId, attachmentId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Remove attachment from note
      const attachments = note.attachments || [];
      const updatedAttachments = attachments.filter(att => att.fileId !== attachmentId);
      
      note.attachments = updatedAttachments;
      await note.save();

      // Delete file record
      await File.destroy({
        where: {
          id: attachmentId,
          noteId
        }
      });

      return true;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Remove attachment service error:', error);
      throw new ServerError('Failed to remove attachment');
    }
  }

  async getAttachments(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Get attachment files
      const fileIds = note.attachments ? note.attachments.map(att => att.fileId) : [];
      const files = await File.findAll({
        where: {
          id: { [Op.in]: fileIds }
        }
      });

      return {
        attachments: note.attachments || [],
        files
      };
    } catch (error) {
      logger.error('Get attachments service error:', error);
      throw new ServerError('Failed to get attachments');
    }
  }

  // Note tags
  async addTag(noteId, userId, tag) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      const tags = note.tags || [];
      if (!tags.includes(tag)) {
        tags.push(tag);
        note.tags = tags;
        await note.save();
      }

      return { tags: note.tags };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Add tag service error:', error);
      throw new ServerError('Failed to add tag');
    }
  }

  async removeTag(noteId, userId, tagId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      const tags = note.tags || [];
      const updatedTags = tags.filter(tag => tag !== tagId);
      
      note.tags = updatedTags;
      await note.save();

      return { tags: note.tags };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Remove tag service error:', error);
      throw new ServerError('Failed to remove tag');
    }
  }

  async getNoteTags(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return note.tags || [];
    } catch (error) {
      logger.error('Get note tags service error:', error);
      throw new ServerError('Failed to get note tags');
    }
  }

  async updateTags(noteId, userId, tags) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      note.tags = tags || [];
      await note.save();

      return { tags: note.tags };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Update tags service error:', error);
      throw new ServerError('Failed to update tags');
    }
  }

  // Note categories/notebooks
  async createCategory(userId, name, description, color, parentId) {
    try {
      const category = await Category.create({
        userId,
        name,
        description,
        color: color || '#4A90E2',
        parentId: parentId || null,
        noteCount: 0
      });

      return category;
    } catch (error) {
      logger.error('Create category service error:', error);
      throw new ServerError('Failed to create category');
    }
  }

  async getAllCategories(userId, includeNotes) {
    try {
      const categories = await Category.findAll({
        where: { userId },
        order: [['name', 'ASC']]
      });

      if (includeNotes) {
        // Get note counts for each category
        const noteCounts = await Note.findAll({
          where: { userId },
          attributes: ['category', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
          group: ['category']
        });

        const countMap = {};
        noteCounts.forEach(item => {
          countMap[item.category] = parseInt(item.dataValues.count);
        });

        categories.forEach(category => {
          category.dataValues.noteCount = countMap[category.name] || 0;
        });
      }

      return categories;
    } catch (error) {
      logger.error('Get all categories service error:', error);
      throw new ServerError('Failed to get categories');
    }
  }

  async getCategory(categoryId, userId, includeNotes) {
    try {
      const category = await Category.findOne({
        where: {
          id: categoryId,
          userId
        }
      });

      if (!category) {
        throw new NotFoundError('Category not found');
      }

      if (includeNotes) {
        const notes = await Note.findAll({
          where: {
            userId,
            category: category.name
          },
          order: [['updatedAt', 'DESC']]
        });
        category.dataValues.notes = notes;
        category.dataValues.noteCount = notes.length;
      }

      return category;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Get category service error:', error);
      throw new ServerError('Failed to get category');
    }
  }

  async updateCategory(categoryId, userId, updateData) {
    try {
      const category = await this.getCategory(categoryId, userId, false);
      
      await category.update(updateData);
      return category;
    } catch (error) {
      logger.error('Update category service error:', error);
      throw new ServerError('Failed to update category');
    }
  }

  async deleteCategory(categoryId, userId, moveNotesTo) {
    try {
      const category = await this.getCategory(categoryId, userId, false);
      
      // Move notes to another category if specified
      if (moveNotesTo) {
        await Note.update(
          { category: moveNotesTo },
          { where: { userId, category: category.name } }
        );
      }
      
      await category.destroy();
      return true;
    } catch (error) {
      logger.error('Delete category service error:', error);
      throw new ServerError('Failed to delete category');
    }
  }

  async getNotesByCategory(categoryId, userId, page, limit) {
    try {
      const category = await this.getCategory(categoryId, userId, false);
      const offset = (page - 1) * limit;
      
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          category: category.name
        },
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        category: category.name
      };
    } catch (error) {
      logger.error('Get notes by category service error:', error);
      throw new ServerError('Failed to get notes by category');
    }
  }

  // Note templates
  async createTemplate(userId, name, content, category, tags, isPublic) {
    try {
      const template = await Template.create({
        userId,
        name,
        content,
        category: category || 'General',
        tags: tags || [],
        isPublic: isPublic || false,
        usageCount: 0
      });

      return template;
    } catch (error) {
      logger.error('Create template service error:', error);
      throw new ServerError('Failed to create template');
    }
  }

  async getAllTemplates(userId, includePublic) {
    try {
      const whereCondition = includePublic 
        ? {
            [Op.or]: [
              { userId },
              { isPublic: true }
            ]
          }
        : { userId };

      const templates = await Template.findAll({
        where: whereCondition,
        order: [['name', 'ASC']]
      });

      return templates;
    } catch (error) {
      logger.error('Get all templates service error:', error);
      throw new ServerError('Failed to get templates');
    }
  }

  async getTemplate(templateId, userId) {
    try {
      const template = await Template.findOne({
        where: {
          id: templateId,
          [Op.or]: [
            { userId },
            { isPublic: true }
          ]
        }
      });

      if (!template) {
        throw new NotFoundError('Template not found or access denied');
      }

      // Increment usage count
      template.usageCount += 1;
      await template.save();

      return template;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Get template service error:', error);
      throw new ServerError('Failed to get template');
    }
  }

  async updateTemplate(templateId, userId, updateData) {
    try {
      const template = await Template.findOne({
        where: {
          id: templateId,
          userId // Only owner can update
        }
      });

      if (!template) {
        throw new NotFoundError('Template not found or access denied');
      }

      await template.update(updateData);
      return template;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Update template service error:', error);
      throw new ServerError('Failed to update template');
    }
  }

  async deleteTemplate(templateId, userId) {
    try {
      const template = await Template.findOne({
        where: {
          id: templateId,
          userId // Only owner can delete
        }
      });

      if (!template) {
        throw new NotFoundError('Template not found or access denied');
      }

      await template.destroy();
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Delete template service error:', error);
      throw new ServerError('Failed to delete template');
    }
  }

  async applyTemplate(noteId, templateId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const template = await this.getTemplate(templateId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Apply template content
      note.content = template.content;
      note.category = template.category || note.category;
      
      // Merge tags
      const noteTags = note.tags || [];
      const templateTags = template.tags || [];
      const mergedTags = [...new Set([...noteTags, ...templateTags])];
      note.tags = mergedTags;
      
      // Update metadata
      note.metadata = {
        ...note.metadata,
        templateApplied: templateId,
        appliedAt: new Date()
      };
      
      note.version += 1;
      await note.save();

      // Update template usage count
      template.usageCount += 1;
      await template.save();

      return note;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Apply template service error:', error);
      throw new ServerError('Failed to apply template');
    }
  }

  // Note versions/history
  async saveVersion(noteId, userId, name, description) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Create version record
      const version = {
        versionId: `ver_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        name: name || `Version ${note.version}`,
        description,
        content: note.content,
        savedBy: userId,
        savedAt: new Date(),
        noteVersion: note.version
      };

      // Add to versions array
      const versions = note.versions || [];
      versions.push(version);
      note.versions = versions;
      
      // Limit versions to last 50
      if (versions.length > 50) {
        note.versions = versions.slice(-50);
      }
      
      await note.save();

      return version;
    } catch (error) {
      logger.error('Save version service error:', error);
      throw new ServerError('Failed to save version');
    }
  }

  async getVersions(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return note.versions || [];
    } catch (error) {
      logger.error('Get versions service error:', error);
      throw new ServerError('Failed to get versions');
    }
  }

  async getVersion(noteId, versionId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const versions = note.versions || [];
      const version = versions.find(v => v.versionId === versionId);
      
      if (!version) {
        throw new NotFoundError('Version not found');
      }

      return version;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Get version service error:', error);
      throw new ServerError('Failed to get version');
    }
  }

  async restoreVersion(noteId, versionId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const version = await this.getVersion(noteId, versionId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Restore content
      note.content = version.content;
      note.version += 1;
      
      // Add restoration record
      const restorations = note.metadata.restorations || [];
      restorations.push({
        versionId,
        restoredBy: userId,
        restoredAt: new Date()
      });
      
      note.metadata = {
        ...note.metadata,
        restorations
      };
      
      await note.save();

      return note;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Restore version service error:', error);
      throw new ServerError('Failed to restore version');
    }
  }

  async deleteVersion(noteId, versionId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can delete versions');
      }

      const versions = note.versions || [];
      const updatedVersions = versions.filter(v => v.versionId !== versionId);
      
      note.versions = updatedVersions;
      await note.save();

      return true;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Delete version service error:', error);
      throw new ServerError('Failed to delete version');
    }
  }

  // Note reminders
  async addReminder(noteId, userId, date, time, repeat, message) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Create reminder
      const reminder = {
        reminderId: `rem_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        date: new Date(date),
        time,
        repeat: repeat || 'none',
        message: message || `Reminder for: ${note.title}`,
        createdBy: userId,
        createdAt: new Date(),
        isActive: true
      };

      // Add to reminders array
      const reminders = note.reminders || [];
      reminders.push(reminder);
      note.reminders = reminders;
      
      await note.save();

      return reminder;
    } catch (error) {
      logger.error('Add reminder service error:', error);
      throw new ServerError('Failed to add reminder');
    }
  }

  async updateReminder(noteId, reminderId, userId, updateData) {
    try {
      const note = await this.getNote(noteId, userId);
      const reminders = note.reminders || [];
      const reminderIndex = reminders.findIndex(r => r.reminderId === reminderId);
      
      if (reminderIndex < 0) {
        throw new NotFoundError('Reminder not found');
      }

      // Update reminder
      reminders[reminderIndex] = {
        ...reminders[reminderIndex],
        ...updateData,
        updatedAt: new Date()
      };
      
      note.reminders = reminders;
      await note.save();

      return reminders[reminderIndex];
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Update reminder service error:', error);
      throw new ServerError('Failed to update reminder');
    }
  }

  async removeReminder(noteId, reminderId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const reminders = note.reminders || [];
      const updatedReminders = reminders.filter(r => r.reminderId !== reminderId);
      
      note.reminders = updatedReminders;
      await note.save();

      return true;
    } catch (error) {
      logger.error('Remove reminder service error:', error);
      throw new ServerError('Failed to remove reminder');
    }
  }

  async getReminders(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return note.reminders || [];
    } catch (error) {
      logger.error('Get reminders service error:', error);
      throw new ServerError('Failed to get reminders');
    }
  }

  async getUpcomingReminders(userId, days) {
    try {
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + days);
      
      // Get all user's notes with reminders
      const notes = await Note.findAll({
        where: {
          userId,
          reminders: { [Op.ne]: [] }
        }
      });

      // Filter upcoming reminders
      const upcomingReminders = [];
      notes.forEach(note => {
        const reminders = note.reminders || [];
        reminders.forEach(reminder => {
          if (reminder.isActive && new Date(reminder.date) <= endDate) {
            upcomingReminders.push({
              noteId: note.id,
              noteTitle: note.title,
              ...reminder
            });
          }
        });
      });

      // Sort by date
      upcomingReminders.sort((a, b) => new Date(a.date) - new Date(b.date));

      return upcomingReminders;
    } catch (error) {
      logger.error('Get upcoming reminders service error:', error);
      throw new ServerError('Failed to get upcoming reminders');
    }
  }

  // Note comments
  async addComment(noteId, userId, content, parentId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Create comment
      const comment = {
        commentId: `com_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        userId,
        content,
        parentId: parentId || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        likes: [],
        replies: []
      };

      // Add to comments array
      const comments = note.comments || [];
      
      if (parentId) {
        // Find parent comment and add reply
        const parentComment = this.findComment(comments, parentId);
        if (parentComment) {
          parentComment.replies.push(comment);
        } else {
          comments.push(comment);
        }
      } else {
        comments.push(comment);
      }
      
      note.comments = comments;
      await note.save();

      return comment;
    } catch (error) {
      logger.error('Add comment service error:', error);
      throw new ServerError('Failed to add comment');
    }
  }

  async updateComment(noteId, commentId, userId, content) {
    try {
      const note = await this.getNote(noteId, userId);
      const comments = note.comments || [];
      const comment = this.findComment(comments, commentId);
      
      if (!comment) {
        throw new NotFoundError('Comment not found');
      }

      // Check if user is comment author
      if (comment.userId !== userId) {
        throw new ValidationError('Only comment author can update');
      }

      comment.content = content;
      comment.updatedAt = new Date();
      
      note.comments = comments;
      await note.save();

      return comment;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Update comment service error:', error);
      throw new ServerError('Failed to update comment');
    }
  }

  async deleteComment(noteId, commentId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const comments = note.comments || [];
      
      // Check if user is note owner or comment author
      const isNoteOwner = note.userId === userId;
      
      const removeComment = (commentList, targetId) => {
        for (let i = 0; i < commentList.length; i++) {
          if (commentList[i].commentId === targetId) {
            // Check permissions
            if (commentList[i].userId !== userId && !isNoteOwner) {
              throw new ValidationError('No permission to delete comment');
            }
            commentList.splice(i, 1);
            return true;
          }
          if (commentList[i].replies && commentList[i].replies.length > 0) {
            if (removeComment(commentList[i].replies, targetId)) {
              return true;
            }
          }
        }
        return false;
      };

      const removed = removeComment(comments, commentId);
      if (!removed) {
        throw new NotFoundError('Comment not found');
      }

      note.comments = comments;
      await note.save();

      return true;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Delete comment service error:', error);
      throw new ServerError('Failed to delete comment');
    }
  }

  async getComments(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return note.comments || [];
    } catch (error) {
      logger.error('Get comments service error:', error);
      throw new ServerError('Failed to get comments');
    }
  }

  // Note tasks/checklists
  async addChecklist(noteId, userId, title, items) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Create checklist
      const checklist = {
        checklistId: `chk_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        title,
        items: items || [],
        createdAt: new Date(),
        updatedAt: new Date(),
        completed: 0,
        total: items ? items.length : 0
      };

      // Add to checklists array
      const checklists = note.checklists || [];
      checklists.push(checklist);
      note.checklists = checklists;
      
      await note.save();

      return checklist;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Add checklist service error:', error);
      throw new ServerError('Failed to add checklist');
    }
  }

  async updateChecklist(noteId, checklistId, userId, updateData) {
    try {
      const note = await this.getNote(noteId, userId);
      const checklists = note.checklists || [];
      const checklistIndex = checklists.findIndex(c => c.checklistId === checklistId);
      
      if (checklistIndex < 0) {
        throw new NotFoundError('Checklist not found');
      }

      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Update checklist
      checklists[checklistIndex] = {
        ...checklists[checklistIndex],
        ...updateData,
        updatedAt: new Date()
      };
      
      // Recalculate completion stats
      if (updateData.items) {
        const completedItems = updateData.items.filter(item => item.completed).length;
        checklists[checklistIndex].completed = completedItems;
        checklists[checklistIndex].total = updateData.items.length;
      }
      
      note.checklists = checklists;
      await note.save();

      return checklists[checklistIndex];
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Update checklist service error:', error);
      throw new ServerError('Failed to update checklist');
    }
  }

  async deleteChecklist(noteId, checklistId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const checklists = note.checklists || [];
      const updatedChecklists = checklists.filter(c => c.checklistId !== checklistId);
      
      note.checklists = updatedChecklists;
      await note.save();

      return true;
    } catch (error) {
      logger.error('Delete checklist service error:', error);
      throw new ServerError('Failed to delete checklist');
    }
  }

  async getChecklists(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return note.checklists || [];
    } catch (error) {
      logger.error('Get checklists service error:', error);
      throw new ServerError('Failed to get checklists');
    }
  }

  async addChecklistItem(noteId, checklistId, userId, text) {
    try {
      const note = await this.getNote(noteId, userId);
      const checklists = note.checklists || [];
      const checklistIndex = checklists.findIndex(c => c.checklistId === checklistId);
      
      if (checklistIndex < 0) {
        throw new NotFoundError('Checklist not found');
      }

      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Create item
      const item = {
        itemId: `item_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        text,
        completed: false,
        createdAt: new Date()
      };

      // Add item
      checklists[checklistIndex].items.push(item);
      checklists[checklistIndex].total += 1;
      checklists[checklistIndex].updatedAt = new Date();
      
      note.checklists = checklists;
      await note.save();

      return item;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Add checklist item service error:', error);
      throw new ServerError('Failed to add checklist item');
    }
  }

  async updateChecklistItem(noteId, checklistId, itemId, userId, updateData) {
    try {
      const note = await this.getNote(noteId, userId);
      const checklists = note.checklists || [];
      const checklistIndex = checklists.findIndex(c => c.checklistId === checklistId);
      
      if (checklistIndex < 0) {
        throw new NotFoundError('Checklist not found');
      }

      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      const checklist = checklists[checklistIndex];
      const itemIndex = checklist.items.findIndex(i => i.itemId === itemId);
      
      if (itemIndex < 0) {
        throw new NotFoundError('Item not found');
      }

      // Update item
      const oldCompleted = checklist.items[itemIndex].completed;
      checklist.items[itemIndex] = {
        ...checklist.items[itemIndex],
        ...updateData,
        updatedAt: new Date()
      };
      
      // Update completion stats
      const newCompleted = checklist.items[itemIndex].completed;
      if (oldCompleted !== newCompleted) {
        checklist.completed += newCompleted ? 1 : -1;
      }
      
      checklist.updatedAt = new Date();
      checklists[checklistIndex] = checklist;
      note.checklists = checklists;
      await note.save();

      return checklist.items[itemIndex];
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Update checklist item service error:', error);
      throw new ServerError('Failed to update checklist item');
    }
  }

  async deleteChecklistItem(noteId, checklistId, itemId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const checklists = note.checklists || [];
      const checklistIndex = checklists.findIndex(c => c.checklistId === checklistId);
      
      if (checklistIndex < 0) {
        throw new NotFoundError('Checklist not found');
      }

      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      const checklist = checklists[checklistIndex];
      const itemIndex = checklist.items.findIndex(i => i.itemId === itemId);
      
      if (itemIndex < 0) {
        throw new NotFoundError('Item not found');
      }

      // Update stats
      if (checklist.items[itemIndex].completed) {
        checklist.completed -= 1;
      }
      checklist.total -= 1;
      
      // Remove item
      checklist.items.splice(itemIndex, 1);
      checklist.updatedAt = new Date();
      
      checklists[checklistIndex] = checklist;
      note.checklists = checklists;
      await note.save();

      return true;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Delete checklist item service error:', error);
      throw new ServerError('Failed to delete checklist item');
    }
  }

  async toggleChecklistItem(noteId, checklistId, itemId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const checklists = note.checklists || [];
      const checklistIndex = checklists.findIndex(c => c.checklistId === checklistId);
      
      if (checklistIndex < 0) {
        throw new NotFoundError('Checklist not found');
      }

      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      const checklist = checklists[checklistIndex];
      const itemIndex = checklist.items.findIndex(i => i.itemId === itemId);
      
      if (itemIndex < 0) {
        throw new NotFoundError('Item not found');
      }

      // Toggle completion
      const item = checklist.items[itemIndex];
      item.completed = !item.completed;
      item.updatedAt = new Date();
      
      // Update completion stats
      checklist.completed += item.completed ? 1 : -1;
      checklist.updatedAt = new Date();
      
      checklists[checklistIndex] = checklist;
      note.checklists = checklists;
      await note.save();

      return item;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      logger.error('Toggle checklist item service error:', error);
      throw new ServerError('Failed to toggle checklist item');
    }
  }

  // Note links
  async addLink(noteId, userId, url, title, description) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check edit permission
      if (note.userId !== userId && !this.hasEditPermission(note, userId)) {
        throw new ValidationError('No edit permission for this note');
      }

      // Create link
      const link = {
        linkId: `lnk_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        url,
        title: title || url,
        description,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Add to links array
      const links = note.links || [];
      links.push(link);
      note.links = links;
      
      await note.save();

      return link;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Add link service error:', error);
      throw new ServerError('Failed to add link');
    }
  }

  async removeLink(noteId, linkId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      const links = note.links || [];
      const updatedLinks = links.filter(l => l.linkId !== linkId);
      
      note.links = updatedLinks;
      await note.save();

      return true;
    } catch (error) {
      logger.error('Remove link service error:', error);
      throw new ServerError('Failed to remove link');
    }
  }

  async getLinks(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      return note.links || [];
    } catch (error) {
      logger.error('Get links service error:', error);
      throw new ServerError('Failed to get links');
    }
  }

  // Note statistics
  async getOverviewStats(userId) {
    try {
      const totalNotes = await Note.count({ where: { userId } });
      const pinnedNotes = await Note.count({ where: { userId, isPinned: true } });
      const archivedNotes = await Note.count({ where: { userId, isArchived: true } });
      const favoriteNotes = await Note.count({ where: { userId, isFavorite: true } });
      
      // Get recent activity
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentNotes = await Note.count({
        where: {
          userId,
          updatedAt: { [Op.gte]: thirtyDaysAgo }
        }
      });

      // Get category distribution
      const categories = await Note.findAll({
        where: { userId },
        attributes: ['category', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        group: ['category']
      });

      const categoryStats = categories.map(cat => ({
        category: cat.category,
        count: parseInt(cat.dataValues.count)
      }));

      return {
        totalNotes,
        pinnedNotes,
        archivedNotes,
        favoriteNotes,
        recentNotes,
        categoryStats,
        updatedAt: new Date()
      };
    } catch (error) {
      logger.error('Get overview stats service error:', error);
      throw new ServerError('Failed to get overview stats');
    }
  }

  async getCategoryStats(userId) {
    try {
      const categories = await Category.findAll({
        where: { userId }
      });

      const stats = await Promise.all(categories.map(async (category) => {
        const noteCount = await Note.count({
          where: {
            userId,
            category: category.name
          }
        });

        const recentCount = await Note.count({
          where: {
            userId,
            category: category.name,
            updatedAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
          }
        });

        return {
          categoryId: category.id,
          name: category.name,
          color: category.color,
          totalNotes: noteCount,
          recentNotes: recentCount,
          lastUpdated: category.updatedAt
        };
      }));

      return stats;
    } catch (error) {
      logger.error('Get category stats service error:', error);
      throw new ServerError('Failed to get category stats');
    }
  }

  async getTagStats(userId) {
    try {
      const notes = await Note.findAll({
        where: { userId },
        attributes: ['tags']
      });

      const tagCounts = {};
      notes.forEach(note => {
        if (note.tags && Array.isArray(note.tags)) {
          note.tags.forEach(tag => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        }
      });

      const tagStats = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);

      return {
        totalTags: Object.keys(tagCounts).length,
        tagStats,
        updatedAt: new Date()
      };
    } catch (error) {
      logger.error('Get tag stats service error:', error);
      throw new ServerError('Failed to get tag stats');
    }
  }

  async getActivityStats(userId, days) {
    try {
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const endDate = new Date();
      
      // Generate date range
      const dateRange = [];
      for (let i = 0; i < days; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        dateRange.push(date.toISOString().split('T')[0]);
      }

      // Get activity data
      const activities = await Note.findAll({
        where: {
          userId,
          updatedAt: { [Op.between]: [startDate, endDate] }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('updatedAt')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: [sequelize.fn('DATE', sequelize.col('updatedAt'))],
        order: [[sequelize.fn('DATE', sequelize.col('updatedAt')), 'ASC']]
      });

      // Map activity data
      const activityMap = {};
      activities.forEach(activity => {
        const date = activity.dataValues.date.toISOString().split('T')[0];
        activityMap[date] = parseInt(activity.dataValues.count);
      });

      // Fill in missing dates
      const activityStats = dateRange.map(date => ({
        date,
        count: activityMap[date] || 0
      }));

      // Calculate totals
      const totalActivity = activities.reduce((sum, activity) => sum + parseInt(activity.dataValues.count), 0);
      const averagePerDay = totalActivity / days;

      return {
        period: days,
        totalActivity,
        averagePerDay: Math.round(averagePerDay * 100) / 100,
        activityStats,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      };
    } catch (error) {
      logger.error('Get activity stats service error:', error);
      throw new ServerError('Failed to get activity stats');
    }
  }

  // Note search - FIXED VERSION
  async searchNotes(query, userId, page, limit, includeContent) {
    try {
      const offset = (page - 1) * limit;
      
      // Build OR conditions properly
      const orConditions = [
        { title: { [Op.iLike]: `%${query}%` } }
      ];
      
      if (includeContent) {
        orConditions.push({ content: { [Op.iLike]: `%${query}%` } });
      }

      const whereCondition = {
        userId,
        [Op.or]: orConditions
      };

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        query
      };
    } catch (error) {
      logger.error('Search notes service error:', error);
      throw new ServerError('Failed to search notes');
    }
  }

  async searchByTags(tags, operator, userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const tagConditions = tags.map(tag => ({
        tags: { [Op.contains]: [tag] }
      }));

      const whereCondition = {
        userId,
        [operator === 'AND' ? Op.and : Op.or]: tagConditions
      };

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        tags,
        operator
      };
    } catch (error) {
      logger.error('Search by tags service error:', error);
      throw new ServerError('Failed to search by tags');
    }
  }

  async searchByCategory(category, subcategory, userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const whereCondition = {
        userId,
        category: { [Op.iLike]: `%${category}%` }
      };

      if (subcategory) {
        whereCondition.subcategory = subcategory;
      }

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        category,
        subcategory
      };
    } catch (error) {
      logger.error('Search by category service error:', error);
      throw new ServerError('Failed to search by category');
    }
  }

  async searchByDate(date, range, userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const targetDate = new Date(date);
      let startDate, endDate;
      
      switch (range) {
        case 'exact':
          startDate = new Date(targetDate.setHours(0, 0, 0, 0));
          endDate = new Date(targetDate.setHours(23, 59, 59, 999));
          break;
        case 'week':
          startDate = new Date(targetDate);
          startDate.setDate(startDate.getDate() - startDate.getDay());
          endDate = new Date(startDate);
          endDate.setDate(endDate.getDate() + 6);
          break;
        case 'month':
          startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
          endDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
          break;
        default:
          startDate = new Date(targetDate);
          endDate = new Date(targetDate);
      }

      const whereCondition = {
        userId,
        [Op.or]: [
          { createdAt: { [Op.between]: [startDate, endDate] } },
          { updatedAt: { [Op.between]: [startDate, endDate] } }
        ]
      };

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        date,
        range
      };
    } catch (error) {
      logger.error('Search by date service error:', error);
      throw new ServerError('Failed to search by date');
    }
  }

  // Note export/import
  async exportNote(noteId, userId, format) {
    try {
      const note = await this.getNote(noteId, userId);
      
      switch (format) {
        case 'json':
          return note.toJSON();
        case 'txt':
          return `Title: ${note.title}\n\n${note.content}`;
        case 'pdf':
          // In production, you would generate PDF
          return `PDF export for: ${note.title}`;
        default:
          throw new ValidationError('Unsupported export format');
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Export note service error:', error);
      throw new ServerError('Failed to export note');
    }
  }

  async exportNotes(noteIds, userId, format, includeAttachments) {
    try {
      const notes = await Note.findAll({
        where: {
          id: { [Op.in]: noteIds },
          userId
        }
      });

      const exportData = {
        exportedAt: new Date().toISOString(),
        exportedBy: userId,
        noteCount: notes.length,
        format,
        notes: notes.map(note => note.toJSON())
      };

      if (includeAttachments) {
        // Add attachment info
        exportData.attachments = [];
      }

      return exportData;
    } catch (error) {
      logger.error('Export notes service error:', error);
      throw new ServerError('Failed to export notes');
    }
  }

  async importNotes(file, userId, format, category, tags) {
    try {
      // This is a simplified implementation
      // In production, you would parse the file based on format
      const importedNotes = [];
      let importedCount = 0;
      
      // For now, return mock data
      const note = await this.createNote(
        userId,
        'Imported Note',
        'Content from imported file',
        category || 'Imported',
        tags || ['imported'],
        false,
        false,
        { importedFrom: file.originalname, importedAt: new Date() }
      );

      importedNotes.push(note);
      importedCount = 1;

      return {
        importedCount,
        notes: importedNotes,
        file: file.originalname,
        format
      };
    } catch (error) {
      logger.error('Import notes service error:', error);
      throw new ServerError('Failed to import notes');
    }
  }

  async importMultipleNotes(files, userId, category, tags) {
    try {
      const results = [];
      
      for (const file of files) {
        try {
          const result = await this.importNotes(file, userId, 'auto', category, tags);
          results.push({
            file: file.originalname,
            success: true,
            importedCount: result.importedCount
          });
        } catch (error) {
          results.push({
            file: file.originalname,
            success: false,
            error: error.message
          });
        }
      }

      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return {
        results,
        totalFiles: files.length,
        successful,
        failed
      };
    } catch (error) {
      logger.error('Import multiple notes service error:', error);
      throw new ServerError('Failed to import multiple notes');
    }
  }

  // Note backup
  async createBackup(userId, type, includeAttachments) {
    try {
      const backupId = `backup_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      // Get user's notes
      const notes = await Note.findAll({
        where: { userId }
      });

      // Create backup data
      const backupData = {
        backupId,
        userId,
        type,
        includeAttachments,
        noteCount: notes.length,
        createdAt: new Date(),
        data: notes.map(note => note.toJSON())
      };

      // In production, you would save this to a file or cloud storage
      return {
        backupId,
        downloadUrl: `/api/notes/backup/download/${backupId}`,
        size: '1.2MB', // Example
        noteCount: notes.length,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
      };
    } catch (error) {
      logger.error('Create backup service error:', error);
      throw new ServerError('Failed to create backup');
    }
  }

  async listBackups(userId) {
    try {
      // In production, you would query backup storage
      return [
        {
          backupId: 'backup_123',
          createdAt: new Date('2023-12-01'),
          noteCount: 45,
          size: '1.2MB',
          downloadUrl: '/api/notes/backup/download/backup_123'
        },
        {
          backupId: 'backup_456',
          createdAt: new Date('2023-11-15'),
          noteCount: 32,
          size: '0.8MB',
          downloadUrl: '/api/notes/backup/download/backup_456'
        }
      ];
    } catch (error) {
      logger.error('List backups service error:', error);
      throw new ServerError('Failed to list backups');
    }
  }

  async restoreBackup(backupId, userId) {
    try {
      // In production, you would restore from backup file
      // For now, return success
      return {
        backupId,
        restored: true,
        restoredAt: new Date(),
        noteCount: 45 // Example
      };
    } catch (error) {
      logger.error('Restore backup service error:', error);
      throw new ServerError('Failed to restore backup');
    }
  }

  // Note recycling bin
  async moveToTrash(noteId, userId) {
    try {
      const note = await this.getNote(noteId, userId);
      
      // Check if user is owner
      if (note.userId !== userId) {
        throw new ValidationError('Only note owner can move to trash');
      }

      note.isTrashed = true;
      note.trashedAt = new Date();
      await note.save();

      return note;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      logger.error('Move to trash service error:', error);
      throw new ServerError('Failed to move note to trash');
    }
  }

  async getTrashedNotes(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          isTrashed: true
        },
        order: [['trashedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get trashed notes service error:', error);
      throw new ServerError('Failed to get trashed notes');
    }
  }

  async emptyTrash(userId) {
    try {
      const deletedCount = await Note.destroy({
        where: {
          userId,
          isTrashed: true
        }
      });

      return {
        deletedCount,
        emptiedAt: new Date()
      };
    } catch (error) {
      logger.error('Empty trash service error:', error);
      throw new ServerError('Failed to empty trash');
    }
  }

  async restoreFromTrash(noteId, userId) {
    try {
      const note = await Note.findOne({
        where: {
          id: noteId,
          userId,
          isTrashed: true
        }
      });

      if (!note) {
        throw new NotFoundError('Trashed note not found');
      }

      note.isTrashed = false;
      note.trashedAt = null;
      await note.save();

      return note;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Restore from trash service error:', error);
      throw new ServerError('Failed to restore note from trash');
    }
  }

  async deletePermanently(noteId, userId) {
    try {
      const note = await Note.findOne({
        where: {
          id: noteId,
          userId,
          isTrashed: true
        }
      });

      if (!note) {
        throw new NotFoundError('Trashed note not found');
      }

      await note.destroy();
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Delete permanently service error:', error);
      throw new ServerError('Failed to delete note permanently');
    }
  }

  // Note settings
  async getNoteSettings(userId) {
    try {
      // In production, you would get from UserSettings model
      return {
        defaultCategory: 'General',
        autoSave: true,
        autoSaveInterval: 30, // seconds
        richTextEditor: true,
        spellCheck: true,
        fontSize: 14,
        fontFamily: 'Arial',
        theme: 'light',
        defaultTags: ['important', 'todo'],
        backupEnabled: true,
        backupFrequency: 'weekly'
      };
    } catch (error) {
      logger.error('Get note settings service error:', error);
      throw new ServerError('Failed to get note settings');
    }
  }

  async updateNoteSettings(userId, settings) {
    try {
      // In production, you would update UserSettings model
      return {
        ...settings,
        updatedAt: new Date()
      };
    } catch (error) {
      logger.error('Update note settings service error:', error);
      throw new ServerError('Failed to update note settings');
    }
  }

  // Note sorting/filtering
  async getSortedNotes(userId, sortBy, page, limit) {
    try {
      const offset = (page - 1) * limit;
      let order;
      
      switch (sortBy) {
        case 'title':
          order = [['title', 'ASC']];
          break;
        case 'created':
          order = [['createdAt', 'DESC']];
          break;
        case 'updated':
          order = [['updatedAt', 'DESC']];
          break;
        case 'category':
          order = [['category', 'ASC'], ['updatedAt', 'DESC']];
          break;
        default:
          order = [['updatedAt', 'DESC']];
      }

      const { count, rows } = await Note.findAndCountAll({
        where: { userId, isArchived: false },
        order,
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        sortBy
      };
    } catch (error) {
      logger.error('Get sorted notes service error:', error);
      throw new ServerError('Failed to get sorted notes');
    }
  }

  async filterNotes(userId, filters, page, limit) {
    try {
      const offset = (page - 1) * limit;
      const whereCondition = { userId };

      // Apply filters
      if (filters.category) {
        whereCondition.category = filters.category;
      }

      if (filters.tags && filters.tags.length > 0) {
        whereCondition.tags = { [Op.overlap]: filters.tags };
      }

      if (filters.pinned !== undefined) {
        whereCondition.isPinned = filters.pinned;
      }

      if (filters.archived !== undefined) {
        whereCondition.isArchived = filters.archived;
      }

      if (filters.favorite !== undefined) {
        whereCondition.isFavorite = filters.favorite;
      }

      if (filters.locked !== undefined) {
        whereCondition.isLocked = filters.locked;
      }

      if (filters.dateFrom && filters.dateTo) {
        whereCondition.updatedAt = {
          [Op.between]: [new Date(filters.dateFrom), new Date(filters.dateTo)]
        };
      }

      if (filters.search) {
        whereCondition[Op.or] = [
          { title: { [Op.iLike]: `%${filters.search}%` } },
          { content: { [Op.iLike]: `%${filters.search}%` } }
        ];
      }

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        filters
      };
    } catch (error) {
      logger.error('Filter notes service error:', error);
      throw new ServerError('Failed to filter notes');
    }
  }

  // Quick notes - FIXED JSON QUERY
  async createQuickNote(userId, content) {
    try {
      const note = await this.createNote(
        userId,
        'Quick Note',
        content,
        'Quick Notes',
        ['quick'],
        false,
        false,
        { isQuickNote: true, created: new Date() }
      );

      return note;
    } catch (error) {
      logger.error('Create quick note service error:', error);
      throw new ServerError('Failed to create quick note');
    }
  }

  async getRecentQuickNotes(userId, limit) {
    try {
      // FIXED: Proper JSON query syntax
      const notes = await Note.findAll({
        where: {
          userId,
          category: 'Quick Notes',
          metadata: {
            [Op.contains]: { isQuickNote: true }
          }
        },
        order: [['createdAt', 'DESC']],
        limit,
        distinct: true
      });

      return notes;
    } catch (error) {
      logger.error('Get recent quick notes service error:', error);
      throw new ServerError('Failed to get recent quick notes');
    }
  }

  // Note synchronization
  async getSyncStatus(userId) {
    try {
      // In production, you would check sync status with cloud
      return {
        synced: true,
        lastSynced: new Date(Date.now() - 300000), // 5 minutes ago
        pendingChanges: 0,
        cloudProvider: 'none', // or 'google', 'dropbox', etc.
        autoSync: false
      };
    } catch (error) {
      logger.error('Get sync status service error:', error);
      throw new ServerError('Failed to get sync status');
    }
  }

  async pullChanges(userId) {
    try {
      // In production, you would pull changes from cloud
      return {
        pulled: true,
        changes: [],
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Pull changes service error:', error);
      throw new ServerError('Failed to pull changes');
    }
  }

  async pushChanges(userId, changes) {
    try {
      // In production, you would push changes to cloud
      return {
        pushed: true,
        changesCount: changes ? changes.length : 0,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Push changes service error:', error);
      throw new ServerError('Failed to push changes');
    }
  }

  async resolveConflicts(userId, conflicts) {
    try {
      // In production, you would resolve sync conflicts
      return {
        resolved: true,
        conflictsResolved: conflicts ? conflicts.length : 0,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Resolve conflicts service error:', error);
      throw new ServerError('Failed to resolve conflicts');
    }
  }

  // Note web clipping - FIXED JSON QUERY
  async clipWebContent(userId, url, title, content, tags) {
    try {
      const note = await this.createNote(
        userId,
        title || 'Web Clip',
        content,
        'Web Clips',
        ['web-clip', ...(tags || [])],
        false,
        false,
        {
          sourceUrl: url,
          clippedAt: new Date(),
          isWebClip: true
        }
      );

      return note;
    } catch (error) {
      logger.error('Clip web content service error:', error);
      throw new ServerError('Failed to clip web content');
    }
  }

  async getClippedNotes(userId, page, limit) {
    try {
      const offset = (page - 1) * limit;
      
      // FIXED: Proper JSON query syntax
      const { count, rows } = await Note.findAndCountAll({
        where: {
          userId,
          category: 'Web Clips',
          metadata: {
            [Op.contains]: { isWebClip: true }
          }
        },
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        notes: rows,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (error) {
      logger.error('Get clipped notes service error:', error);
      throw new ServerError('Failed to get clipped notes');
    }
  }

  // Helper methods
  hasEditPermission(note, userId) {
    // Check if user is owner
    if (note.userId === userId) return true;
    
    // Check collaborators
    if (note.collaborators && Array.isArray(note.collaborators)) {
      const collaborator = note.collaborators.find(c => c.userId === userId);
      return collaborator && collaborator.permission === 'edit';
    }
    
    return false;
  }

  hashPassword(password) {
    // In production, use bcrypt or similar
    return Buffer.from(password).toString('base64');
  }

  verifyPassword(password, hashedPassword) {
    const inputHash = this.hashPassword(password);
    return inputHash === hashedPassword;
  }

  findComment(comments, commentId) {
    for (const comment of comments) {
      if (comment.commentId === commentId) {
        return comment;
      }
      if (comment.replies && comment.replies.length > 0) {
        const found = this.findComment(comment.replies, commentId);
        if (found) return found;
      }
    }
    return null;
  }
}

module.exports = new NotesService();