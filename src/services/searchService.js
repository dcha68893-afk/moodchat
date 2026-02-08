const { Op } = require('sequelize');
const User = require('../models/Users');
const Message = require('../models/Message');
const Chat = require('../models/Chats');
const Group = require('../models/Group');
const Note = require('../models/Notes');
const File = require('../models/File');
const logger = require('../utils/logger');
const { ServerError, ValidationError } = require('../utils/errors');

class SearchService {
  constructor() {
    this.searchIndex = {};
  }

  // Global search
  async globalSearch(query, limit, offset, userId) {
    try {
      const searchPromises = [
        this.searchUsers(query, userId, Math.ceil(limit / 4), 0, false),
        this.searchMessages(query, userId, Math.ceil(limit / 4), 0, 'date', 'desc'),
        this.searchNotes(query, userId, Math.ceil(limit / 4), 0, false),
        this.searchFiles(query, userId, Math.ceil(limit / 4), 0)
      ];

      const [users, messages, notes, files] = await Promise.all(searchPromises);

      const results = {
        users: users.results || [],
        messages: messages.results || [],
        notes: notes.results || [],
        files: files.results || [],
        query,
        total: (users.total || 0) + (messages.total || 0) + (notes.total || 0) + (files.total || 0)
      };

      return results;
    } catch (error) {
      logger.error('Global search service error:', error);
      throw new ServerError('Failed to perform global search');
    }
  }

