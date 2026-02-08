const searchService = require('../services/searchService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class SearchController {
  // Global search
  async globalSearch(req, res, next) {
    try {
      const { query, limit = 20, offset = 0 } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.globalSearch(query, parseInt(limit), parseInt(offset), req.user.id);
      res.status(200).json({
        success: true,
        message: 'Global search completed',
        data: result
      });
    } catch (error) {
      logger.error('Global search error:', error);
      next(error);
    }
  }

  // Message search
  async searchMessages(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, sortBy = 'date', sortOrder = 'desc' } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchMessages(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        sortBy,
        sortOrder
      );
      res.status(200).json({
        success: true,
        message: 'Messages search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search messages error:', error);
      next(error);
    }
  }

  async searchChatMessages(req, res, next) {
    try {
      const { chatId } = req.params;
      const { query, limit = 50, offset = 0 } = req.query;
      if (!chatId || !query) {
        throw new AppError('Chat ID and query are required', 400);
      }
      
      const result = await searchService.searchChatMessages(
        chatId,
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Chat messages search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search chat messages error:', error);
      next(error);
    }
  }

  // User search
  async searchUsers(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, excludeContacts = false } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchUsers(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        excludeContacts === 'true'
      );
      res.status(200).json({
        success: true,
        message: 'Users search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search users error:', error);
      next(error);
    }
  }

  async searchOnlineUsers(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchOnlineUsers(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Online users search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search online users error:', error);
      next(error);
    }
  }

  async searchNearbyUsers(req, res, next) {
    try {
      const { latitude, longitude, radius = 10, limit = 50 } = req.query;
      if (!latitude || !longitude) {
        throw new AppError('Latitude and longitude are required', 400);
      }
      
      const result = await searchService.searchNearbyUsers(
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(radius),
        req.user.id,
        parseInt(limit)
      );
      res.status(200).json({
        success: true,
        message: 'Nearby users search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search nearby users error:', error);
      next(error);
    }
  }

  // Group search
  async searchGroups(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, includePrivate = false } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchGroups(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        includePrivate === 'true'
      );
      res.status(200).json({
        success: true,
        message: 'Groups search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search groups error:', error);
      next(error);
    }
  }

  async searchPublicGroups(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchPublicGroups(
        query,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Public groups search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search public groups error:', error);
      next(error);
    }
  }

  async searchJoinedGroups(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchJoinedGroups(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Joined groups search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search joined groups error:', error);
      next(error);
    }
  }

  // Channel search
  async searchChannels(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchChannels(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Channels search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search channels error:', error);
      next(error);
    }
  }

  async searchPublicChannels(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchPublicChannels(
        query,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Public channels search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search public channels error:', error);
      next(error);
    }
  }

  async searchSubscribedChannels(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchSubscribedChannels(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Subscribed channels search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search subscribed channels error:', error);
      next(error);
    }
  }

  // File search
  async searchFiles(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, fileType } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchFiles(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        fileType
      );
      res.status(200).json({
        success: true,
        message: 'Files search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search files error:', error);
      next(error);
    }
  }

  async searchImages(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchImages(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Images search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search images error:', error);
      next(error);
    }
  }

  async searchDocuments(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchDocuments(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Documents search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search documents error:', error);
      next(error);
    }
  }

  async searchMedia(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchMedia(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Media search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search media error:', error);
      next(error);
    }
  }

  // Note search
  async searchNotes(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, includeContent = false } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchNotes(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
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

  async searchPinnedNotes(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchPinnedNotes(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Pinned notes search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search pinned notes error:', error);
      next(error);
    }
  }

  async searchArchivedNotes(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchArchivedNotes(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Archived notes search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search archived notes error:', error);
      next(error);
    }
  }

  // Contact search
  async searchContacts(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchContacts(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Contacts search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search contacts error:', error);
      next(error);
    }
  }

  async searchFrequentContacts(req, res, next) {
    try {
      const { query, limit = 20, offset = 0 } = req.query;
      const result = await searchService.searchFrequentContacts(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Frequent contacts search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search frequent contacts error:', error);
      next(error);
    }
  }

  // Event search
  async searchEvents(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, status } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchEvents(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        status
      );
      res.status(200).json({
        success: true,
        message: 'Events search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search events error:', error);
      next(error);
    }
  }

  async searchUpcomingEvents(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchUpcomingEvents(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Upcoming events search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search upcoming events error:', error);
      next(error);
    }
  }

  async searchPastEvents(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchPastEvents(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Past events search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search past events error:', error);
      next(error);
    }
  }

  // Task search
  async searchTasks(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, priority, status } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchTasks(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        priority,
        status
      );
      res.status(200).json({
        success: true,
        message: 'Tasks search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search tasks error:', error);
      next(error);
    }
  }

  async searchCompletedTasks(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchCompletedTasks(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Completed tasks search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search completed tasks error:', error);
      next(error);
    }
  }

  async searchPendingTasks(req, res, next) {
    try {
      const { query, limit = 50, offset = 0 } = req.query;
      const result = await searchService.searchPendingTasks(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Pending tasks search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search pending tasks error:', error);
      next(error);
    }
  }

  // Bookmark search
  async searchBookmarks(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, category } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchBookmarks(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        category
      );
      res.status(200).json({
        success: true,
        message: 'Bookmarks search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search bookmarks error:', error);
      next(error);
    }
  }

  // History search
  async searchHistory(req, res, next) {
    try {
      const { query, limit = 50, offset = 0, type, startDate, endDate } = req.query;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.searchHistory(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        type,
        startDate,
        endDate
      );
      res.status(200).json({
        success: true,
        message: 'History search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search history error:', error);
      next(error);
    }
  }

  async searchRecentHistory(req, res, next) {
    try {
      const { query, limit = 20, offset = 0 } = req.query;
      const result = await searchService.searchRecentHistory(
        query,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Recent history search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search recent history error:', error);
      next(error);
    }
  }

  async clearSearchHistory(req, res, next) {
    try {
      await searchService.clearSearchHistory(req.user.id);
      res.status(200).json({
        success: true,
        message: 'Search history cleared successfully'
      });
    } catch (error) {
      logger.error('Clear search history error:', error);
      next(error);
    }
  }

  // Advanced search
  async advancedSearch(req, res, next) {
    try {
      const { query, filters, sortBy, sortOrder, limit = 50, offset = 0 } = req.body;
      if (!query) {
        throw new AppError('Search query is required', 400);
      }
      
      const result = await searchService.advancedSearch(
        query,
        filters,
        req.user.id,
        sortBy,
        sortOrder,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Advanced search completed',
        data: result
      });
    } catch (error) {
      logger.error('Advanced search error:', error);
      next(error);
    }
  }

  // Search by location
  async searchByLocation(req, res, next) {
    try {
      const { latitude, longitude, radius = 10, type, limit = 50 } = req.query;
      if (!latitude || !longitude) {
        throw new AppError('Latitude and longitude are required', 400);
      }
      
      const result = await searchService.searchByLocation(
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(radius),
        type,
        req.user.id,
        parseInt(limit)
      );
      res.status(200).json({
        success: true,
        message: 'Location-based search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by location error:', error);
      next(error);
    }
  }

  // Search by date
  async searchByDate(req, res, next) {
    try {
      const { date, type, range = 'exact', limit = 50, offset = 0 } = req.query;
      if (!date) {
        throw new AppError('Date is required', 400);
      }
      
      const result = await searchService.searchByDate(
        date,
        type,
        range,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Date-based search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by date error:', error);
      next(error);
    }
  }

  // Search by tags
  async searchByTags(req, res, next) {
    try {
      const { tags, operator = 'AND', limit = 50, offset = 0, type } = req.query;
      if (!tags) {
        throw new AppError('Tags are required', 400);
      }
      
      const tagArray = Array.isArray(tags) ? tags : tags.split(',');
      const result = await searchService.searchByTags(
        tagArray,
        operator,
        req.user.id,
        parseInt(limit),
        parseInt(offset),
        type
      );
      res.status(200).json({
        success: true,
        message: 'Tag-based search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by tags error:', error);
      next(error);
    }
  }

  async getPopularTags(req, res, next) {
    try {
      const { limit = 20, type } = req.query;
      const result = await searchService.getPopularTags(
        req.user.id,
        parseInt(limit),
        type
      );
      res.status(200).json({
        success: true,
        message: 'Popular tags retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get popular tags error:', error);
      next(error);
    }
  }

  // Search by category
  async searchByCategory(req, res, next) {
    try {
      const { category, subcategory, limit = 50, offset = 0 } = req.query;
      if (!category) {
        throw new AppError('Category is required', 400);
      }
      
      const result = await searchService.searchByCategory(
        category,
        subcategory,
        req.user.id,
        parseInt(limit),
        parseInt(offset)
      );
      res.status(200).json({
        success: true,
        message: 'Category-based search completed',
        data: result
      });
    } catch (error) {
      logger.error('Search by category error:', error);
      next(error);
    }
  }

  // Search suggestions
  async getSearchSuggestions(req, res, next) {
    try {
      const { query, type, limit = 10 } = req.query;
      if (!query) {
        throw new AppError('Query is required for suggestions', 400);
      }
      
      const result = await searchService.getSearchSuggestions(
        query,
        type,
        req.user.id,
        parseInt(limit)
      );
      res.status(200).json({
        success: true,
        message: 'Search suggestions retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get search suggestions error:', error);
      next(error);
    }
  }

  async getAutocomplete(req, res, next) {
    try {
      const { query, type, limit = 5 } = req.query;
      if (!query) {
        throw new AppError('Query is required for autocomplete', 400);
      }
      
      const result = await searchService.getAutocomplete(
        query,
        type,
        req.user.id,
        parseInt(limit)
      );
      res.status(200).json({
        success: true,
        message: 'Autocomplete results retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get autocomplete error:', error);
      next(error);
    }
  }

  // Search filters
  async getSearchFilters(req, res, next) {
    try {
      const { type } = req.body;
      const result = await searchService.getSearchFilters(type, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Search filters retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get search filters error:', error);
      next(error);
    }
  }

  async saveSearchFilter(req, res, next) {
    try {
      const { name, filters, type, isDefault = false } = req.body;
      if (!name || !filters) {
        throw new AppError('Name and filters are required', 400);
      }
      
      const result = await searchService.saveSearchFilter(
        name,
        filters,
        type,
        req.user.id,
        isDefault
      );
      res.status(201).json({
        success: true,
        message: 'Search filter saved successfully',
        data: result
      });
    } catch (error) {
      logger.error('Save search filter error:', error);
      next(error);
    }
  }

  async getSavedFilters(req, res, next) {
    try {
      const { type } = req.query;
      const result = await searchService.getSavedFilters(req.user.id, type);
      res.status(200).json({
        success: true,
        message: 'Saved filters retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get saved filters error:', error);
      next(error);
    }
  }

  async deleteSearchFilter(req, res, next) {
    try {
      const { filterId } = req.params;
      await searchService.deleteSearchFilter(filterId, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Search filter deleted successfully'
      });
    } catch (error) {
      logger.error('Delete search filter error:', error);
      next(error);
    }
  }

  // Search statistics
  async getPopularSearches(req, res, next) {
    try {
      const { period = 'week', limit = 10, type } = req.query;
      const result = await searchService.getPopularSearches(
        period,
        parseInt(limit),
        type,
        req.user.id
      );
      res.status(200).json({
        success: true,
        message: 'Popular searches retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get popular searches error:', error);
      next(error);
    }
  }

  async getTrendingSearches(req, res, next) {
    try {
      const { limit = 10, type } = req.query;
      const result = await searchService.getTrendingSearches(
        parseInt(limit),
        type,
        req.user.id
      );
      res.status(200).json({
        success: true,
        message: 'Trending searches retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get trending searches error:', error);
      next(error);
    }
  }

  // Search index management
  async rebuildSearchIndex(req, res, next) {
    try {
      const { type } = req.body;
      if (!req.user.isAdmin) {
        throw new AppError('Admin privileges required', 403);
      }
      
      const result = await searchService.rebuildSearchIndex(type);
      res.status(200).json({
        success: true,
        message: 'Search index rebuild initiated',
        data: result
      });
    } catch (error) {
      logger.error('Rebuild search index error:', error);
      next(error);
    }
  }

  async getIndexStatus(req, res, next) {
    try {
      const { type } = req.query;
      const result = await searchService.getIndexStatus(type);
      res.status(200).json({
        success: true,
        message: 'Index status retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get index status error:', error);
      next(error);
    }
  }

  // Real-time search
  async realtimeSearch(req, res, next) {
    try {
      const { query, type, limit = 20 } = req.query;
      if (!query) {
        throw new AppError('Query is required', 400);
      }
      
      const result = await searchService.realtimeSearch(
        query,
        type,
        req.user.id,
        parseInt(limit)
      );
      res.status(200).json({
        success: true,
        message: 'Real-time search completed',
        data: result
      });
    } catch (error) {
      logger.error('Realtime search error:', error);
      next(error);
    }
  }

  // Voice search
  async voiceSearch(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('Audio file is required', 400);
      }
      
      const { language = 'en-US' } = req.body;
      const result = await searchService.voiceSearch(req.file, language, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Voice search completed',
        data: result
      });
    } catch (error) {
      logger.error('Voice search error:', error);
      next(error);
    }
  }

  // Image search
  async imageSearch(req, res, next) {
    try {
      if (!req.file) {
        throw new AppError('Image file is required', 400);
      }
      
      const { similarity = 0.8, limit = 20 } = req.body;
      const result = await searchService.imageSearch(
        req.file,
        parseFloat(similarity),
        req.user.id,
        parseInt(limit)
      );
      res.status(200).json({
        success: true,
        message: 'Image search completed',
        data: result
      });
    } catch (error) {
      logger.error('Image search error:', error);
      next(error);
    }
  }

  // Search sharing
  async shareSearch(req, res, next) {
    try {
      const { searchResults, recipients, message, expiresAt } = req.body;
      if (!searchResults || !recipients) {
        throw new AppError('Search results and recipients are required', 400);
      }
      
      const result = await searchService.shareSearch(
        searchResults,
        recipients,
        req.user.id,
        message,
        expiresAt
      );
      res.status(201).json({
        success: true,
        message: 'Search shared successfully',
        data: result
      });
    } catch (error) {
      logger.error('Share search error:', error);
      next(error);
    }
  }

  async getSharedSearch(req, res, next) {
    try {
      const { shareId } = req.params;
      const result = await searchService.getSharedSearch(shareId, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Shared search retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get shared search error:', error);
      next(error);
    }
  }

  // Search export
  async exportSearchResults(req, res, next) {
    try {
      const { searchResults, format = 'json', includeMetadata = true } = req.body;
      if (!searchResults) {
        throw new AppError('Search results are required', 400);
      }
      
      const result = await searchService.exportSearchResults(
        searchResults,
        format,
        includeMetadata,
        req.user.id
      );
      
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=search_results_${new Date().toISOString().split('T')[0]}.csv`);
        return res.send(result);
      } else if (format === 'json') {
        res.status(200).json({
          success: true,
          message: 'Search results exported successfully',
          data: result
        });
      } else {
        throw new AppError('Unsupported export format', 400);
      }
    } catch (error) {
      logger.error('Export search results error:', error);
      next(error);
    }
  }

  // Search notifications
  async setupSearchNotification(req, res, next) {
    try {
      const { query, frequency, type, notifyVia = 'in-app' } = req.body;
      if (!query || !frequency) {
        throw new AppError('Query and frequency are required', 400);
      }
      
      const result = await searchService.setupSearchNotification(
        query,
        frequency,
        type,
        req.user.id,
        notifyVia
      );
      res.status(201).json({
        success: true,
        message: 'Search notification setup successfully',
        data: result
      });
    } catch (error) {
      logger.error('Setup search notification error:', error);
      next(error);
    }
  }

  async getSearchNotifications(req, res, next) {
    try {
      const { status = 'active' } = req.query;
      const result = await searchService.getSearchNotifications(req.user.id, status);
      res.status(200).json({
        success: true,
        message: 'Search notifications retrieved',
        data: result
      });
    } catch (error) {
      logger.error('Get search notifications error:', error);
      next(error);
    }
  }

  async deleteSearchNotification(req, res, next) {
    try {
      const { notificationId } = req.params;
      await searchService.deleteSearchNotification(notificationId, req.user.id);
      res.status(200).json({
        success: true,
        message: 'Search notification deleted successfully'
      });
    } catch (error) {
      logger.error('Delete search notification error:', error);
      next(error);
    }
  }
}

module.exports = new SearchController();