  // Message search
  async searchMessages(query, userId, limit, offset, sortBy, sortOrder) {
    try {
      // Get user's chats
      const userChats = await Chat.findAll({
        where: {
          [Op.or]: [
            { userId1: userId },
            { userId2: userId }
          ]
        },
        attributes: ['id']
      });

      const chatIds = userChats.map(chat => chat.id);

      // Get group chats where user is a member
      const userGroups = await Group.findAll({
        include: [{
          model: User,
          as: 'members',
          where: { id: userId },
          attributes: []
        }],
        attributes: ['id']
      });

      const groupIds = userGroups.map(group => group.id);

      const whereCondition = {
        [Op.or]: [
          { content: { [Op.like]: `%${query}%` } },
          { 'attachment.name': { [Op.like]: `%${query}%` } }
        ],
        [Op.or]: [
          { chatId: { [Op.in]: chatIds } },
          { groupId: { [Op.in]: groupIds } }
        ]
      };

      const { count, rows } = await Message.findAndCountAll({
        where: whereCondition,
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'profilePicture']
          },
          {
            model: Chat,
            attributes: ['id', 'name']
          },
          {
            model: Group,
            attributes: ['id', 'name', 'avatar']
          }
        ],
        order: [[sortBy, sortOrder]],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search messages service error:', error);
      throw new ServerError('Failed to search messages');
    }
  }

  async searchChatMessages(chatId, query, userId, limit, offset) {
    try {
      // Verify user has access to this chat
      const chat = await Chat.findOne({
        where: {
          id: chatId,
          [Op.or]: [
            { userId1: userId },
            { userId2: userId }
          ]
        }
      });

      if (!chat) {
        throw new ValidationError('Chat not found or access denied');
      }

      const { count, rows } = await Message.findAndCountAll({
        where: {
          [Op.or]: [
            { content: { [Op.like]: `%${query}%` } },
            { 'attachment.name': { [Op.like]: `%${query}%` } }
          ],
          chatId
        },
        include: [{
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'profilePicture']
        }],
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        chatId,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search chat messages service error:', error);
      throw new ServerError('Failed to search chat messages');
    }
  }

  // User search
  async searchUsers(query, userId, limit, offset, excludeContacts) {
    try {
      const whereCondition = {
        [Op.or]: [
          { username: { [Op.like]: `%${query}%` } },
          { email: { [Op.like]: `%${query}%` } },
          { bio: { [Op.like]: `%${query}%` } },
          { location: { [Op.like]: `%${query}%` } }
        ],
        id: { [Op.ne]: userId } // Exclude self
      };

      if (excludeContacts) {
        // Get user's contacts
        const user = await User.findByPk(userId, {
          include: [{
            model: User,
            as: 'friends',
            attributes: ['id']
          }]
        });

        const contactIds = user.friends ? user.friends.map(friend => friend.id) : [];
        whereCondition.id = { [Op.notIn]: [userId, ...contactIds] };
      }

      const { count, rows } = await User.findAndCountAll({
        where: whereCondition,
        attributes: ['id', 'username', 'email', 'profilePicture', 'bio', 'location', 'status', 'lastSeen'],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search users service error:', error);
      throw new ServerError('Failed to search users');
    }
  }

  async searchOnlineUsers(query, userId, limit, offset) {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const { count, rows } = await User.findAndCountAll({
        where: {
          [Op.or]: [
            { username: { [Op.like]: `%${query}%` } },
            { email: { [Op.like]: `%${query}%` } }
          ],
          id: { [Op.ne]: userId },
          lastSeen: { [Op.gte]: fiveMinutesAgo }
        },
        attributes: ['id', 'username', 'email', 'profilePicture', 'status', 'lastSeen'],
        order: [['lastSeen', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset,
        onlineCount: count
      };
    } catch (error) {
      logger.error('Search online users service error:', error);
      throw new ServerError('Failed to search online users');
    }
  }

  async searchNearbyUsers(latitude, longitude, radius, userId, limit) {
    try {
      // This is a simplified implementation
      // In production, you would use geospatial queries
      const { count, rows } = await User.findAndCountAll({
        where: {
          id: { [Op.ne]: userId },
          latitude: {
            [Op.between]: [latitude - radius, latitude + radius]
          },
          longitude: {
            [Op.between]: [longitude - radius, longitude + radius]
          }
        },
        attributes: ['id', 'username', 'profilePicture', 'latitude', 'longitude', 'location', 'lastSeen'],
        order: [['lastSeen', 'DESC']],
        limit,
        distinct: true
      });

      // Calculate distances
      const resultsWithDistance = rows.map(user => {
        const distance = this.calculateDistance(
          latitude,
          longitude,
          user.latitude || latitude,
          user.longitude || longitude
        );
        return {
          ...user.toJSON(),
          distance: Math.round(distance * 100) / 100
        };
      });

      // Sort by distance
      resultsWithDistance.sort((a, b) => a.distance - b.distance);

      return {
        results: resultsWithDistance,
        total: count,
        center: { latitude, longitude },
        radius,
        limit
      };
    } catch (error) {
      logger.error('Search nearby users service error:', error);
      throw new ServerError('Failed to search nearby users');
    }
  }

  // Group search
  async searchGroups(query, userId, limit, offset, includePrivate) {
    try {
      const whereCondition = {
        [Op.or]: [
          { name: { [Op.like]: `%${query}%` } },
          { description: { [Op.like]: `%${query}%` } }
        ]
      };

      if (!includePrivate) {
        whereCondition.isPrivate = false;
      }

      const { count, rows } = await Group.findAndCountAll({
        where: whereCondition,
        include: [{
          model: User,
          as: 'members',
          attributes: ['id', 'username', 'profilePicture'],
          through: { attributes: [] }
        }],
        attributes: ['id', 'name', 'description', 'avatar', 'isPrivate', 'memberCount', 'createdAt'],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search groups service error:', error);
      throw new ServerError('Failed to search groups');
    }
  }

  async searchPublicGroups(query, limit, offset) {
    try {
      const { count, rows } = await Group.findAndCountAll({
        where: {
          [Op.or]: [
            { name: { [Op.like]: `%${query}%` } },
            { description: { [Op.like]: `%${query}%` } }
          ],
          isPrivate: false
        },
        attributes: ['id', 'name', 'description', 'avatar', 'memberCount', 'createdAt'],
        order: [['memberCount', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search public groups service error:', error);
      throw new ServerError('Failed to search public groups');
    }
  }

  async searchJoinedGroups(query, userId, limit, offset) {
    try {
      const { count, rows } = await Group.findAndCountAll({
        include: [{
          model: User,
          as: 'members',
          where: { id: userId },
          attributes: [],
          through: { attributes: [] }
        }],
        where: {
          [Op.or]: [
            { name: { [Op.like]: `%${query}%` } },
            { description: { [Op.like]: `%${query}%` } }
          ]
        },
        attributes: ['id', 'name', 'description', 'avatar', 'memberCount', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search joined groups service error:', error);
      throw new ServerError('Failed to search joined groups');
    }
  }

  // Channel search (simplified - similar to groups)
  async searchChannels(query, userId, limit, offset) {
    try {
      // In production, you would have a Channel model
      return await this.searchGroups(query, userId, limit, offset, true);
    } catch (error) {
      logger.error('Search channels service error:', error);
      throw new ServerError('Failed to search channels');
    }
  }

  async searchPublicChannels(query, limit, offset) {
    try {
      return await this.searchPublicGroups(query, limit, offset);
    } catch (error) {
      logger.error('Search public channels service error:', error);
      throw new ServerError('Failed to search public channels');
    }
  }

  async searchSubscribedChannels(query, userId, limit, offset) {
    try {
      return await this.searchJoinedGroups(query, userId, limit, offset);
    } catch (error) {
      logger.error('Search subscribed channels service error:', error);
      throw new ServerError('Failed to search subscribed channels');
    }
  }

  // File search
  async searchFiles(query, userId, limit, offset, fileType) {
    try {
      const whereCondition = {
        [Op.or]: [
          { filename: { [Op.like]: `%${query}%` } },
          { originalName: { [Op.like]: `%${query}%` } }
        ],
        userId
      };

      if (fileType) {
        whereCondition.mimetype = { [Op.like]: `${fileType}%` };
      }

      const { count, rows } = await File.findAndCountAll({
        where: whereCondition,
        attributes: ['id', 'filename', 'originalName', 'filepath', 'mimetype', 'size', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        fileType,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search files service error:', error);
      throw new ServerError('Failed to search files');
    }
  }

  async searchImages(query, userId, limit, offset) {
    try {
      return await this.searchFiles(query, userId, limit, offset, 'image/');
    } catch (error) {
      logger.error('Search images service error:', error);
      throw new ServerError('Failed to search images');
    }
  }

  async searchDocuments(query, userId, limit, offset) {
    try {
      const documentTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument'];
      const whereCondition = {
        [Op.or]: [
          { filename: { [Op.like]: `%${query}%` } },
          { originalName: { [Op.like]: `%${query}%` } }
        ],
        userId,
        mimetype: { [Op.or]: documentTypes.map(type => ({ [Op.like]: `${type}%` })) }
      };

      const { count, rows } = await File.findAndCountAll({
        where: whereCondition,
        attributes: ['id', 'filename', 'originalName', 'filepath', 'mimetype', 'size', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search documents service error:', error);
      throw new ServerError('Failed to search documents');
    }
  }

  async searchMedia(query, userId, limit, offset) {
    try {
      const mediaTypes = ['video/', 'audio/'];
      const whereCondition = {
        [Op.or]: [
          { filename: { [Op.like]: `%${query}%` } },
          { originalName: { [Op.like]: `%${query}%` } }
        ],
        userId,
        mimetype: { [Op.or]: mediaTypes.map(type => ({ [Op.like]: `${type}%` })) }
      };

      const { count, rows } = await File.findAndCountAll({
        where: whereCondition,
        attributes: ['id', 'filename', 'originalName', 'filepath', 'mimetype', 'size', 'duration', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search media service error:', error);
      throw new ServerError('Failed to search media');
    }
  }

  // Note search
  async searchNotes(query, userId, limit, offset, includeContent) {
    try {
      const whereCondition = {
        [Op.or]: [
          { title: { [Op.like]: `%${query}%` } },
          includeContent ? { content: { [Op.like]: `%${query}%` } } : {}
        ].filter(condition => Object.keys(condition).length > 0),
        userId
      };

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        attributes: includeContent 
          ? ['id', 'title', 'content', 'category', 'tags', 'isPinned', 'isArchived', 'createdAt', 'updatedAt']
          : ['id', 'title', 'category', 'tags', 'isPinned', 'isArchived', 'createdAt', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        includeContent,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search notes service error:', error);
      throw new ServerError('Failed to search notes');
    }
  }

  async searchPinnedNotes(query, userId, limit, offset) {
    try {
      const { count, rows } = await Note.findAndCountAll({
        where: {
          [Op.or]: [
            { title: { [Op.like]: `%${query}%` } },
            { content: { [Op.like]: `%${query}%` } }
          ],
          userId,
          isPinned: true
        },
        attributes: ['id', 'title', 'content', 'category', 'tags', 'createdAt', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search pinned notes service error:', error);
      throw new ServerError('Failed to search pinned notes');
    }
  }

  async searchArchivedNotes(query, userId, limit, offset) {
    try {
      const { count, rows } = await Note.findAndCountAll({
        where: {
          [Op.or]: [
            { title: { [Op.like]: `%${query}%` } },
            { content: { [Op.like]: `%${query}%` } }
          ],
          userId,
          isArchived: true
        },
        attributes: ['id', 'title', 'content', 'category', 'tags', 'createdAt', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search archived notes service error:', error);
      throw new ServerError('Failed to search archived notes');
    }
  }

  // Contact search
  async searchContacts(query, userId, limit, offset) {
    try {
      const user = await User.findByPk(userId, {
        include: [{
          model: User,
          as: 'friends',
          where: {
            [Op.or]: [
              { username: { [Op.like]: `%${query}%` } },
              { email: { [Op.like]: `%${query}%` } }
            ]
          },
          attributes: ['id', 'username', 'email', 'profilePicture', 'bio', 'location', 'status', 'lastSeen']
        }]
      });

      const contacts = user?.friends || [];
      const paginatedContacts = contacts.slice(offset, offset + limit);

      return {
        results: paginatedContacts,
        total: contacts.length,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search contacts service error:', error);
      throw new ServerError('Failed to search contacts');
    }
  }

  async searchFrequentContacts(query, userId, limit, offset) {
    try {
      // This would require message frequency analysis
      // For now, returning regular contacts
      return await this.searchContacts(query, userId, limit, offset);
    } catch (error) {
      logger.error('Search frequent contacts service error:', error);
      throw new ServerError('Failed to search frequent contacts');
    }
  }

  // Event search (simplified - would require Event model)
  async searchEvents(query, userId, limit, offset, status) {
    try {
      // Placeholder implementation
      return {
        results: [],
        total: 0,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search events service error:', error);
      throw new ServerError('Failed to search events');
    }
  }

  async searchUpcomingEvents(query, userId, limit, offset) {
    try {
      return await this.searchEvents(query, userId, limit, offset, 'upcoming');
    } catch (error) {
      logger.error('Search upcoming events service error:', error);
      throw new ServerError('Failed to search upcoming events');
    }
  }

  async searchPastEvents(query, userId, limit, offset) {
    try {
      return await this.searchEvents(query, userId, limit, offset, 'past');
    } catch (error) {
      logger.error('Search past events service error:', error);
      throw new ServerError('Failed to search past events');
    }
  }

  // Task search (simplified - would require Task model)
  async searchTasks(query, userId, limit, offset, priority, status) {
    try {
      // Placeholder implementation
      return {
        results: [],
        total: 0,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search tasks service error:', error);
      throw new ServerError('Failed to search tasks');
    }
  }

  async searchCompletedTasks(query, userId, limit, offset) {
    try {
      return await this.searchTasks(query, userId, limit, offset, null, 'completed');
    } catch (error) {
      logger.error('Search completed tasks service error:', error);
      throw new ServerError('Failed to search completed tasks');
    }
  }

  async searchPendingTasks(query, userId, limit, offset) {
    try {
      return await this.searchTasks(query, userId, limit, offset, null, 'pending');
    } catch (error) {
      logger.error('Search pending tasks service error:', error);
      throw new ServerError('Failed to search pending tasks');
    }
  }

  // Bookmark search (simplified - would require Bookmark model)
  async searchBookmarks(query, userId, limit, offset, category) {
    try {
      // Placeholder implementation
      return {
        results: [],
        total: 0,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search bookmarks service error:', error);
      throw new ServerError('Failed to search bookmarks');
    }
  }

  // History search
  async searchHistory(query, userId, limit, offset, type, startDate, endDate) {
    try {
      const whereCondition = {
        query: { [Op.like]: `%${query}%` },
        userId
      };

      if (type) {
        whereCondition.type = type;
      }

      if (startDate && endDate) {
        whereCondition.searchedAt = {
          [Op.between]: [new Date(startDate), new Date(endDate)]
        };
      }

      // In production, you would have a SearchHistory model
      return {
        results: [],
        total: 0,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search history service error:', error);
      throw new ServerError('Failed to search history');
    }
  }

  async searchRecentHistory(query, userId, limit, offset) {
    try {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      // In production, you would query SearchHistory model
      return {
        results: [],
        total: 0,
        query,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search recent history service error:', error);
      throw new ServerError('Failed to search recent history');
    }
  }

  async clearSearchHistory(userId) {
    try {
      // In production, you would delete from SearchHistory model
      return true;
    } catch (error) {
      logger.error('Clear search history service error:', error);
      throw new ServerError('Failed to clear search history');
    }
  }

  // Advanced search
  async advancedSearch(query, filters, userId, sortBy, sortOrder, limit, offset) {
    try {
      // Combine multiple search criteria
      const searchPromises = [];
      
      if (filters?.includeUsers) {
        searchPromises.push(this.searchUsers(query, userId, limit, offset, false));
      }
      
      if (filters?.includeMessages) {
        searchPromises.push(this.searchMessages(query, userId, limit, offset, sortBy, sortOrder));
      }
      
      if (filters?.includeNotes) {
        searchPromises.push(this.searchNotes(query, userId, limit, offset, true));
      }
      
      if (filters?.includeFiles) {
        searchPromises.push(this.searchFiles(query, userId, limit, offset));
      }

      const results = await Promise.all(searchPromises);
      
      // Combine and sort results
      const combinedResults = [];
      results.forEach(result => {
        if (result.results) {
          combinedResults.push(...result.results);
        }
      });

      // Apply sorting
      if (sortBy && sortOrder) {
        combinedResults.sort((a, b) => {
          const aValue = a[sortBy];
          const bValue = b[sortBy];
          
          if (sortOrder === 'asc') {
            return aValue > bValue ? 1 : -1;
          } else {
            return aValue < bValue ? 1 : -1;
          }
        });
      }

      // Paginate
      const paginatedResults = combinedResults.slice(offset, offset + limit);

      return {
        results: paginatedResults,
        total: combinedResults.length,
        query,
        filters,
        sortBy,
        sortOrder,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Advanced search service error:', error);
      throw new ServerError('Failed to perform advanced search');
    }
  }

  // Search by location
  async searchByLocation(latitude, longitude, radius, type, userId, limit) {
    try {
      let results = [];
      
      if (!type || type === 'users') {
        const users = await this.searchNearbyUsers(latitude, longitude, radius, userId, limit);
        results.push(...users.results.map(user => ({ ...user, type: 'user' })));
      }
      
      // Add other location-based searches (events, places, etc.)
      
      return {
        results,
        total: results.length,
        center: { latitude, longitude },
        radius,
        type,
        limit
      };
    } catch (error) {
      logger.error('Search by location service error:', error);
      throw new ServerError('Failed to search by location');
    }
  }

  // Search by date
  async searchByDate(date, type, range, userId, limit, offset) {
    try {
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

      let results = [];
      let total = 0;
      
      // Search based on type
      switch (type) {
        case 'messages':
          const messages = await Message.findAndCountAll({
            where: {
              userId,
              createdAt: { [Op.between]: [startDate, endDate] }
            },
            limit,
            offset,
            distinct: true
          });
          results = messages.rows;
          total = messages.count;
          break;
          
        case 'notes':
          const notes = await Note.findAndCountAll({
            where: {
              userId,
              [Op.or]: [
                { createdAt: { [Op.between]: [startDate, endDate] } },
                { updatedAt: { [Op.between]: [startDate, endDate] } }
              ]
            },
            limit,
            offset,
            distinct: true
          });
          results = notes.rows;
          total = notes.count;
          break;
          
        default:
          // Search all types
          const [messagesResult, notesResult] = await Promise.all([
            Message.findAndCountAll({
              where: {
                userId,
                createdAt: { [Op.between]: [startDate, endDate] }
              },
              limit: Math.ceil(limit / 2),
              offset,
              distinct: true
            }),
            Note.findAndCountAll({
              where: {
                userId,
                [Op.or]: [
                  { createdAt: { [Op.between]: [startDate, endDate] } },
                  { updatedAt: { [Op.between]: [startDate, endDate] } }
                ]
              },
              limit: Math.ceil(limit / 2),
              offset,
              distinct: true
            })
          ]);
          
          results = [...messagesResult.rows, ...notesResult.rows];
          total = messagesResult.count + notesResult.count;
      }

      return {
        results,
        total,
        date,
        range,
        type,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search by date service error:', error);
      throw new ServerError('Failed to search by date');
    }
  }

  // Search by tags
  async searchByTags(tags, operator, userId, limit, offset, type) {
    try {
      let results = [];
      let total = 0;
      
      if (!type || type === 'notes') {
        const tagConditions = tags.map(tag => ({
          tags: { [Op.like]: `%${tag}%` }
        }));
        
        const whereCondition = {
          userId,
          [operator === 'AND' ? Op.and : Op.or]: tagConditions
        };
        
        const { count, rows } = await Note.findAndCountAll({
          where: whereCondition,
          limit,
          offset,
          distinct: true
        });
        
        results.push(...rows.map(note => ({ ...note.toJSON(), type: 'note' })));
        total += count;
      }
      
      // Add other tag-based searches
      
      return {
        results,
        total,
        tags,
        operator,
        type,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search by tags service error:', error);
      throw new ServerError('Failed to search by tags');
    }
  }

  async getPopularTags(userId, limit, type) {
    try {
      // In production, you would analyze tags from notes, messages, etc.
      const popularTags = [
        { tag: 'work', count: 45 },
        { tag: 'personal', count: 32 },
        { tag: 'important', count: 28 },
        { tag: 'todo', count: 25 },
        { tag: 'ideas', count: 20 },
        { tag: 'meeting', count: 18 },
        { tag: 'project', count: 15 },
        { tag: 'reference', count: 12 },
        { tag: 'temporary', count: 10 },
        { tag: 'archive', count: 8 }
      ].slice(0, limit);

      return {
        tags: popularTags,
        total: popularTags.length,
        userId,
        type
      };
    } catch (error) {
      logger.error('Get popular tags service error:', error);
      throw new ServerError('Failed to get popular tags');
    }
  }

  // Search by category
  async searchByCategory(category, subcategory, userId, limit, offset) {
    try {
      const whereCondition = {
        userId,
        category: { [Op.like]: `%${category}%` }
      };

      if (subcategory) {
        whereCondition.subcategory = subcategory;
      }

      const { count, rows } = await Note.findAndCountAll({
        where: whereCondition,
        limit,
        offset,
        distinct: true
      });

      return {
        results: rows,
        total: count,
        category,
        subcategory,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Search by category service error:', error);
      throw new ServerError('Failed to search by category');
    }
  }

  // Search suggestions
  async getSearchSuggestions(query, type, userId, limit) {
    try {
      const suggestions = [];
      
      if (!type || type === 'users') {
        const users = await User.findAll({
          where: {
            [Op.or]: [
              { username: { [Op.like]: `${query}%` } },
              { email: { [Op.like]: `${query}%` } }
            ],
            id: { [Op.ne]: userId }
          },
          attributes: ['username', 'email', 'profilePicture'],
          limit: Math.ceil(limit / 3),
          distinct: true
        });
        
        suggestions.push(...users.map(user => ({
          type: 'user',
          text: user.username,
          value: user.username,
          image: user.profilePicture
        })));
      }
      
      if (!type || type === 'notes') {
        const notes = await Note.findAll({
          where: {
            userId,
            title: { [Op.like]: `${query}%` }
          },
          attributes: ['title', 'category'],
          limit: Math.ceil(limit / 3),
          distinct: true
        });
        
        suggestions.push(...notes.map(note => ({
          type: 'note',
          text: note.title,
          value: note.title,
          category: note.category
        })));
      }
      
      // Add popular searches
      const popularSearches = await this.getPopularSearches('day', Math.ceil(limit / 3), type, userId);
      suggestions.push(...popularSearches.searches.map(search => ({
        type: 'popular',
        text: search.query,
        value: search.query,
        count: search.count
      })));

      return {
        suggestions: suggestions.slice(0, limit),
        total: suggestions.length,
        query,
        type
      };
    } catch (error) {
      logger.error('Get search suggestions service error:', error);
      throw new ServerError('Failed to get search suggestions');
    }
  }

  async getAutocomplete(query, type, userId, limit) {
    try {
      const suggestions = await this.getSearchSuggestions(query, type, userId, limit * 2);
      
      // Filter for exact or close matches
      const autocompleteResults = suggestions.suggestions
        .filter(suggestion => 
          suggestion.text.toLowerCase().startsWith(query.toLowerCase())
        )
        .slice(0, limit);

      return {
        results: autocompleteResults,
        total: autocompleteResults.length,
        query,
        type
      };
    } catch (error) {
      logger.error('Get autocomplete service error:', error);
      throw new ServerError('Failed to get autocomplete');
    }
  }

  // Search filters
  async getSearchFilters(type, userId) {
    try {
      const filters = {
        dateRanges: [
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: 'this_week', label: 'This Week' },
          { value: 'this_month', label: 'This Month' },
          { value: 'this_year', label: 'This Year' },
          { value: 'custom', label: 'Custom Range' }
        ],
        fileTypes: [
          { value: 'image', label: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
          { value: 'document', label: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt'] },
          { value: 'audio', label: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] },
          { value: 'video', label: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv'] },
          { value: 'archive', label: 'Archives', extensions: ['zip', 'rar', 'tar', 'gz'] }
        ],
        sortOptions: [
          { value: 'relevance', label: 'Relevance' },
          { value: 'date_desc', label: 'Newest First' },
          { value: 'date_asc', label: 'Oldest First' },
          { value: 'name_asc', label: 'Name A-Z' },
          { value: 'name_desc', label: 'Name Z-A' },
          { value: 'size_desc', label: 'Largest First' },
          { value: 'size_asc', label: 'Smallest First' }
        ],
        userStatus: [
          { value: 'online', label: 'Online' },
          { value: 'offline', label: 'Offline' },
          { value: 'all', label: 'All Statuses' }
        ]
      };

      // Add type-specific filters
      if (type === 'notes') {
        filters.noteCategories = await this.getUserNoteCategories(userId);
        filters.noteTags = await this.getUserNoteTags(userId);
      }

      return {
        filters,
        type,
        userId
      };
    } catch (error) {
      logger.error('Get search filters service error:', error);
      throw new ServerError('Failed to get search filters');
    }
  }

  async saveSearchFilter(name, filters, type, userId, isDefault) {
    try {
      // In production, you would save to SearchFilter model
      const filterId = `filter_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      return {
        id: filterId,
        name,
        filters,
        type,
        userId,
        isDefault,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    } catch (error) {
      logger.error('Save search filter service error:', error);
      throw new ServerError('Failed to save search filter');
    }
  }

  async getSavedFilters(userId, type) {
    try {
      // In production, you would query SearchFilter model
      return {
        filters: [
          {
            id: 'filter_1',
            name: 'Recent Documents',
            filters: { fileType: 'document', dateRange: 'this_week' },
            type: 'files',
            isDefault: true,
            createdAt: new Date('2023-12-01')
          },
          {
            id: 'filter_2',
            name: 'Important Notes',
            filters: { tags: ['important'], isPinned: true },
            type: 'notes',
            isDefault: false,
            createdAt: new Date('2023-12-05')
          }
        ].filter(filter => (!type || filter.type === type) && filter.userId === userId),
        total: 2,
        userId,
        type
      };
    } catch (error) {
      logger.error('Get saved filters service error:', error);
      throw new ServerError('Failed to get saved filters');
    }
  }

  async deleteSearchFilter(filterId, userId) {
    try {
      // In production, you would delete from SearchFilter model
      return true;
    } catch (error) {
      logger.error('Delete search filter service error:', error);
      throw new ServerError('Failed to delete search filter');
    }
  }

  // Search statistics
  async getPopularSearches(period, limit, type, userId) {
    try {
      // In production, you would analyze search history
      const popularSearches = [
        { query: 'project requirements', count: 45, type: 'notes' },
        { query: 'meeting notes', count: 32, type: 'notes' },
        { query: 'john doe', count: 28, type: 'users' },
        { query: 'vacation photos', count: 25, type: 'files' },
        { query: 'quarterly report', count: 22, type: 'documents' },
        { query: 'team chat', count: 20, type: 'messages' },
        { query: 'design resources', count: 18, type: 'files' },
        { query: 'client feedback', count: 15, type: 'notes' },
        { query: 'code snippets', count: 12, type: 'notes' },
        { query: 'presentation slides', count: 10, type: 'files' }
      ].slice(0, limit);

      return {
        searches: popularSearches,
        period,
        total: popularSearches.length,
        type,
        userId
      };
    } catch (error) {
      logger.error('Get popular searches service error:', error);
      throw new ServerError('Failed to get popular searches');
    }
  }

  async getTrendingSearches(limit, type, userId) {
    try {
      // In production, you would analyze recent search trends
      const trendingSearches = [
        { query: 'new feature', trend: 'up', change: 45 },
        { query: 'bug fixes', trend: 'up', change: 32 },
        { query: 'user feedback', trend: 'up', change: 28 },
        { query: 'performance', trend: 'down', change: -15 },
        { query: 'security update', trend: 'up', change: 22 }
      ].slice(0, limit);

      return {
        searches: trendingSearches,
        total: trendingSearches.length,
        type,
        userId
      };
    } catch (error) {
      logger.error('Get trending searches service error:', error);
      throw new ServerError('Failed to get trending searches');
    }
  }

  // Search index management
  async rebuildSearchIndex(type) {
    try {
      // In production, you would rebuild the search index
      let indexedCount = 0;
      
      if (!type || type === 'users') {
        const users = await User.findAll();
        indexedCount += users.length;
      }
      
      if (!type || type === 'notes') {
        const notes = await Note.findAll();
        indexedCount += notes.length;
      }
      
      if (!type || type === 'messages') {
        const messages = await Message.findAll();
        indexedCount += messages.length;
      }

      return {
        status: 'completed',
        indexedCount,
        type,
        startedAt: new Date(Date.now() - 5000), // 5 seconds ago
        completedAt: new Date(),
        duration: '5 seconds'
      };
    } catch (error) {
      logger.error('Rebuild search index service error:', error);
      throw new ServerError('Failed to rebuild search index');
    }
  }

  async getIndexStatus(type) {
    try {
      // In production, you would check actual index status
      const status = {
        users: { indexed: 1500, total: 1500, lastUpdated: new Date(Date.now() - 3600000) },
        notes: { indexed: 4500, total: 4500, lastUpdated: new Date(Date.now() - 1800000) },
        messages: { indexed: 12500, total: 12500, lastUpdated: new Date(Date.now() - 900000) },
        files: { indexed: 800, total: 800, lastUpdated: new Date(Date.now() - 7200000) },
        overall: { health: 'good', size: '2.3GB', lastMaintenance: new Date(Date.now() - 86400000) }
      };

      return {
        status: type ? status[type] : status,
        type,
        checkedAt: new Date()
      };
    } catch (error) {
      logger.error('Get index status service error:', error);
      throw new ServerError('Failed to get index status');
    }
  }

  // Real-time search
  async realtimeSearch(query, type, userId, limit) {
    try {
      // This would use WebSockets or similar for real-time updates
      // For now, returning regular search results
      let results;
      
      switch (type) {
        case 'users':
          results = await this.searchUsers(query, userId, limit, 0, false);
          break;
        case 'messages':
          results = await this.searchMessages(query, userId, limit, 0, 'date', 'desc');
          break;
        case 'notes':
          results = await this.searchNotes(query, userId, limit, 0, true);
          break;
        default:
          results = await this.globalSearch(query, limit, 0, userId);
      }

      return {
        ...results,
        realtime: true,
        query,
        type,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Realtime search service error:', error);
      throw new ServerError('Failed to perform real-time search');
    }
  }

  // Voice search
  async voiceSearch(audioFile, language, userId) {
    try {
      // In production, you would use a speech-to-text service
      const transcribedText = 'Sample transcribed text from voice search';
      
      // Perform search with transcribed text
      const searchResults = await this.globalSearch(transcribedText, 20, 0, userId);
      
      return {
        audioFile: audioFile.originalname,
        transcribedText,
        language,
        searchResults,
        confidence: 0.85,
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Voice search service error:', error);
      throw new ServerError('Failed to perform voice search');
    }
  }

  // Image search
  async imageSearch(imageFile, similarity, userId, limit) {
    try {
      // In production, you would use image recognition/AI
      const identifiedObjects = ['document', 'text', 'person', 'nature'];
      const extractedText = 'Sample text extracted from image';
      
      // Perform search based on identified objects and text
      const searchResults = await this.globalSearch(extractedText, limit, 0, userId);
      
      // Add visual similarity results
      const similarImages = await this.searchImages(extractedText, userId, limit, 0);
      
      return {
        imageFile: imageFile.originalname,
        identifiedObjects,
        extractedText,
        searchResults,
        similarImages: similarImages.results,
        similarity,
        processedAt: new Date()
      };
    } catch (error) {
      logger.error('Image search service error:', error);
      throw new ServerError('Failed to perform image search');
    }
  }

  // Search sharing
  async shareSearch(searchResults, recipients, userId, message, expiresAt) {
    try {
      const shareId = `share_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const shareUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/search/share/${shareId}`;
      
      return {
        shareId,
        shareUrl,
        searchResults: {
          query: searchResults.query,
          total: searchResults.total,
          type: searchResults.type
        },
        recipients,
        sharedBy: userId,
        message,
        expiresAt: expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days default
        createdAt: new Date(),
        viewCount: 0
      };
    } catch (error) {
      logger.error('Share search service error:', error);
      throw new ServerError('Failed to share search');
    }
  }

  async getSharedSearch(shareId, userId) {
    try {
      // In production, you would retrieve from shared searches database
      return {
        shareId,
        searchResults: {
          query: 'project requirements',
          results: [],
          total: 45,
          type: 'notes'
        },
        sharedBy: 'user_123',
        sharedAt: new Date('2023-12-01'),
        expiresAt: new Date('2023-12-08'),
        viewCount: 12,
        canAccess: true
      };
    } catch (error) {
      logger.error('Get shared search service error:', error);
      throw new ServerError('Failed to get shared search');
    }
  }

  // Search export
  async exportSearchResults(searchResults, format, includeMetadata, userId) {
    try {
      const exportData = {
        metadata: includeMetadata ? {
          exportedBy: userId,
          exportedAt: new Date(),
          query: searchResults.query,
          totalResults: searchResults.total,
          filters: searchResults.filters
        } : null,
        results: searchResults.results || []
      };

      if (format === 'csv') {
        // Convert to CSV
        let csv = 'Type,Title,Content,Created At\n';
        
        (searchResults.results || []).forEach(result => {
          const type = result.type || 'unknown';
          const title = result.title || result.username || result.filename || '';
          const content = result.content || result.email || result.description || '';
          const createdAt = result.createdAt || new Date();
          
          csv += `"${type}","${title}","${content}","${createdAt}"\n`;
        });
        
        return csv;
      } else if (format === 'json') {
        return exportData;
      } else {
        throw new ValidationError('Unsupported export format');
      }
    } catch (error) {
      logger.error('Export search results service error:', error);
      throw new ServerError('Failed to export search results');
    }
  }

  // Search notifications
  async setupSearchNotification(query, frequency, type, userId, notifyVia) {
    try {
      const notificationId = `notify_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      return {
        notificationId,
        query,
        frequency,
        type,
        userId,
        notifyVia,
        isActive: true,
        lastChecked: new Date(),
        nextCheck: this.calculateNextCheckDate(frequency),
        createdAt: new Date(),
        matchCount: 0
      };
    } catch (error) {
      logger.error('Setup search notification service error:', error);
      throw new ServerError('Failed to setup search notification');
    }
  }

  async getSearchNotifications(userId, status) {
    try {
      // In production, you would query SearchNotification model
      const notifications = [
        {
          notificationId: 'notify_1',
          query: 'new messages',
          frequency: 'daily',
          type: 'messages',
          isActive: true,
          lastChecked: new Date(Date.now() - 3600000),
          nextCheck: new Date(Date.now() + 82800000), // 23 hours from now
          matchCount: 12
        },
        {
          notificationId: 'notify_2',
          query: 'project updates',
          frequency: 'weekly',
          type: 'notes',
          isActive: true,
          lastChecked: new Date(Date.now() - 86400000),
          nextCheck: new Date(Date.now() + 518400000), // 6 days from now
          matchCount: 3
        }
      ];

      const filteredNotifications = notifications.filter(notification => 
        notification.userId === userId && 
        (status === 'all' || (status === 'active' && notification.isActive) || (status === 'inactive' && !notification.isActive))
      );

      return {
        notifications: filteredNotifications,
        total: filteredNotifications.length,
        userId,
        status
      };
    } catch (error) {
      logger.error('Get search notifications service error:', error);
      throw new ServerError('Failed to get search notifications');
    }
  }

  async deleteSearchNotification(notificationId, userId) {
    try {
      // In production, you would delete from SearchNotification model
      return true;
    } catch (error) {
      logger.error('Delete search notification service error:', error);
      throw new ServerError('Failed to delete search notification');
    }
  }

  // Helper methods
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  calculateNextCheckDate(frequency) {
    const now = new Date();
    switch (frequency) {
      case 'hourly':
        return new Date(now.getTime() + 3600000);
      case 'daily':
        return new Date(now.getTime() + 86400000);
      case 'weekly':
        return new Date(now.getTime() + 604800000);
      case 'monthly':
        return new Date(now.getTime() + 2592000000);
      default:
        return new Date(now.getTime() + 86400000);
    }
  }

  async getUserNoteCategories(userId) {
    try {
      const notes = await Note.findAll({
        where: { userId },
        attributes: ['category'],
        group: ['category'],
        distinct: true
      });

      return notes
        .map(note => note.category)
        .filter(category => category)
        .map(category => ({ value: category, label: category }));
    } catch (error) {
      return [];
    }
  }

  async getUserNoteTags(userId) {
    try {
      const notes = await Note.findAll({
        where: { userId },
        attributes: ['tags']
      });

      const allTags = [];
      notes.forEach(note => {
        if (note.tags && Array.isArray(note.tags)) {
          allTags.push(...note.tags);
        }
      });

      const tagCounts = {};
      allTags.forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });

      return Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([tag, count]) => ({ value: tag, label: `${tag} (${count})` }));
    } catch (error) {
      return [];
    }
  }
}

module.exports = new SearchService();